import {
  type DecisionOutcome,
  type Repositories,
  type Ticket,
  type TicketStage,
  ticketStage,
} from "@mentat/domain";

export interface TicketView {
  id: string;
  source: string;
  stage: TicketStage;
  latestReport?: string;
  question?: string;
  assignment?: string;
  worker?: string;
  outcome?: string;
}

export interface AssignmentView {
  id: string;
  ticket: string;
  worker: string;
  state: string;
  packDigest: string;
}

export interface EvolutionView {
  id: string;
  status: string;
  version: number;
  digest: string;
  reason?: string;
}

export interface SourceView {
  active: boolean;
  lastPollAt?: string;
  lastPollCount?: number;
  lastError?: string;
  consecutiveFailures: number;
}

export interface Overview {
  generatedAt: string;
  counts: {
    tickets: number;
    open: number;
    needsPerson: number;
    assignments: number;
    decisions: number;
  };
  needsPerson: TicketView[];
  open: TicketView[];
  ended: TicketView[];
  assignments: AssignmentView[];
  evolution: EvolutionView[];
  source?: SourceView;
  decisions: Record<DecisionOutcome, number>;
}

function view(ticket: Ticket, repos: Repositories): TicketView {
  const assignmentId = ticket.assignments.at(-1);
  const assignment = assignmentId ? repos.assignments.get(assignmentId) : undefined;
  return {
    id: ticket.id,
    source: ticket.source,
    stage: ticketStage({
      deliveryFailed: ticket.delivery !== undefined,
      attention: ticket.attention !== undefined,
      ...(ticket.latestReport ? { latestReport: ticket.latestReport } : {}),
      ...(assignment ? { assignment: assignment.state } : {}),
    }),
    ...(ticket.latestReport ? { latestReport: ticket.latestReport } : {}),
    ...(ticket.attention ? { question: ticket.attention.question } : {}),
    ...(assignment ? { assignment: assignment.id, worker: assignment.worker } : {}),
    ...(ticket.outcome ? { outcome: ticket.outcome } : {}),
  };
}

/**
 * Read-only projection for the panel: what needs a person first, then open
 * work, then history. No writes, no timers.
 */
export function buildOverview(
  repos: Repositories,
  options: { now?: () => Date; evolution?: EvolutionView[]; source?: SourceView } = {},
): Overview {
  const tickets = repos.tickets.list().map((ticket) => view(ticket, repos));
  const decisions: Record<DecisionOutcome, number> = {
    accept: 0,
    stop: 0,
    ignore: 0,
    unavailable: 0,
  };
  for (const decision of repos.decisions.list()) decisions[decision.outcome] += 1;
  const needsPerson = tickets.filter((ticket) => ticket.stage.startsWith("person/"));
  const open = tickets.filter((ticket) => !repos.tickets.get(ticket.id)?.endedAt);
  const ended = tickets.filter((ticket) => repos.tickets.get(ticket.id)?.endedAt);
  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    counts: {
      tickets: tickets.length,
      open: open.length,
      needsPerson: needsPerson.length,
      assignments: repos.assignments.list().length,
      decisions: repos.decisions.list().length,
    },
    needsPerson,
    open,
    ended,
    assignments: repos.assignments.list().map((assignment) => ({
      id: assignment.id,
      ticket: assignment.ticket,
      worker: assignment.worker,
      state: assignment.state,
      packDigest: assignment.packDigest,
    })),
    evolution: options.evolution ?? [],
    ...(options.source ? { source: options.source } : {}),
    decisions,
  };
}

/** Terminal rendering of the same projection. */
export function renderOverviewText(overview: Overview): string {
  const lines = [
    `Mentat overview ${overview.generatedAt}`,
    `needs person: ${overview.counts.needsPerson}  open: ${overview.counts.open}  tickets: ${overview.counts.tickets}`,
  ];
  for (const ticket of overview.needsPerson) {
    lines.push(
      `  ! ${ticket.id}  ${ticket.stage}  ${ticket.question ?? ticket.latestReport ?? ""}`.trimEnd(),
    );
  }
  for (const ticket of overview.open) {
    lines.push(`  - ${ticket.id}  ${ticket.stage}  ${ticket.latestReport ?? ""}`.trimEnd());
  }
  lines.push(
    `assignments: ${overview.assignments.length}  evolution: ${overview.evolution.length}`,
  );
  if (overview.source) {
    lines.push(
      `source: ${overview.source.active ? "active" : "idle"}  last poll: ${
        overview.source.lastPollAt ?? "never"
      }${overview.source.lastError ? `  error: ${overview.source.lastError}` : ""}`,
    );
  }
  lines.push(
    `decisions: accept=${overview.decisions.accept} stop=${overview.decisions.stop} ignore=${overview.decisions.ignore} unavailable=${overview.decisions.unavailable}`,
  );
  return `${lines.join("\n")}\n`;
}
