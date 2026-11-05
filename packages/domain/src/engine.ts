import { gate, revalidate } from "./policy";
import type { Repositories } from "./repositories";
import { canRetry, ticketStage } from "./stage";
import type {
  Assignment,
  Decision,
  DecisionOutcome,
  EffectPort,
  Eval,
  Input,
  Mandate,
  Policy,
  Reason,
  ReplyRequest,
  Report,
  Strength,
  Thread,
  Ticket,
  Trigger,
  TriggerFacts,
} from "./types";

export interface EngineOptions {
  repos: Repositories;
  policy: () => Policy;
  now?: () => Date;
  /**
   * ID factory. Production injects UUIDs; the default is process-local so
   * tests and single-process simulations stay deterministic.
   * shortcut: process-local counter, inject a UUID factory for multi-process state.
   */
  id?: (prefix: string) => string;
  evalTimeoutMs?: number;
  effects?: EffectPort;
}

export type ReceiveResult = "stored" | "duplicate" | "filtered";

/** The Eval a Router sees for one Trigger. */
export interface CandidateView {
  eval: Eval;
  thread: Thread;
  triggers: Trigger[];
  policyVersion: number;
}

export type EngineForSources = Pick<Engine, "receive" | "bindThread" | "threadClosed">;
export type EngineForMainSession = Pick<
  Engine,
  "candidate" | "candidateDelivered" | "decide" | "attach" | "requestStatus" | "note" | "reply"
>;
export type EngineForPeople = Pick<
  Engine,
  "stopTicket" | "retryTicket" | "reevaluate" | "unsubscribe" | "dismiss"
>;
export type EngineForExecutor = Pick<
  Engine,
  "assignmentStarted" | "inputsDelivered" | "inputsRead" | "turnEnded" | "deliveryFailed" | "report"
>;

/**
 * The single writer of Triggers, Threads, Evals, Decisions, Tickets and
 * Assignments. Every command is synchronous; external work is queued through
 * the outbox or returned to the caller.
 */
export class Engine {
  private readonly repos: Repositories;
  private readonly policy: () => Policy;
  private readonly clock: () => Date;
  private readonly nextId: (prefix: string) => string;
  private readonly evalTimeoutMs: number;
  private readonly effects?: EffectPort;
  private counter = 0;

  constructor(options: EngineOptions) {
    this.repos = options.repos;
    this.policy = options.policy;
    this.clock = options.now ?? (() => new Date());
    this.nextId =
      options.id ??
      ((prefix) => {
        this.counter += 1;
        return `${prefix}-${this.counter}`;
      });
    this.evalTimeoutMs = options.evalTimeoutMs ?? 15 * 60 * 1000;
    if (options.effects) this.effects = options.effects;
  }

  private at(): string {
    return this.clock().toISOString();
  }

  private facts(trigger: Trigger, thread: Thread): TriggerFacts {
    return {
      source: trigger.source,
      sender: trigger.actor,
      addressed: trigger.addressed,
      bot: trigger.bot,
      followup: thread.subscriptions.length > 0,
      scope: trigger.meta?.scope ?? "",
    };
  }

  private thread(id: string, source: string): Thread {
    const existing = this.repos.threads.get(id);
    if (existing) return existing;
    const thread: Thread = { id, source, triggers: [], pending: [], subscriptions: [] };
    this.repos.threads.save(thread);
    return thread;
  }

  /** A Source's Trigger: stored once, fanned out, and queued for Eval. */
  receive(trigger: Trigger): ReceiveResult {
    if (this.repos.triggers.get(trigger.id)) return "duplicate";
    this.repos.triggers.save(trigger);
    const thread = this.thread(trigger.thread, trigger.source);
    thread.triggers.push(trigger.id);

    let reachedTicket = false;
    for (const ticketId of thread.subscriptions) {
      const ticket = this.repos.tickets.get(ticketId);
      // shortcut: ended Tickets are not resumed here; resume lands with the
      // mandate revalidation path.
      if (!ticket || ticket.endedAt) continue;
      const input: Input = {
        id: this.nextId("input"),
        ticket: ticketId,
        kind: "trigger",
        trigger: trigger.id,
        fromPerson: !trigger.bot,
      };
      this.repos.inputs.save(input);
      ticket.inputs.push(input.id);
      this.repos.tickets.save(ticket);
      if (!trigger.bot) reachedTicket = true;
    }

    if (!reachedTicket) thread.pending.push(trigger.id);
    this.repos.threads.save(thread);
    return "stored";
  }

