import type { AdapterDeps, AgentEvent, HarnessAdapter, SessionHandle } from "@mentat/core";
import { closeSession, runTurn, type TurnResult } from "@mentat/session";
import type {
  WorkerAdapter,
  WorkerCapabilities,
  WorkerEvent,
  WorkerReport,
  WorkerSession,
  WorkerTask,
} from "./contract";

export interface HarnessWorkerOptions {
  deps?: AdapterDeps;
  timeoutMs?: number;
}

/** Map a settled turn to the structured Report a Ticket stores. */
export function reportFromTurn(result: TurnResult): WorkerReport {
  const text = result.text.trim();
  if (result.reason === "done")
    return { kind: "ready", summary: text.slice(0, 500) || "worker finished", text };
  if (result.reason === "error")
    return { kind: "failed", summary: result.error ?? "worker error", text };
  if (result.reason === "length")
    return { kind: "blocked", summary: "worker reached its step limit", text };
  if (result.termination?.cause === "timeout")
    return { kind: "blocked", summary: "worker timed out", text };
  return { kind: "waiting", summary: "worker aborted", text };
}

function mapEvent(event: AgentEvent, at: string): WorkerEvent | undefined {
  switch (event.type) {
    case "message.delta":
      return { type: "message", at, text: event.text };
    case "tool.start":
      return { type: "tool.start", at, name: event.name, input: event.input };
    case "tool.result":
      return { type: "tool.result", at, ok: !event.isError };
    case "usage":
      return {
        type: "usage",
        at,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        ...(event.usage.costUsd !== undefined ? { costUsd: event.usage.costUsd } : {}),
      };
    case "run.settled":
      return {
        type: "settled",
        at,
        reason: event.reason,
        ...(event.error ? { error: event.error } : {}),
      };
    default:
      return undefined;
  }
}

class EventQueue implements AsyncIterable<WorkerEvent> {
  private readonly values: WorkerEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<WorkerEvent>) => void> = [];
  private closed = false;

  push(event: WorkerEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<WorkerEvent>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

class HarnessSession implements WorkerSession {
  readonly id: string;
  private readonly queue = new EventQueue();
  private readonly turn: Promise<TurnResult>;
  private readonly session: SessionHandle;

  constructor(session: SessionHandle, task: WorkerTask, options: HarnessWorkerOptions) {
    this.session = session;
    this.id = session.id;
    this.turn = runTurn(
      session,
      { text: task.prompt },
      {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.deps?.onDiagnostic ? { onDiagnostic: options.deps.onDiagnostic } : {}),
        onEvent: (event) => {
          const mapped = mapEvent(event, new Date().toISOString());
          if (mapped) this.queue.push(mapped);
        },
      },
    );
    void this.turn.finally(() => this.queue.close());
  }

  async send(_text: string): Promise<void> {
    throw new Error("this worker session runs one turn per assignment");
  }

  events(): AsyncIterable<WorkerEvent> {
    return this.queue;
  }

  async cancel(): Promise<void> {
    await this.session.interrupt();
  }

  async report(): Promise<WorkerReport> {
    return reportFromTurn(await this.turn);
  }

  async dispose(): Promise<void> {
    await closeSession(this.session);
  }
}

/**
 * Adapts an existing Mentat harness (Pi, OpenCode/ACP, fake) to the Worker
 * contract. One spawn is one turn; multi-turn steering lands with the DSH
 * adapter.
 */
export class HarnessWorker implements WorkerAdapter {
  readonly id: string;
  private readonly adapter: HarnessAdapter;
  private readonly options: HarnessWorkerOptions;

  constructor(adapter: HarnessAdapter, options: HarnessWorkerOptions = {}) {
    this.adapter = adapter;
    this.id = adapter.id;
    this.options = options;
  }

  capabilities(): WorkerCapabilities {
    const caps = this.adapter.capabilities();
    return {
      promptInjection:
        caps.systemPrompt === "replace" || caps.systemPrompt === "append" ? "system" : "none",
      skills: "none",
      mcp: true,
      permissions: caps.permissions ? "approval" : "none",
      streaming: true,
      costReporting: true,
      steer: caps.steer,
      fork: caps.fork,
    };
  }

  async spawn(task: WorkerTask): Promise<WorkerSession> {
    const pack = task.pack;
    const session = await this.adapter.createSession(
      {
        cwd: task.cwd,
        ...(pack.model ? { model: pack.model } : {}),
        ...(pack.systemPrompt
          ? { systemPrompt: pack.systemPrompt, systemPromptMode: "replace" as const }
          : {}),
        ...(pack.mcpServers ? { mcpServers: pack.mcpServers } : {}),
        ...(pack.executionPolicy ? { executionPolicy: pack.executionPolicy } : {}),
      },
      this.options.deps,
    );
    return new HarnessSession(session, task, this.options);
  }
}
