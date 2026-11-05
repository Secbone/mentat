import { describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { defaultAdmissionRow } from "./policy";
import { InMemoryRepositories } from "./repositories";
import { ticketStage } from "./stage";
import type { EffectPort, Policy, Report, Trigger } from "./types";

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    acceptMode: "auto",
    rules: [{ id: "bug", name: "Bug", instruction: "Fix reported bugs", enabled: true }],
    sources: {
      github: { allowed: ["alice"], bots: ["dependabot"], admission: defaultAdmissionRow() },
    },
    ...overrides,
  };
}

function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: "github",
    thread: "thread-1",
    actor: "alice",
    bot: false,
    addressed: "mention",
    text: "fix the bug",
    at: "2026-11-05T00:00:00.000Z",
    meta: { scope: "issue" },
    ...overrides,
  };
}

function setup(initial: Policy = policy(), effects?: EffectPort) {
  const repos = new InMemoryRepositories();
  let current = initial;
  let now = new Date("2026-11-05T00:00:00.000Z");
  const engine = new Engine({
    repos,
    policy: () => current,
    now: () => now,
    evalTimeoutMs: 1000,
    ...(effects ? { effects } : {}),
  });
  return {
    repos,
    engine,
    setPolicy(next: Policy) {
      current = next;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function candidate(engine: Engine, id: string) {
  const view = engine.candidate(id);
  if (!view) throw new Error(`no candidate for ${id}`);
  return view;
}

function accepted() {
  const ctx = setup();
  ctx.engine.receive(trigger("t1"));
  ctx.engine.evaluateDue();
  ctx.engine.candidateDelivered(candidate(ctx.engine, "t1").eval.id);
  const decision = ctx.engine.decide("t1", "accept");
  const ticket = ctx.repos.tickets.list()[0];
  if (!ticket) throw new Error("no ticket");
  return { ...ctx, decision, ticket };
}

describe("Engine", () => {
  it("stores a Trigger once", () => {
    const { engine } = setup();
    expect(engine.receive(trigger("t1"))).toBe("stored");
    expect(engine.receive(trigger("t1"))).toBe("duplicate");
  });

  it("accepts a Trigger into a Ticket, Mandate and Assignment", () => {
    const { repos, decision, ticket } = accepted();
    expect(decision.outcome).toBe("accept");
    expect(repos.mandates.get(ticket.mandate)?.strength).toBe("explicit");
    const assignmentId = ticket.assignments[0];
    const assignment = assignmentId ? repos.assignments.get(assignmentId) : undefined;
    expect(assignment?.state).toBe("pending");
    expect(repos.threads.get("thread-1")?.subscriptions).toContain(ticket.id);
    expect(ticketStage({ assignment: assignment?.state })).toBe("working/queued");
  });

  it("fans a subscribed Trigger out to the Ticket instead of a new Eval", () => {
    const { repos, engine, ticket } = accepted();
    expect(engine.receive(trigger("t2"))).toBe("stored");
    expect(repos.tickets.get(ticket.id)?.inputs).toHaveLength(1);
    expect(repos.threads.get("thread-1")?.pending).toEqual([]);
    expect(repos.threads.get("thread-1")?.activeEval).toBeUndefined();
  });

  it("ignores a Trigger without creating a Ticket", () => {
    const { repos, engine } = setup();
    engine.receive(trigger("t1"));
    engine.evaluateDue();
    engine.decide("t1", "ignore", [{ code: "said" }]);
    expect(repos.decisions.list()[0]?.outcome).toBe("ignore");
    expect(repos.tickets.list()).toHaveLength(0);
  });

  it("records an unadmitted Trigger as ignore without starting an Eval", () => {
    const { repos, engine } = setup();
    engine.receive(trigger("t1", { actor: "mallory" }));
    engine.evaluateDue();
    expect(repos.decisions.list()[0]).toMatchObject({
      outcome: "ignore",
      reasons: [{ code: "not_admitted" }],
    });
    expect(repos.threads.get("thread-1")?.activeEval).toBeUndefined();
  });

  it("requeues an expired Eval twice, then records unavailable", () => {
    const ctx = setup();
    ctx.engine.receive(trigger("t1"));
    ctx.engine.evaluateDue();
    ctx.engine.candidateDelivered(candidate(ctx.engine, "t1").eval.id);
    ctx.advance(2000);
    ctx.engine.evaluateDue();
    expect(ctx.repos.threads.get("thread-1")?.expired).toBe(1);
    ctx.engine.evaluateDue();
    ctx.engine.candidateDelivered(candidate(ctx.engine, "t1").eval.id);
    ctx.advance(2000);
    ctx.engine.evaluateDue();
    expect(ctx.repos.threads.get("thread-1")?.expired).toBe(2);
    ctx.engine.evaluateDue();
    ctx.engine.candidateDelivered(candidate(ctx.engine, "t1").eval.id);
    ctx.advance(2000);
    ctx.engine.evaluateDue();
    expect(ctx.repos.decisions.list().at(-1)?.outcome).toBe("unavailable");
  });

  it("reports attention, stops a Ticket, and retries a failed Assignment", () => {
    const { engine, repos, ticket } = accepted();
    const report: Report = {
      kind: "blocked",
      summary: "need a decision",
      question: "which branch?",
      at: "2026-11-05T00:01:00.000Z",
    };
    engine.report(ticket.id, report);
    expect(repos.tickets.get(ticket.id)?.attention?.question).toBe("which branch?");
    expect(
      ticketStage({
        attention: true,
        latestReport: "blocked",
        assignment: "running",
      }),
    ).toBe("person/answer");

    engine.report(ticket.id, {
      kind: "failed",
      summary: "tests failed",
      at: "2026-11-05T00:02:00.000Z",
    });
    expect(ticketStage({ latestReport: "failed", assignment: "running" })).toBe("person/failed");
    const retry = engine.retryTicket(ticket.id);
    expect(retry.state).toBe("pending");
    expect(repos.tickets.get(ticket.id)?.attention).toBeUndefined();

    engine.stopTicket(ticket.id);
    expect(repos.tickets.get(ticket.id)?.outcome).toBe("stopped");
    expect(repos.mandates.get(ticket.mandate)?.withdrawnAt).toBeDefined();
  });

  it("routes an attached Trigger to the Ticket and ends its Eval", () => {
    const { engine, repos, ticket } = accepted();
    engine.receive(trigger("t2", { thread: "thread-2" }));
    engine.evaluateDue();
    expect(repos.threads.get("thread-2")?.activeEval).toBeDefined();
    engine.attach(ticket.id, "t2", "see this");
    expect(repos.threads.get("thread-2")?.activeEval).toBeUndefined();
    expect(repos.tickets.get(ticket.id)?.inputs.length).toBe(2);
    expect(repos.decisions.list().at(-1)?.reasons[0]?.code).toBe("routed");
  });

  it("withdraws a Mandate when a Policy change fails revalidation", () => {
    const ctx = accepted();
    const stricter = policy({ version: 2 });
    const github = stricter.sources.github;
    if (!github) throw new Error("missing github policy");
    stricter.sources.github = { ...github, allowed: [] };
    ctx.setPolicy(stricter);
    ctx.engine.policyChanged();
    expect(ctx.repos.mandates.get(ctx.ticket.mandate)?.withdrawnAt).toBeDefined();
  });

  it("enqueues launch, notice and reply effects", () => {
    const effects: Array<{ kind: string; key: string; payload: unknown }> = [];
    const ctx = setup(policy(), {
      enqueue(kind, key, payload) {
        effects.push({ kind, key, payload });
      },
    });
    ctx.engine.receive(trigger("t1"));
    ctx.engine.evaluateDue();
    ctx.engine.candidateDelivered(candidate(ctx.engine, "t1").eval.id);
    ctx.engine.decide("t1", "accept");
    expect(effects[0]).toMatchObject({ kind: "launch" });

    ctx.engine.reply({
      id: "reply-1",
      channel: "github:1",
      purpose: "answer",
      text: "done",
      at: "2026-11-05T00:00:00.000Z",
    });
    expect(effects.at(-1)).toMatchObject({ kind: "reply", key: "reply-1" });

    const ticket = ctx.repos.tickets.list()[0];
    if (!ticket) throw new Error("no ticket");
    ctx.engine.report(ticket.id, {
      kind: "blocked",
      summary: "need input",
      question: "which branch?",
      at: "2026-11-05T00:01:00.000Z",
    });
    expect(effects.at(-1)).toMatchObject({ kind: "notice", key: ticket.id });
  });

  it("unsubscribes every Ticket from a Thread", () => {
    const { engine, repos } = accepted();
    engine.unsubscribe("thread-1");
    expect(repos.threads.get("thread-1")?.subscriptions).toEqual([]);
  });
});