  /** Start due Evals, requeue expired ones, and record the third expiry. */
  evaluateDue(): void {
    const now = this.clock();
    for (const thread of this.repos.threads.list()) {
      if (thread.activeEval) {
        const active = this.repos.evals.get(thread.activeEval);
        if (!active) {
          thread.activeEval = undefined;
          this.repos.threads.save(thread);
          continue;
        }
        if (!active.deliveredAt) continue;
        if (now.getTime() < Date.parse(active.deadlineAt)) continue;
        thread.expired = (thread.expired ?? 0) + 1;
        if (thread.expired < 3) {
          thread.pending.unshift(...active.triggers);
          thread.activeEval = undefined;
          this.repos.evals.save(active);
          this.repos.threads.save(thread);
        } else {
          this.finishEval(active, thread, "unavailable", [{ code: "timeout" }]);
        }
        continue;
      }

      if (thread.pending.length === 0) continue;
      const triggers = thread.pending
        .map((id) => this.repos.triggers.get(id))
        .filter((trigger): trigger is Trigger => trigger !== undefined);
      thread.pending = [];
      const policy = this.policy();
      const admitted = triggers.filter(
        (trigger) => gate(policy, this.facts(trigger, thread)).strength !== "not_admitted",
      );
      const evaluation: Eval = {
        id: this.nextId("eval"),
        thread: thread.id,
        triggers: (admitted.length > 0 ? admitted : triggers).map((trigger) => trigger.id),
        policyVersion: policy.version,
        startedAt: now.toISOString(),
        deadlineAt: now.toISOString(),
      };
      this.repos.evals.save(evaluation);
      if (admitted.length === 0) {
        this.finishEval(evaluation, thread, "ignore", [{ code: "not_admitted" }]);
        continue;
      }
      thread.activeEval = evaluation.id;
      this.repos.threads.save(thread);
    }
  }

  private finishEval(
    evaluation: Eval,
    thread: Thread,
    outcome: DecisionOutcome,
    reasons: Reason[],
  ): Decision {
    const existing = this.repos.decisions.list().find((item) => item.eval === evaluation.id);
    if (existing) {
      thread.activeEval = undefined;
      this.repos.threads.save(thread);
      return existing;
    }
    const trigger = this.repos.triggers.get(evaluation.triggers[0] ?? "");
    const policy = this.policy();
    const strength: Strength = trigger
      ? gate(policy, this.facts(trigger, thread)).strength
      : "not_admitted";
    const decision: Decision = {
      id: this.nextId("decision"),
      eval: evaluation.id,
      outcome,
      strength,
      reasons,
      at: this.at(),
    };
    this.repos.decisions.save(decision);
    thread.activeEval = undefined;
    thread.expired = 0;
    this.repos.threads.save(thread);
    return decision;
  }

  candidate(triggerId: string): CandidateView | undefined {
    const thread = this.repos.threads.list().find((item) => item.triggers.includes(triggerId));
    const active = thread?.activeEval ? this.repos.evals.get(thread.activeEval) : undefined;
    const evaluation = active?.triggers.includes(triggerId)
      ? active
      : this.repos.evals
          .list()
          .filter((item) => item.triggers.includes(triggerId))
          .at(-1);
    if (!evaluation) return undefined;
    const evaluationThread = this.repos.threads.get(evaluation.thread);
    if (!evaluationThread) return undefined;
    return {
      eval: evaluation,
      thread: evaluationThread,
      triggers: evaluation.triggers
        .map((id) => this.repos.triggers.get(id))
        .filter((trigger): trigger is Trigger => trigger !== undefined),
      policyVersion: evaluation.policyVersion,
    };
  }

  /** The candidate reached the Router; its deadline starts now. */
  candidateDelivered(evalId: string): void {
    const evaluation = this.repos.evals.get(evalId);
    if (!evaluation) throw new Error("eval not found");
    evaluation.deliveredAt = this.at();
    evaluation.deadlineAt = new Date(this.clock().getTime() + this.evalTimeoutMs).toISOString();
    this.repos.evals.save(evaluation);
  }

