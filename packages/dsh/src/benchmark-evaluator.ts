import { createHash } from "node:crypto";
import {
  type BenchmarkRun,
  type EpisodeDataset,
  type RunPlan,
  runEpisodes,
  type SubjectFactory,
  summarizeRun,
} from "@mentat/benchmark";
import type { Signal } from "@mentat/core";
import type { PackEvaluator } from "@mentat/evolve";
import { type CapabilityPack, packRef } from "@mentat/pack";

export interface BenchmarkPackEvaluatorOptions {
  plan: RunPlan;
  dataset: EpisodeDataset;
  /** Build the benchmark subject for one pack; the evaluator owns the run. */
  createSubject(pack: CapabilityPack): SubjectFactory;
  /** Restrict signals to these arm ids (default: every arm in the plan). */
  arms?: string[];
  now?: () => Date;
  id?: () => string;
}

const hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Evaluate a CapabilityPack with the native episode runner. The pack is
 * identified in the run plan, so every signal is traceable to a pack digest.
 * Metrics are macro-averaged per family and exposed as `<arm>.<metric>`.
 */
export class BenchmarkPackEvaluator implements PackEvaluator {
  private readonly options: BenchmarkPackEvaluatorOptions;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

  constructor(options: BenchmarkPackEvaluatorOptions) {
    this.options = options;
    this.clock = options.now ?? (() => new Date());
    this.nextId = options.id ?? (() => crypto.randomUUID());
  }

  async evaluate(pack: CapabilityPack): Promise<Signal[]> {
    const plan = this.planFor(pack);
    const { results } = await runEpisodes(
      plan,
      this.options.dataset,
      this.options.createSubject(pack),
    );
    const run: BenchmarkRun = {
      schemaVersion: 1,
      id: this.nextId(),
      createdAt: this.clock().toISOString(),
      plan,
      provenance: {
        adapter: "mentat-benchmark",
        adapterVersion: "1",
        artifactSha256: hex(JSON.stringify(plan)),
        execution: results.every((row) => row.status === "completed") ? "completed" : "failed",
        notes: ["Native rule-based regression; not an upstream benchmark score."],
      },
      results,
    };
    const summary = summarizeRun(run);
    const signals: Signal[] = [];
    for (const metric of summary.metrics) {
      if (this.options.arms && !this.options.arms.includes(metric.arm)) continue;
      if (metric.macroMean === null)
        throw new Error(`benchmark metric ${metric.arm}.${metric.metric} has no measured trials`);
      signals.push({
        name: `${metric.arm}.${metric.metric}`,
        value: metric.macroMean,
        direction: metric.direction as Signal["direction"],
      });
    }
    if (signals.length === 0) throw new Error("benchmark produced no signals");
    return signals;
  }

  private planFor(pack: CapabilityPack): RunPlan {
    return {
      ...this.options.plan,
      subject: {
        ...this.options.plan.subject,
        revision: `${pack.id}@${pack.version}`,
        config: { ...this.options.plan.subject.config, pack: packRef(pack) },
      },
    };
  }
}
