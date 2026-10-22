import type { Artifact, Signal } from "@mentat/core";

/** A concrete framework state: a set of immutable artifacts at some version. */
export interface Candidate {
  id: string;
  version: string;
  artifacts: Artifact[];
  parentId?: string;
}

/**
 * A proposed change. `artifacts` replaces the parent's artifact set for
 * data/prompt/memory loops. Agent-driven code loops leave it undefined and
 * edit the workspace directly; the workspace then attaches a code artifact to
 * the child candidate.
 */
export interface Proposal {
  id: string;
  description: string;
  artifacts?: Artifact[];
}

export interface GateResult {
  passed: boolean;
  gate: string;
  reason?: string;
}

export interface LoopConfig {
  maxIterations: number;
  /** Stop after this many consecutive rejected iterations. Defaults to Infinity. */
  maxFailures?: number;
  /**
   * How the next parent is chosen: the latest accepted candidate ("current")
   * or sampled from the archive ("archive", DGM-style open-ended search).
   */
  parentSelection?: "current" | "archive";
}

export type IterationOutcome = "completed" | "error" | "timeout" | "invalid";

export interface IterationRecord {
  iteration: number;
  parentId: string;
  childId: string;
  proposal: Proposal;
  gate?: GateResult;
  before: Signal[];
  after?: Signal[];
  accepted: boolean;
  reason?: string;
  outcome: IterationOutcome;
}