  decide(triggerId: string, outcome: DecisionOutcome, reasons: Reason[] = []): Decision {
    const view = this.candidate(triggerId);
    if (!view) throw new Error("trigger has no eval");
    const existing = this.repos.decisions.list().find((item) => item.eval === view.eval.id);
    if (existing) return existing;

    const decision = this.finishEval(view.eval, view.thread, outcome, reasons);
    if (outcome !== "accept") return decision;
    // shortcut: the accepted rule set is every enabled rule until the
    // assessment reports the matched subset.

    const policy = this.policy();
    const trigger = view.triggers[0];
    if (!trigger) throw new Error("eval has no trigger");
    const gateDecision = gate(policy, this.facts(trigger, view.thread));
    const ticketId = this.nextId("ticket");
    const mandate: Mandate = {
      id: this.nextId("mandate"),
      ticket: ticketId,
      policyVersion: policy.version,
      strength: gateDecision.strength,
      scope: gateDecision.basis.scope ?? "",
      basis: gateDecision.basis,
      matchedRules: policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id),
      createdAt: this.at(),
    };
    const assignment: Assignment = {
      id: this.nextId("assignment"),
      ticket: ticketId,
      worker: "unassigned",
      workspace: "",
      packDigest: "",
      state: "pending",
    };
    const ticket: Ticket = {
      id: ticketId,
      mandate: mandate.id,
      source: trigger.source,
      threads: [view.thread.id],
      subscriptions: [view.thread.id],
      channels: [],
      inputs: [],
      assignments: [assignment.id],
      openedAt: this.at(),
    };
    this.repos.mandates.save(mandate);
    this.repos.assignments.save(assignment);
    this.repos.tickets.save(ticket);
    view.thread.subscriptions.push(ticketId);
    this.repos.threads.save(view.thread);
    this.effects?.enqueue("launch", assignment.id, {
      assignment: assignment.id,
      ticket: ticketId,
    });
    return decision;
  }

  bindThread(ticketId: string, threadId: string, own = false): void {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    if (!ticket.threads.includes(threadId)) ticket.threads.push(threadId);
    if (!ticket.subscriptions.includes(threadId)) ticket.subscriptions.push(threadId);
    const thread = this.thread(threadId, ticket.source);
    if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId);
    this.repos.threads.save(thread);
    this.repos.tickets.save(ticket);
    void own;
  }

  threadClosed(threadId: string, outcome: Ticket["outcome"], at: string): void {
    // shortcut: every Ticket on the Thread ends; pull-request completion rules
    // arrive with the GitHub Source.
    const thread = this.repos.threads.get(threadId);
    if (!thread) return;
    for (const ticketId of thread.subscriptions) {
      const ticket = this.repos.tickets.get(ticketId);
      // shortcut: ended Tickets are not resumed here; resume lands with the
      // mandate revalidation path.
      if (!ticket || ticket.endedAt) continue;
      ticket.endedAt = at;
      ticket.outcome = outcome;
      this.repos.tickets.save(ticket);
    }
  }

  assignmentStarted(ticketId: string, assignmentId: string): void {
    const assignment = this.repos.assignments.get(assignmentId);
    const ticket = this.repos.tickets.get(ticketId);
    if (!assignment || !ticket) throw new Error("assignment or ticket not found");
    assignment.state = "running";
    assignment.startedAt = this.at();
    this.repos.assignments.save(assignment);
  }

  inputsDelivered(ticketId: string, _assignmentId: string, inputIds: string[]): void {
    const at = this.at();
    for (const id of inputIds) {
      const input = this.repos.inputs.get(id);
      if (!input || input.ticket !== ticketId) continue;
      input.deliveredAt = at;
      this.repos.inputs.save(input);
    }
    const ticket = this.repos.tickets.get(ticketId);
    if (ticket) {
      delete ticket.delivery;
      this.repos.tickets.save(ticket);
    }
  }

  inputsRead(ticketId: string, inputIds: string[]): void {
    const at = this.at();
    for (const id of inputIds) {
      const input = this.repos.inputs.get(id);
      if (!input || input.ticket !== ticketId) continue;
      input.readAt = at;
      this.repos.inputs.save(input);
    }
  }

  turnEnded(ticketId: string, _assignmentId: string): void {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket || ticket.endedAt || ticket.attention) return;
    if (ticket.latestReport !== "ready") {
      ticket.latestReport = "waiting";
      this.repos.tickets.save(ticket);
    }
  }

  deliveryFailed(ticketId: string, _assignmentId: string, error: string): void {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    ticket.delivery = { error, at: this.at() };
    this.repos.tickets.save(ticket);
  }

  report(ticketId: string, report: Report): void {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    ticket.latestReport = report.kind;
    if (report.question) {
      ticket.attention = { question: report.question, at: report.at };
      this.effects?.enqueue("notice", ticketId, {
        ticket: ticketId,
        question: report.question,
      });
    } else delete ticket.attention;
    if (report.kind === "dropped") {
      ticket.endedAt = report.at;
      ticket.outcome = "dropped";
    }
    this.repos.tickets.save(ticket);
  }

  stopTicket(ticketId: string, reason = "stopped by a person"): void {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    const mandate = this.repos.mandates.get(ticket.mandate);
    if (mandate) {
      mandate.withdrawnAt = this.at();
      this.repos.mandates.save(mandate);
    }
    ticket.endedAt = this.at();
    ticket.outcome = "stopped";
    delete ticket.attention;
    this.repos.tickets.save(ticket);
    void reason;
  }

  retryTicket(ticketId: string): Assignment {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    const stage = ticketStage({
      deliveryFailed: ticket.delivery !== undefined,
      attention: ticket.attention !== undefined,
      latestReport: ticket.latestReport,
      humanMessageSinceLatestReport: false,
      assignment: ticket.assignments.length
        ? this.repos.assignments.get(ticket.assignments[ticket.assignments.length - 1] ?? "")?.state
        : undefined,
    });
    if (!canRetry(stage)) throw new Error(`ticket cannot retry from ${stage}`);
    const assignment: Assignment = {
      id: this.nextId("assignment"),
      ticket: ticketId,
      worker: "unassigned",
      workspace: "",
      packDigest: "",
      state: "pending",
    };
    this.repos.assignments.save(assignment);
    ticket.assignments.push(assignment.id);
    delete ticket.delivery;
    delete ticket.attention;
    this.repos.tickets.save(ticket);
    return assignment;
  }

  note(ticketId: string, text: string): Input {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) throw new Error("ticket not found");
    const input: Input = {
      id: this.nextId("input"),
      ticket: ticketId,
      kind: "text",
      text,
      fromPerson: false,
    };
    this.repos.inputs.save(input);
    ticket.inputs.push(input.id);
    this.repos.tickets.save(ticket);
    return input;
  }

  attach(ticketId: string, triggerId: string, note?: string): void {
    const ticket = this.repos.tickets.get(ticketId);
    const trigger = this.repos.triggers.get(triggerId);
    if (!ticket || !trigger) throw new Error("ticket or trigger not found");
    const view = this.candidate(triggerId);
    if (view) this.finishEval(view.eval, view.thread, "ignore", [{ code: "routed" }]);
    const input: Input = {
      id: this.nextId("input"),
      ticket: ticketId,
      kind: "trigger",
      trigger: triggerId,
      fromPerson: !trigger.bot,
    };
    this.repos.inputs.save(input);
    ticket.inputs.push(input.id);
    if (!ticket.threads.includes(trigger.thread)) ticket.threads.push(trigger.thread);
    if (!ticket.subscriptions.includes(trigger.thread)) ticket.subscriptions.push(trigger.thread);
    this.repos.tickets.save(ticket);
    const thread = this.repos.threads.get(trigger.thread);
    if (thread) {
      thread.pending = thread.pending.filter((id) => id !== triggerId);
      if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId);
      this.repos.threads.save(thread);
    }
    if (note) this.note(ticketId, note);
  }

  reply(request: ReplyRequest): void {
    this.repos.replies.save(request);
    this.effects?.enqueue("reply", request.id, { reply: request.id });
  }

  unsubscribe(threadId: string): void {
    const thread = this.repos.threads.get(threadId);
    if (!thread) return;
    thread.subscriptions = [];
    this.repos.threads.save(thread);
  }

  dismiss(decisionId: string): void {
    const decision = this.repos.decisions.get(decisionId);
    if (!decision) throw new Error("decision not found");
    decision.dismissedAt = this.at();
    this.repos.decisions.save(decision);
  }

  reevaluate(triggerId: string): void {
    const trigger = this.repos.triggers.get(triggerId);
    if (!trigger) throw new Error("trigger not found");
    const thread = this.thread(trigger.thread, trigger.source);
    if (!thread.pending.includes(triggerId)) thread.pending.push(triggerId);
    this.repos.threads.save(thread);
  }

  requestStatus(ticketId: string): boolean {
    const ticket = this.repos.tickets.get(ticketId);
    if (!ticket) return false;
    return ticket.assignments.some((id) => this.repos.assignments.get(id)?.state === "running");
  }

  /** A Policy change discards running Evals and tells affected live Tickets. */
  policyChanged(): void {
    // shortcut: revalidation uses the first Trigger of the Ticket's source;
    // the full per-Mandate facts are restored with the Source adapters.
    const policy = this.policy();
    for (const thread of this.repos.threads.list()) {
      if (!thread.activeEval) continue;
      const evaluation = this.repos.evals.get(thread.activeEval);
      if (!evaluation) continue;
      thread.pending.unshift(...evaluation.triggers);
      thread.activeEval = undefined;
      this.repos.threads.save(thread);
    }
    for (const ticket of this.repos.tickets.list()) {
      if (ticket.endedAt) continue;
      const mandate = this.repos.mandates.get(ticket.mandate);
      if (!mandate || mandate.policyVersion === policy.version) continue;
      const trigger = this.repos.triggers.list().find((item) => item.source === ticket.source);
      const thread = this.repos.threads.get(ticket.threads[0] ?? "");
      if (!trigger || !thread) continue;
      if (revalidate(policy, mandate, this.facts(trigger, thread), { sourceListens: true }))
        continue;
      mandate.withdrawnAt = this.at();
      this.repos.mandates.save(mandate);
    }
  }
}
