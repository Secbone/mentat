import type { JsonValue } from "@mentat/core";
import {
  type Decision,
  Engine,
  type Policy,
  type Repositories,
  type Trigger,
} from "@mentat/domain";
import type { EffectQueue } from "@mentat/effects";
import { type CapabilityPack, defineCapabilityPack, type PackRef, packRef } from "@mentat/pack";
import type { WorkerAdapter, WorkerReport, WorkerTask } from "@mentat/worker";

/** The narrow DSH agent surface the Router uses. */
export interface RouterAgentPort {
  create(options: {
    sessionId: string;
    cwd: string;
    model?: string;
  }): Promise<{ sessionId: string }>;
  dispose?(sessionId: string): Promise<void>;
}

/** One end-to-end Assignment record. */
export interface RuntimeReceipt {
  version: 1;
  at: string;
  routerSession?: string;
  trigger: string;
  ticket: string;
  assignment: string;
  worker: string;
  packDigest: string;
  pack: PackRef;
  report: WorkerReport;
  events: number;
  outcome: "completed" | "error";
  error?: string;
}

export interface ReceiptSink {
  append(receipt: RuntimeReceipt): void;
}

export interface MentatRuntimeOptions {
  repos: Repositories;
  queue: EffectQueue;
  worker: WorkerAdapter;
  receipts: ReceiptSink;
  policy: () => Policy;
  cwd: string;
  agents?: RouterAgentPort;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  pack?: CapabilityPack;
  now?: () => Date;
  id?: (prefix: string) => string;
}

interface LaunchPayload {
  assignment: string;
  ticket: string;
  prompt: string;
}

const DEFAULT_WORKER_PROMPT =
  "You are a Mentat Worker. Complete the assigned ticket, verify the result, and report honestly.";

/**
 * The control-plane runtime: owns the Router session, runs the Engine, and
 * executes `launch` effects through a heterogeneous WorkerAdapter.
 */
export class MentatRuntime {
  readonly engine: Engine;
  private readonly repos: Repositories;
  private readonly queue: EffectQueue;
  private readonly worker: WorkerAdapter;
  private readonly receipts: ReceiptSink;
  private readonly agents?: RouterAgentPort;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly pack: CapabilityPack;
  private readonly clock: () => Date;
  private readonly nextId: (prefix: string) => string;
  private readonly disposeLaunch: () => void;
  private routerSession?: string;
  private receipt?: RuntimeReceipt;

  constructor(options: MentatRuntimeOptions) {
    this.repos = options.repos;
    this.queue = options.queue;
    this.worker = options.worker;
    this.receipts = options.receipts;
    if (options.agents) this.agents = options.agents;
    this.cwd = options.cwd;
    if (options.model) this.model = options.model;
    this.pack =
      options.pack ??
      defineCapabilityPack({
        id: "worker-default",
        version: 1,
        prompt: { system: options.systemPrompt ?? DEFAULT_WORKER_PROMPT, role: "worker" },
        ...(options.model ? { model: { model: options.model } } : {}),
        ...(options.timeoutMs !== undefined
          ? { policy: { budget: { wallMs: options.timeoutMs } } }
          : {}),
      });
    this.clock = options.now ?? (() => new Date());
    this.nextId = options.id ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.engine = new Engine({
      repos: this.repos,
      policy: options.policy,
      ...(options.now ? { now: options.now } : {}),
      ...(options.id ? { id: options.id } : {}),
      effects: {
        enqueue: (kind, key, payload) => this.queue.enqueue(kind, key, payload as JsonValue),
      },
    });
    this.disposeLaunch = this.queue.handle("launch", async (payload) => {
      await this.launch(payload as unknown as LaunchPayload);
    });
  }

  get lastReceipt(): RuntimeReceipt | undefined {
    return this.receipt ? { ...this.receipt } : undefined;
  }

  get router(): string | undefined {
    return this.routerSession;
  }

  /** Start the long-lived Router session. Safe to call once. */
  async startRouter(): Promise<string | undefined> {
    if (this.routerSession) return this.routerSession;
    if (!this.agents) return undefined;
    const sessionId = this.nextId("router");
    const session = await this.agents.create({
      sessionId,
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
    });
    this.routerSession = session.sessionId;
    return this.routerSession;
  }

  receive(trigger: Trigger): "stored" | "duplicate" | "filtered" {
    return this.engine.receive(trigger);
  }

  /** Start due Evals and run every due effect. */
  async evaluate(): Promise<number> {
    this.engine.evaluateDue();
    return this.queue.runDue();
  }

  /** Accept one candidate and run its launch effect to completion. */
  async dispatch(triggerId: string): Promise<Decision> {
    const view = this.engine.candidate(triggerId);
    if (!view) throw new Error("trigger has no candidate");
    this.engine.candidateDelivered(view.eval.id);
    const decision = this.engine.decide(triggerId, "accept", [{ code: "router-accepted" }]);
    if (decision.outcome === "accept") await this.queue.runDue();
    return decision;
  }

  async dispose(): Promise<void> {
    this.disposeLaunch();
    this.queue.stop();
    if (this.routerSession) await this.agents?.dispose?.(this.routerSession);
    this.routerSession = undefined;
  }

  private async launch(payload: LaunchPayload): Promise<void> {
    const assignment = this.repos.assignments.get(payload.assignment);
    const ticket = this.repos.tickets.get(payload.ticket);
    if (!assignment || !ticket) throw new Error("launch target is missing");
    this.engine.assignmentStarted(ticket.id, assignment.id);

    const pack = this.pack;
    const packDigest = pack.digest;
    assignment.packDigest = packDigest;
    this.repos.assignments.save(assignment);

    const task: WorkerTask = {
      assignmentId: assignment.id,
      ticketId: ticket.id,
      cwd: this.cwd,
      prompt: payload.prompt,
      pack,
    };
    let report: WorkerReport;
    let events = 0;
    let outcome: RuntimeReceipt["outcome"] = "completed";
    let error: string | undefined;
    let session: Awaited<ReturnType<WorkerAdapter["spawn"]>> | undefined;
    try {
      session = await this.worker.spawn(task);
      for await (const _event of session.events()) events += 1;
      report = await session.report();
    } catch (cause) {
      outcome = "error";
      error = cause instanceof Error ? cause.message : String(cause);
      report = { kind: "failed", summary: error };
    } finally {
      if (session) await session.dispose();
      assignment.state = "ended";
      assignment.endedAt = this.clock().toISOString();
      this.repos.assignments.save(assignment);
    }

    this.engine.report(ticket.id, {
      kind: report.kind,
      summary: report.summary,
      ...(report.question ? { question: report.question } : {}),
      at: this.clock().toISOString(),
    });
    const receipt: RuntimeReceipt = {
      version: 1,
      at: this.clock().toISOString(),
      ...(this.routerSession ? { routerSession: this.routerSession } : {}),
      trigger: this.triggerOf(ticket.threads[0] ?? ""),
      ticket: ticket.id,
      assignment: assignment.id,
      worker: this.worker.id,
      packDigest,
      pack: packRef(pack),
      report,
      events,
      outcome,
      ...(error ? { error } : {}),
    };
    this.receipt = receipt;
    this.receipts.append(receipt);
  }

  private triggerOf(threadId: string): string {
    const trigger = this.repos.triggers.list().find((candidate) => candidate.thread === threadId);
    return trigger?.id ?? "";
  }
}
