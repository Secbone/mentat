import type { Signal } from "@mentat/core";
import type { CapabilityPack } from "@mentat/pack";
import type { PackEvaluator } from "./types";

export interface MatrixEvaluatorEntry {
  worker: string;
  evaluator: PackEvaluator;
}

/**
 * Evaluate one pack across several workers. Signals are namespaced by worker
 * so a single-worker gain cannot masquerade as a system-wide gain; the
 * improvement gate then requires every worker to be no worse.
 */
export class MatrixPackEvaluator implements PackEvaluator {
  private readonly entries: MatrixEvaluatorEntry[];

  constructor(entries: MatrixEvaluatorEntry[]) {
    if (entries.length === 0) throw new Error("matrix evaluator requires at least one worker");
    const names = new Set(entries.map((entry) => entry.worker));
    if (names.size !== entries.length) throw new Error("duplicate matrix worker");
    this.entries = entries;
  }

  async evaluate(pack: CapabilityPack): Promise<Signal[]> {
    const results = await Promise.all(
      this.entries.map(async (entry) => ({
        worker: entry.worker,
        signals: await entry.evaluator.evaluate(pack),
      })),
    );
    const signals: Signal[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      for (const signal of result.signals) {
        const name = `${result.worker}.${signal.name}`;
        if (seen.has(name)) throw new Error(`duplicate matrix signal: ${name}`);
        seen.add(name);
        signals.push({ ...signal, name });
      }
    }
    return signals;
  }
}
