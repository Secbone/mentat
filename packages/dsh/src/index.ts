import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDataset, validateEpisodePlan, validatePlan } from "@mentat/benchmark";
import type { Decision, Trigger } from "@mentat/domain";
import { createOpenCodeAdapter } from "@mentat/harnesses";
import { packRef } from "@mentat/pack";
import { buildOverview } from "@mentat/panel";
import { FileSourceState, GhCliGitHubApi, GitHubSource } from "@mentat/source-github";
import type { WorkerAdapter } from "@mentat/worker";
import { HarnessWorker } from "@mentat/worker";
import { BenchmarkPackEvaluator } from "./benchmark-evaluator";
import { CommandPackEvaluator } from "./command-evaluator";
import type { RouterAgentPort, RuntimeReceipt } from "./runtime";
import type { MentatService } from "./service";
import { createMentatService } from "./service";
import { workerSubjectFactory } from "./worker-subject";

export type { RuntimeReceipt } from "./runtime";
export type { MentatService } from "./service";

/** The narrow DSH surface this plugin uses; no DSH package is imported. */
export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export interface DshAgentHandle {
  agent: { id: string };
  dispose(): Promise<void>;
}

export interface DshContext {
  provide(name: string, value: unknown): () => void;
  effect?(setup: () => (() => void) | void): () => void;
  tools: { register(definition: DshToolDefinition): () => void };
  agents?: {
    create(options: {
      sessionId: string;
      meta?: { cwd?: string };
      agentOptions?: { model?: string };
    }): Promise<DshAgentHandle>;
  };
  logger?: { error?(message: string): void };
}

export interface BenchmarkConfig {
  plan: string;
  dataset: string;
  out?: string;
  arms?: string[];
}

export interface MentatConfig {
  dir?: string;
  model?: string;
  github?: { repo: string; agent: string; intervalMs?: number };
  evolve?: { command: string; cwd?: string; timeoutMs?: number };
  benchmark?: BenchmarkConfig;
}

export const name = "mentat";
export const inject = ["tools", "agents"];

