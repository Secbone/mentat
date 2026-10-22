import type { ArtifactRef, Signal } from "@mentat/core";
import type { EvalProtocol } from "./protocol";
import type { Candidate, GateResult, IterationOutcome, IterationRecord } from "./types";

/**
 * Append-only evidence for one iteration. Shaped after in-toto attestations
 * and W3C PROV: the subject is the candidate's artifact digests, the predicate
 * is what happened and how it was measured.
 */
export interface IterationReceipt {
  version: 1;
  iteration: number;
  at: string;
  outcome: IterationOutcome;
  accepted: boolean;
  parent: { id: string; version: string; artifacts: ArtifactRef[] };
  candidate: { id: string; version: string; artifacts: ArtifactRef[] };
  signals: { before: Signal[]; after?: Signal[] };
  gate?: GateResult;
  protocol?: EvalProtocol;
  environment?: string;
  reason?: string;
}

export interface ReceiptOptions {
  parent: Candidate;
  child?: Candidate;
  protocol?: EvalProtocol;
  environment?: string;
  at?: string;
}

function stateOf(candidate: Candidate): IterationReceipt["parent"] {
  return {
    id: candidate.id,
    version: candidate.version,
    artifacts: candidate.artifacts.map((artifact) => artifact.ref),
  };
}

/** Build the receipt for a loop iteration. Pure; safe to persist verbatim. */
export function buildReceipt(record: IterationRecord, options: ReceiptOptions): IterationReceipt {
  const candidate = options.child ?? options.parent;
  return {
    version: 1,
    iteration: record.iteration,
    at: options.at ?? new Date().toISOString(),
    outcome: record.outcome,
    accepted: record.accepted,
    parent: stateOf(options.parent),
    candidate: stateOf(candidate),
    signals: {
      before: record.before.map((signal) => ({ ...signal })),
      ...(record.after ? { after: record.after.map((signal) => ({ ...signal })) } : {}),
    },
    ...(record.gate ? { gate: { ...record.gate } } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}
