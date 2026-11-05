/**
 * Pure Super-agent domain types. They describe authorization and work state,
 * not transport or storage. See docs/research/mentat-on-dsh-2026-11-05.md.
 */

export type SourceId = string;
export type TriggerId = string;
export type ThreadId = string;
export type EvalId = string;
export type DecisionId = string;
export type TicketId = string;
export type MandateId = string;
export type AssignmentId = string;
export type InputId = string;
export type ChannelId = string;
export type RuleId = string;

/** How strong the basis for starting work is. */
export type Strength = "explicit" | "inferred" | "not_admitted";

/** Whether inferred work may start. */
export type AcceptMode = "off" | "observe" | "auto";

export type DecisionOutcome = "accept" | "stop" | "ignore" | "unavailable";

export type AssignmentState = "pending" | "running" | "ended";

export type ReportKind = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

export type TicketOutcome = "merged" | "closed" | "completed" | "dropped" | "stopped";

export type Addressed = "mention" | "direct" | "none";

/** One immutable event from a Source. */
export interface Trigger {
  id: TriggerId;
  source: SourceId;
  thread: ThreadId;
  actor: string;
  bot: boolean;
  addressed: Addressed;
  text: string;
  /** RFC 3339 UTC. */
  at: string;
  /** Source-owned metadata; the core never interprets it. */
  meta?: Readonly<Record<string, string>>;
}

/** Triggers in time order; the unit within which one Eval runs at a time. */
export interface Thread {
  id: ThreadId;
  source: SourceId;
  triggers: TriggerId[];
  /** Triggers waiting for the next Eval on this Thread. */
  pending: TriggerId[];
  subscriptions: TicketId[];
  activeEval?: EvalId;
  /** Consecutive Evals that expired without a decision. */
  expired?: number;
}

/** Why an Eval or a Decision reached its result. */
export interface Reason {
  code: string;
  values?: Readonly<Record<string, string | number>>;
  triggerId?: TriggerId;
  text?: string;
}

/** The judgement on a batch of Triggers. */
export interface Eval {
  id: EvalId;
  thread: ThreadId;
  triggers: TriggerId[];
  policyVersion: number;
  startedAt: string;
  /** Starts counting when the candidate reaches the Router. */
  deadlineAt: string;
  deliveredAt?: string;
}

export interface Decision {
  id: DecisionId;
  eval: EvalId;
  outcome: DecisionOutcome;
  strength: Strength;
  reasons: Reason[];
  at: string;
  dismissedAt?: string;
}

/** Why work may be done, how far, and under which Policy version. */
export interface MandateBasis {
  via: "addressed" | "followup" | "admission" | "bot";
  source: SourceId;
  sender: string;
  scope?: string;
}

export interface Mandate {
  id: MandateId;
  ticket: TicketId;
  policyVersion: number;
  strength: Strength;
  scope: string;
  basis: MandateBasis;
  matchedRules: RuleId[];
  createdAt: string;
  withdrawnAt?: string;
}

/** A unit of authorized work. Its state never follows a Worker session. */
export interface Ticket {
  id: TicketId;
  mandate: MandateId;
  source: SourceId;
  threads: ThreadId[];
  subscriptions: ThreadId[];
  channels: ChannelId[];
  inputs: InputId[];
  assignments: AssignmentId[];
  openedAt: string;
  endedAt?: string;
  outcome?: TicketOutcome;
  latestReport?: ReportKind;
  attention?: { question: string; at: string };
  delivery?: { error: string; at: string };
}

/** The binding of a Ticket to one Worker instance. */
export interface Assignment {
  id: AssignmentId;
  ticket: TicketId;
  worker: string;
  workspace: string;
  /** Digest of the Capability Pack the Worker received. */
  packDigest: string;
  state: AssignmentState;
  startedAt?: string;
  endedAt?: string;
}

/** Context delivered to a Ticket. */
export interface Input {
  id: InputId;
  ticket: TicketId;
  kind: "trigger" | "policy" | "resume" | "text";
  text?: string;
  trigger?: TriggerId;
  deliveredAt?: string;
  readAt?: string;
  fromPerson: boolean;
}

/** What an Assignment reports to its Ticket. */
export interface Report {
  kind: ReportKind;
  summary: string;
  /** One concrete question for a person, when the Report needs one. */
  question?: string;
  at: string;
}

/** A Ticket follows a Thread, with or without authority. */
export interface Subscription {
  ticket: TicketId;
  thread: ThreadId;
  /** The Ticket opened the Thread (e.g. its pull request). */
  own: boolean;
  /** Context only: messages do not grant follow-up strength or resume. */
  contextOnly: boolean;
}

/** The write side of a Thread. */
export interface Channel {
  id: ChannelId;
  source: SourceId;
  thread: ThreadId;
  address: string;
}

/** Durable read position and source-owned metadata. */
export interface SourceState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** A stream of events. Implementations own polling and translation. */
export interface SourceKind {
  readonly id: string;
  readonly label: string;
  poll(): Promise<Trigger[]>;
}

/** A port the Engine uses to enqueue durable external work. */
export interface EffectPort {
  enqueue(kind: string, key: string, payload: unknown): void;
}

/** A message the Router asks a Channel to send. */
export interface ReplyRequest {
  id: string;
  purpose: "acknowledgement" | "answer" | "result" | "attention";
  ticket?: TicketId;
  channel: ChannelId;
  text: string;
  at: string;
}

/** One receiving scope's admission table. */
export interface AdmissionRow {
  listedUnaddressed: AdmissionCell;
  unlistedAddressed: AdmissionCell;
  unlistedUnaddressed: AdmissionCell;
}

export type AdmissionCell = "explicit" | "inferred" | "ignore";

export interface PolicyRule {
  id: RuleId;
  name: string;
  instruction: string;
  enabled: boolean;
}

export interface SourcePolicy {
  /** Identities allowed to originate explicit work on this Source. */
  allowed: string[];
  /** Bots whose messages may become inferred candidates. */
  bots: string[];
  admission: AdmissionRow;
}

export interface Policy {
  version: number;
  acceptMode: AcceptMode;
  rules: PolicyRule[];
  sources: Record<SourceId, SourcePolicy>;
}

/** Facts a Source supplies to the gate; the core never parses message text. */
export interface TriggerFacts {
  source: SourceId;
  sender: string;
  addressed: Addressed;
  bot: boolean;
  /** A person's message on a Thread that already has Tickets. */
  followup: boolean;
  /** Receiving scope (chat, repository area, direct message, ...). */
  scope: string;
}
