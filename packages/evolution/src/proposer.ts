import type { Signal } from "@mentat/core";
import type { Candidate, Proposal } from "./types";

/** Decides what to change, given the current state and its evaluation. */
export interface Proposer {
  propose(parent: Candidate, signals: Signal[]): Promise<Proposal>;
}

export type ProposeStep = (parent: Candidate, signals: Signal[]) => Proposal;

/** Deterministic proposer for tests: emits scripted proposals in order. */
export class ScriptedProposer implements Proposer {
  private index = 0;

  constructor(private readonly script: ProposeStep[]) {}

  async propose(parent: Candidate, signals: Signal[]): Promise<Proposal> {
    const step = this.script[this.index];
    if (!step) throw new Error("scripted proposer exhausted");
    this.index += 1;
    return step(parent, signals);
  }
}
