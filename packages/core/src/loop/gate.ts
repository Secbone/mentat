import type { Candidate, GateResult } from "./types";

/** A checkpoint between materializing a change and evaluating it. */
export interface Gate {
  readonly name: string;
  check(candidate: Candidate): Promise<GateResult> | GateResult;
}

/** Runs gates in order; the first failure short-circuits. */
export class GateChain implements Gate {
  readonly name = "chain";

  constructor(private readonly gates: Gate[]) {}

  async check(candidate: Candidate): Promise<GateResult> {
    for (const gate of this.gates) {
      const result = await gate.check(candidate);
      if (!result.passed) return result;
    }
    return { passed: true, gate: this.name };
  }
}

export function functionGate(
  name: string,
  check: (candidate: Candidate) => boolean | GateResult,
): Gate {
  return {
    name,
    check: (candidate) => {
      const result = check(candidate);
      if (typeof result === "boolean") {
        return result
          ? { passed: true, gate: name }
          : { passed: false, gate: name, reason: "rejected" };
      }
      return result;
    },
  };
}
