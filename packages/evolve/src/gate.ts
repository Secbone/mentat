import type { Signal } from "@mentat/core";
import { dominates } from "./compare";
import type { GateResult, PackCandidate, PackGate } from "./types";

export class GateChain implements PackGate {
  readonly name = "chain";

  constructor(private readonly gates: PackGate[]) {}

  async check(candidate: PackCandidate): Promise<GateResult> {
    for (const gate of this.gates) {
      const result = await gate.check(candidate);
      if (!result.passed) return result;
    }
    return { passed: true, gate: this.name };
  }
}

export function functionGate(
  name: string,
  check: (candidate: PackCandidate) => boolean | GateResult,
): PackGate {
  return {
    name,
    check(candidate) {
      const result = check(candidate);
      if (typeof result === "boolean")
        return result
          ? { passed: true, gate: name }
          : { passed: false, gate: name, reason: "rejected" };
      return result;
    },
  };
}

/** Accept only a Pareto improvement over the base signals. */
export function improvementGate(): PackGate {
  return functionGate("improvement", (candidate) => {
    if (!candidate.signals) return { passed: false, gate: "improvement", reason: "no signals" };
    return dominates(candidate.signals.candidate, candidate.signals.base)
      ? { passed: true, gate: "improvement" }
      : { passed: false, gate: "improvement", reason: "no improvement" };
  });
}

/** Reject when a named metric exceeds a ceiling (cost, latency, ...). */
export function maxSignalGate(name: string, max: number): PackGate {
  return functionGate(`max:${name}`, (candidate) => {
    const signal = candidate.signals?.candidate.find((item) => item.name === name);
    if (!signal) return { passed: true, gate: `max:${name}` };
    return signal.value <= max
      ? { passed: true, gate: `max:${name}` }
      : { passed: false, gate: `max:${name}`, reason: `${name}=${signal.value} > ${max}` };
  });
}

export function signalOf(signals: Signal[] | undefined, name: string): number | undefined {
  return signals?.find((signal) => signal.name === name)?.value;
}
