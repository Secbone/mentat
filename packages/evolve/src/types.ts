import type { Signal } from "@mentat/core";
import type { CapabilityPack, PackRef } from "@mentat/pack";

export type CandidateStatus = "evaluated" | "accepted" | "rejected";

export interface Observation {
  id: string;
  at: string;
  text: string;
  kind?: "failure" | "correction" | "success";
  source?: string;
}

export interface GateResult {
  passed: boolean;
  gate: string;
  reason?: string;
}

export interface PackCandidate {
  id: string;
  at: string;
  base: PackRef;
  pack: CapabilityPack;
  status: CandidateStatus;
  provenance: {
    proposer: string;
    observations: string[];
    rationale: string;
  };
  signals?: { base: Signal[]; candidate: Signal[] };
  gate?: GateResult;
  reason?: string;
}

export interface PackProposer {
  /** Stable proposer id recorded in the candidate provenance. */
  readonly id?: string;
  propose(base: CapabilityPack, observations: Observation[]): Promise<CapabilityPack>;
}

export interface PackEvaluator {
  evaluate(pack: CapabilityPack): Promise<Signal[]>;
}

export interface PackGate {
  readonly name: string;
  check(candidate: PackCandidate): Promise<GateResult> | GateResult;
}
