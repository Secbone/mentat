import { join } from "node:path";
import type { Decision, Trigger } from "@mentat/domain";
import { buildOverview } from "@mentat/panel";
import { FileSourceState, GhCliGitHubApi, GitHubSource } from "@mentat/source-github";
import type { RouterAgentPort, RuntimeReceipt } from "./runtime";
import type { MentatService } from "./service";
import { createMentatService } from "./service";

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

export interface MentatConfig {
  dir?: string;
  model?: string;
  github?: { repo: string; agent: string; intervalMs?: number };
}

export const name = "mentat";
export const inject = ["tools", "agents"];

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
    ...(config.model ? { model: config.model } : {}),
    ...(source ? { source } : {}),
    ...(github?.intervalMs !== undefined ? { pollIntervalMs: github.intervalMs } : {}),
    onPollError: (error) => {
      if (process.env.MENTAT_DEBUG) console.error(`[mentat] source poll failed: ${String(error)}`);
    },
  });
  ctx.provide("mentat", service);
  if (process.env.MENTAT_DEBUG) console.error("[mentat] plugin loaded");
  service.poller?.start();
  const stopPoller = () => service.poller?.stop();
  if (ctx.effect) ctx.effect(() => stopPoller);

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
