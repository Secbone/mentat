import type { IterableArtifact, Signal } from "../artifact";

/** A concrete framework state: a set of artifacts at some version. */
export interface Candidate {
  id: string;
  version: string;
  artifacts: IterableArtifact[];
  parentId?: string;
}

/**
 * A proposed change. `artifacts` is the artifact set that replaces the
 * parent's (data/prompt/memory loops); agent-driven code loops leave it
 * undefined and edit the workspace directly.
 */
export interface Proposal {
  id: string;
  description: string;
  artifacts?: IterableArtifact[];
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
}

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
}
