import type { AssignmentState, ReportKind } from "./types";

/**
 * What an open Ticket is waiting for. Read top to bottom; the first matching
 * row wins. Mirrors the Super-agent stage table.
 */
export type TicketStage =
  | "person/delivery"
  | "person/answer"
  | "person/review"
  | "person/blocked"
  | "person/failed"
  | "working/queued"
  | "idle"
  | "working";

export interface TicketStageFacts {
  /** Delivering an Input to the Worker failed. */
  deliveryFailed?: boolean;
  /** The Ticket has a concrete question for a person. */
  attention?: boolean;
  latestReport?: ReportKind;
  /** A person's message reached the Ticket since the latest Report. */
  humanMessageSinceLatestReport?: boolean;
  /** Latest Assignment state, when one exists. */
  assignment?: AssignmentState;
}

/** Derive the stage from stored facts only; no clock, no I/O. */
export function ticketStage(facts: TicketStageFacts): TicketStage {
  if (facts.deliveryFailed) return "person/delivery";
  if (facts.attention) return "person/answer";
  if (facts.latestReport === "ready") return "person/review";
  if (
    (facts.latestReport === "blocked" || facts.latestReport === "failed") &&
    !facts.humanMessageSinceLatestReport
  )
    return facts.latestReport === "blocked" ? "person/blocked" : "person/failed";
  if (!facts.assignment || facts.assignment === "pending") return "working/queued";
  if (facts.latestReport === "waiting" || facts.assignment === "ended") return "idle";
  return "working";
}

/** A person-triggered retry is available only for these stages. */
export function canRetry(stage: TicketStage): boolean {
  return stage === "person/delivery" || stage === "person/blocked" || stage === "person/failed";
}