function evolveFromEnv(): { command: string; cwd?: string; timeoutMs?: number } | undefined {
  const command = process.env.MENTAT_EVAL_COMMAND;
  if (!command) return undefined;
  const cwd = process.env.MENTAT_EVAL_CWD;
  const timeout = Number(process.env.MENTAT_EVAL_TIMEOUT_MS ?? "");
  return {
    command,
    ...(cwd ? { cwd } : {}),
    ...(Number.isSafeInteger(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}

function evolutionFromEnv(): { intervalMs?: number; maxObservations?: number } {
  const interval = Number(process.env.MENTAT_EVOLVE_INTERVAL_MS ?? "");
  const max = Number(process.env.MENTAT_EVOLVE_MAX_OBSERVATIONS ?? "");
  return {
    ...(Number.isSafeInteger(interval) && interval > 0 ? { intervalMs: interval } : {}),
    ...(Number.isSafeInteger(max) && max > 0 ? { maxObservations: max } : {}),
  };
}

function benchmarkFromEnv(): BenchmarkConfig | undefined {
  const plan = process.env.MENTAT_BENCH_PLAN;
  const dataset = process.env.MENTAT_BENCH_DATASET;
  if (!plan || !dataset) return undefined;
  const out = process.env.MENTAT_BENCH_OUT;
  const arms = process.env.MENTAT_BENCH_ARMS?.split(",")
    .map((arm) => arm.trim())
    .filter(Boolean);
  return {
    plan,
    dataset,
    ...(out ? { out } : {}),
    ...(arms?.length ? { arms } : {}),
  };
}

function benchmarkEvaluator(
  config: BenchmarkConfig,
  worker: WorkerAdapter,
  dir: string,
): BenchmarkPackEvaluator {
  const plan = validatePlan(JSON.parse(readFileSync(config.plan, "utf8")) as unknown);
  const dataset = validateDataset(JSON.parse(readFileSync(config.dataset, "utf8")) as unknown);
  validateEpisodePlan(plan, dataset);
  return new BenchmarkPackEvaluator({
    plan,
    dataset,
    createSubject: workerSubjectFactory({
      worker,
      cwd: dir,
      out: config.out ?? join(dir, "bench"),
    }),
    ...(config.arms ? { arms: config.arms } : {}),
  });
}

function githubFromEnv(): { repo: string; agent: string; intervalMs?: number } | undefined {
  const repo = process.env.MENTAT_GITHUB_REPO;
  const agent = process.env.MENTAT_GITHUB_AGENT;
  if (!repo || !agent) return undefined;
  const interval = Number(process.env.MENTAT_GITHUB_POLL_MS ?? "");
  return {
    repo,
    agent,
    ...(Number.isSafeInteger(interval) && interval > 0 ? { intervalMs: interval } : {}),
  };
}

function text(value: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(value) }];
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

function routerAgents(ctx: DshContext): RouterAgentPort | undefined {
  const agents = ctx.agents;
  if (!agents) return undefined;
  const handles = new Map<string, DshAgentHandle>();
  return {
    async create(options) {
      const handle = await agents.create({
        sessionId: options.sessionId,
        meta: { cwd: options.cwd },
        ...(options.model ? { agentOptions: { model: options.model } } : {}),
      });
      handles.set(handle.agent.id, handle);
      return { sessionId: handle.agent.id };
    },
    async dispose(sessionId) {
      const handle = handles.get(sessionId);
      handles.delete(sessionId);
      await handle?.dispose();
    },
  };
}

/** Mount the Mentat control plane, its Router session and its tools into DSH. */
export function apply(ctx: DshContext, config: MentatConfig = {}): void {
  const dir =
    config.dir ?? process.env.MENTAT_STATE_DIR ?? join(process.cwd(), ".mentat", "superagent");
  const agents = routerAgents(ctx);
  const github = config.github ?? githubFromEnv();
  const evolve = config.evolve ?? evolveFromEnv();
  const benchmark = config.benchmark ?? benchmarkFromEnv();
  const evolution = evolutionFromEnv();
  const worker =
    process.env.MENTAT_WORKER === "opencode"
      ? new HarnessWorker(createOpenCodeAdapter({ binary: "opencode" }), { timeoutMs: 120_000 })
      : undefined;
  let evaluator: BenchmarkPackEvaluator | CommandPackEvaluator | undefined;
  if (benchmark) {
    if (!worker) throw new Error("benchmark evaluation requires MENTAT_WORKER=opencode");
    evaluator = benchmarkEvaluator(benchmark, worker, dir);
  } else if (evolve) {
    evaluator = new CommandPackEvaluator({
      shell: evolve.command,
      cwd: evolve.cwd ?? dir,
      ...(evolve.timeoutMs !== undefined ? { timeoutMs: evolve.timeoutMs } : {}),
    });
  }
  const source = github
    ? new GitHubSource({
        api: new GhCliGitHubApi(),
        state: new FileSourceState(join(dir, "github-state.json")),
        repo: github.repo,
        agentLogin: github.agent,
      })
    : undefined;
  const service: MentatService = createMentatService({
    dir,
    ...(agents ? { agents } : {}),
    ...(worker ? { worker } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(source ? { source } : {}),
    ...(evaluator ? { evaluator } : {}),
    ...(github?.intervalMs !== undefined ? { pollIntervalMs: github.intervalMs } : {}),
    ...(evolution.intervalMs !== undefined ? { evolveIntervalMs: evolution.intervalMs } : {}),
    ...(evolution.maxObservations !== undefined
      ? { maxObservations: evolution.maxObservations }
      : {}),
    onPollError: (error) => {
      if (process.env.MENTAT_DEBUG) console.error(`[mentat] source poll failed: ${String(error)}`);
    },
    onEvolveError: (error) => {
      if (process.env.MENTAT_DEBUG) console.error(`[mentat] evolution failed: ${String(error)}`);
    },
  });
  ctx.provide("mentat", service);
  if (process.env.MENTAT_DEBUG) console.error("[mentat] plugin loaded");
  service.poller?.start();
  service.evolutionScheduler?.start();
  const stopPoller = () => service.poller?.stop();
  const stopEvolution = () => service.evolutionScheduler?.stop();
  if (ctx.effect)
    ctx.effect(() => {
      stopPoller();
      stopEvolution();
    });

  ctx.tools.register({
    name: "mentat_status",
    description: "Return Mentat's ticket, thread, decision and Router counts.",
    parameters: {},
    output: {
      schema: objectSchema(
        {
          tickets: { type: "number" },
          threads: { type: "number" },
          decisions: { type: "number" },
          router: { type: "string" },
        },
        ["tickets", "threads", "decisions", "router"],
      ),
      render: (_args, value) => text(value),
    },
    async execute() {
      return {
        tickets: service.repos.tickets.list().length,
        threads: service.repos.threads.list().length,
        decisions: service.repos.decisions.list().length,
        router: service.runtime.router ?? "",
      };
    },
  });

  ctx.tools.register({
    name: "mentat_receive",
    description: "Receive a local Trigger, start due Evals and run due effects.",
    parameters: {
      text: { type: "string", required: true, description: "Request text" },
      thread: { type: "string", description: "Thread id; defaults to local" },
      actor: { type: "string", description: "Sender id; defaults to local-user" },
    },
    output: {
      schema: objectSchema({ stored: { type: "string" }, evals: { type: "number" } }, [
        "stored",
        "evals",
      ]),
      render: (_args, value) => text(value),
    },
    async execute(raw) {
      const args = raw as { text: string; thread?: string; actor?: string };
      const trigger: Trigger = {
        id: `trigger-${crypto.randomUUID()}`,
        source: "local",
        thread: args.thread ?? "local",
        actor: args.actor ?? "local-user",
        bot: false,
        addressed: "mention",
        text: args.text,
        at: new Date().toISOString(),
        meta: { scope: "local" },
      };
      const stored = service.runtime.receive(trigger);
      await service.runtime.evaluate();
      return { stored, evals: service.repos.evals.list().length };
    },
  });

  ctx.tools.register({
    name: "mentat_dispatch",
    description: "Accept one candidate and run its Assignment through the Worker.",
    parameters: {
      trigger: { type: "string", required: true, description: "Trigger id" },
    },
    output: {
      schema: objectSchema(
        { outcome: { type: "string" }, tickets: { type: "array", items: { type: "string" } } },
        ["outcome", "tickets"],
      ),
      render: (_args, value) => text(value),
    },
    async execute(raw) {
      const args = raw as { trigger: string };
      const decision: Decision = await service.runtime.dispatch(args.trigger);
      return {
        outcome: decision.outcome,
        tickets: service.repos.tickets.list().map((ticket) => ticket.id),
      };
    },
  });

  ctx.tools.register({
    name: "mentat_dream",
    description:
      "Turn one observation into a versioned CapabilityPack candidate, evaluate it with the configured evaluator, gate it and archive it.",
    parameters: {
      text: { type: "string", required: true, description: "Observation or lesson text" },
    },
    output: {
      schema: objectSchema(
        {
          accepted: { type: "boolean" },
          candidate: { type: "object" },
          gate: { type: "object" },
          signals: { type: "object" },
        },
        ["accepted", "candidate", "gate", "signals"],
      ),
      render: (_args, value) => text(value),
    },
    async execute(raw) {
      if (!service.dream)
        throw new Error(
          "no pack evaluator is configured (MENTAT_BENCH_PLAN or MENTAT_EVAL_COMMAND)",
        );
      const args = raw as { text: string };
      const result = await service.dream.dream(service.runtime.currentPack, [
        {
          id: `obs-${crypto.randomUUID()}`,
          at: new Date().toISOString(),
          text: args.text,
          kind: "failure",
        },
      ]);
      return {
        accepted: result.accepted,
        candidate: {
          id: result.candidate.id,
          status: result.candidate.status,
          version: result.candidate.pack.version,
          digest: result.candidate.pack.digest,
        },
        gate: result.gate,
        signals: { base: result.baseSignals, candidate: result.candidateSignals },
      };
    },
  });

  ctx.tools.register({
    name: "mentat_evolve",
    description:
      "Collect failed Assignment receipts, then run Dream: propose, evaluate, gate and archive one CapabilityPack candidate.",
    parameters: {},
    output: {
      schema: objectSchema(
        {
          observations: { type: "number" },
          accepted: { type: "boolean" },
          candidate: { type: "object" },
          gate: { type: "object" },
          signals: { type: "object" },
          skipped: { type: "string" },
        },
        ["observations", "accepted"],
      ),
      render: (_args, value) => text(value),
    },
    async execute() {
      if (!service.evolver)
        throw new Error(
          "evolution requires a listable receipt store and a pack evaluator (MENTAT_BENCH_PLAN or MENTAT_EVAL_COMMAND)",
        );
      const outcome = await service.evolver.evolve();
      if (!outcome.result)
        return {
          observations: outcome.observations.length,
          accepted: false,
          skipped: "no failed receipts to learn from",
        };
      return {
        observations: outcome.observations.length,
        accepted: outcome.result.accepted,
        candidate: {
          id: outcome.result.candidate.id,
          status: outcome.result.candidate.status,
          version: outcome.result.candidate.pack.version,
          digest: outcome.result.candidate.pack.digest,
        },
        gate: outcome.result.gate,
        signals: {
          base: outcome.result.baseSignals,
          candidate: outcome.result.candidateSignals,
        },
      };
    },
  });

  ctx.tools.register({
    name: "mentat_channel",
    description:
      "Inspect or change the stable/canary CapabilityPack channel. action=status|canary|promote|rollback; canary requires an accepted candidate id and optional ratio.",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["status", "canary", "promote", "rollback"],
        description: "Channel operation",
      },
      candidate: { type: "string", description: "Accepted candidate id" },
      ratio: { type: "number", description: "Canary ratio from 0 to 1" },
    },
    output: {
      schema: objectSchema(
        {
          stable: { type: "object" },
          canary: { type: "object" },
          canaryRatio: { type: "number" },
        },
        ["stable", "canaryRatio"],
      ),
      render: (_args, value) => text(value),
    },
    async execute(raw) {
      const args = raw as { action: string; candidate?: string; ratio?: number };
      const accepted = (id: string) => {
        const candidate = service.packs.accepted().find((row) => row.id === id);
        if (!candidate) throw new Error(`accepted candidate not found: ${id}`);
        return candidate;
      };
      switch (args.action) {
        case "status":
          break;
        case "canary": {
          if (!args.candidate) throw new Error("canary requires candidate");
          service.packChannel.setCanary(accepted(args.candidate).pack, args.ratio ?? 0.1);
          break;
        }
        case "promote": {
          if (args.candidate) service.packChannel.setStable(accepted(args.candidate).pack);
          else service.packChannel.promote();
          break;
        }
        case "rollback":
          service.packChannel.rollback();
          break;
        default:
          throw new Error(`unknown channel action: ${args.action}`);
      }
      const canary = service.packChannel.canary();
      return {
        stable: packRef(service.packChannel.current()),
        ...(canary ? { canary: packRef(canary) } : {}),
        canaryRatio: service.packChannel.ratio(),
      };
    },
  });

  ctx.tools.register({
    name: "mentat_overview",
    description:
      "Return the panel overview: person-blocked Tickets, open work, assignments and decisions.",
    parameters: {},
    output: {
      schema: objectSchema({ overview: { type: "object" } }, ["overview"]),
      render: (_args, value) => text(value),
    },
    async execute() {
      return {
        overview: buildOverview(service.repos, {
          ...(service.poller ? { source: service.poller.health() } : {}),
          evolution: service.packs.list().map((candidate) => ({
            id: candidate.id,
            status: candidate.status,
            version: candidate.pack.version,
            digest: candidate.pack.digest,
            ...(candidate.reason ? { reason: candidate.reason } : {}),
          })),
        }),
      };
    },
  });

  ctx.tools.register({
    name: "mentat_poll",
    description: "Poll the configured Source now and return how many Triggers arrived.",
    parameters: {},
    output: {
      schema: objectSchema({ polled: { type: "number" } }, ["polled"]),
      render: (_args, value) => text(value),
    },
    async execute() {
      if (!service.poller) return { polled: 0 };
      return { polled: await service.poller.tick() };
    },
  });

  ctx.tools.register({
    name: "mentat_run",
    description: "Receive, evaluate and dispatch one local request end-to-end.",
    parameters: {
      text: { type: "string", required: true, description: "Request text" },
    },
    output: {
      schema: objectSchema(
        {
          outcome: { type: "string" },
          ticket: { type: "string" },
          receipt: { type: "object" },
        },
        ["outcome", "ticket", "receipt"],
      ),
      render: (_args, value) => text(value),
    },
    async execute(raw) {
      const args = raw as { text: string };
      await service.runtime.startRouter();
      const trigger: Trigger = {
        id: `trigger-${crypto.randomUUID()}`,
        source: "local",
        thread: "local",
        actor: "local-user",
        bot: false,
        addressed: "mention",
        text: args.text,
        at: new Date().toISOString(),
        meta: { scope: "local" },
      };
      service.runtime.receive(trigger);
      await service.runtime.evaluate();
      const decision = await service.runtime.dispatch(trigger.id);
      const ticket = service.repos.tickets.list().at(-1);
      const receipt: RuntimeReceipt | undefined = service.runtime.lastReceipt;
      return {
        outcome: decision.outcome,
        ticket: ticket?.id ?? "",
        receipt: receipt ?? {},
      };
    },
  });
}
