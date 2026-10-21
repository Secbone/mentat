import type { Disposable, Runtime, Signal } from "@mentat/core";
import { Context } from "@mentat/kernel";
import { validateSignals } from "./pareto";
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
    const failures: unknown[] = [];
    const result: Signal[] = [];
    try {
      for (const artifact of candidate.artifacts) {
        disposables.push(await artifact.apply(runtime));
      }

      const sums = new Map<string, number>();
      const counts = new Map<string, number>();
      const directions = new Map<string, Signal["direction"]>();

      for (const task of this.tasks) {
        const signals = await task.run(runtime);
        validateSignals(signals);
        if (
          new Set(task.metrics).size !== task.metrics.length ||
          signals.length !== task.metrics.length ||
          signals.some((s) => !task.metrics.includes(s.name))
        )
          throw new Error(`task ${task.id}: metric contract changed`);
        for (const signal of signals) {
          if (directions.has(signal.name) && directions.get(signal.name) !== signal.direction)
            throw new Error(`inconsistent metric direction: ${signal.name}`);
          sums.set(signal.name, (sums.get(signal.name) ?? 0) + signal.value);
          counts.set(signal.name, (counts.get(signal.name) ?? 0) + 1);
          directions.set(signal.name, signal.direction);
        }
      }

      for (const [name, sum] of sums) {
        result.push({
          name,
          value: sum / (counts.get(name) ?? 1),
          direction: directions.get(name) ?? "higher-better",
        });
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const disposable of [...disposables].reverse())
        try {
          await disposable.dispose();
        } catch (error) {
          failures.push(error);
        }
      try {
        await runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "evaluation and cleanup failed");
    return result;
  }
}
