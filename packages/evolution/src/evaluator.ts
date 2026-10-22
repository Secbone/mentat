import {
  type ArtifactHost,
  type ArtifactRegistry,
  createArtifactRegistry,
  type Disposable,
  type Signal,
} from "@mentat/core";
import { Context } from "@mentat/kernel";
import { validateSignals } from "./pareto";
import type { Candidate } from "./types";

/** One programmatic check. Deterministic so the loop is testable without models. */
export interface EvalTask {
  id: string;
  metrics: string[];
  run(host: ArtifactHost): Promise<Signal[]> | Signal[];
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
 * Materializes a candidate's *data* artifacts into a fresh host, runs every
 * task, and aggregates the signals (mean per metric name).
 *
 * Code artifacts are already materialized by the workspace transaction (a git
 * worktree/commit); re-applying them here would be both impossible and wrong.
 */
export class FunctionEvaluator implements Evaluator {
  private readonly registry: ArtifactRegistry;

  constructor(
    private readonly tasks: EvalTask[],
    registry: ArtifactRegistry,
  ) {
    this.registry = registry;
  }

  async evaluate(candidate: Candidate): Promise<Signal[]> {
    const runtime = new Context(undefined, `eval-${candidate.id}`);
    const disposables: Disposable[] = [];
    const failures: unknown[] = [];
    const result: Signal[] = [];
    try {
      for (const artifact of candidate.artifacts) {
        if (artifact.ref.form !== "data") continue;
        disposables.push(await this.registry.materialize(artifact, runtime));
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
