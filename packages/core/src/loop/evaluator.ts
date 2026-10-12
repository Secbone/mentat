import type { Runtime, Signal } from "../artifact";
import { Context } from "../kernel/context";
import type { Disposable } from "../types";
import type { Candidate } from "./types";

/** One programmatic check. Deterministic so the loop is testable without models. */
export interface EvalTask {
  id: string;
  metrics: string[];
  run(runtime: Runtime): Promise<Signal[]> | Signal[];
}

export interface Evaluator {
  evaluate(candidate: Candidate): Promise<Signal[]>;
}

/** A named collection of tasks; the unit a benchmark is built from. */
export interface TaskSuite {
  id: string;
  description?: string;
  tasks: EvalTask[];
}

export function defineTaskSuite(suite: TaskSuite): TaskSuite {
  return suite;
}

/**
 * Applies a candidate's artifacts to a fresh runtime, runs every task, and
 * aggregates the signals (mean per metric name).
 */
export class FunctionEvaluator implements Evaluator {
  constructor(private readonly tasks: EvalTask[]) {}

  async evaluate(candidate: Candidate): Promise<Signal[]> {
    const runtime = new Context(undefined, `eval-${candidate.id}`);
    const disposables: Disposable[] = [];
    try {
      for (const artifact of candidate.artifacts) {
        disposables.push(await artifact.apply(runtime));
      }

      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      const directions = new Map<string, Signal["direction"]>();

      for (const task of this.tasks) {
        const signals = await task.run(runtime);
        for (const signal of signals) {
          sums.set(signal.name, (sums.get(signal.name) ?? 0) + signal.value);
          counts.set(signal.name, (counts.get(signal.name) ?? 0) + 1);
          directions.set(signal.name, signal.direction);
        }
      }

      const result: Signal[] = [];
      for (const [name, sum] of sums) {
        result.push({
          name,
          value: sum / (counts.get(name) ?? 1),
          direction: directions.get(name) ?? "higher-better",
        });
      }
      return result;
    } finally {
      for (const disposable of [...disposables].reverse()) await disposable.dispose();
      await runtime.dispose();
    }
  }
}
