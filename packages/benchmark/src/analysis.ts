import type { BenchmarkRun, Dimension, TrialResult } from "./types";
import { assert, canonical, unitKey, validateRun } from "./validation";

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function macro(rows: Array<{ familyId: string; value: number }>): number | null {
  const families = new Map<string, number[]>();
  for (const row of rows) {
    const values = families.get(row.familyId) ?? [];
    values.push(row.value);
    families.set(row.familyId, values);
  }
  return mean([...families.values()].map((values) => mean(values) as number));
}
export interface MetricSummary {
  arm: string;
  metric: string;
  dimension: Dimension;
  direction: string;
  unit: string;
  planned: number;
  measured: number;
  unknown: number;
  families: number;
  macroMean: number | null;
}
export function summarizeRun(raw: BenchmarkRun) {
  const run = validateRun(raw);
  const metrics: MetricSummary[] = [];
  for (const arm of run.plan.protocol.arms)
    for (const definition of run.plan.metrics) {
      const relevant = run.results.filter((r) => r.arm === arm.id && definition.id in r.metrics);
      if (!relevant.length) continue;
      const measured = relevant.flatMap((r) => {
        const value = r.metrics[definition.id]?.value;
        return typeof value === "number" ? [{ familyId: r.familyId, value }] : [];
      });
      metrics.push({
        arm: arm.id,
        metric: definition.id,
        dimension: definition.dimension,
        direction: definition.direction,
        unit: definition.unit,
        planned: relevant.length,
        measured: measured.length,
        unknown: relevant.length - measured.length,
        families: new Set(measured.map((x) => x.familyId)).size,
        macroMean: macro(measured),
      });
    }
  return {
    runId: run.id,
    benchmark: run.plan.benchmark,
    subject: run.plan.subject,
    execution: run.provenance.execution,
    trials: Object.fromEntries(
      ["completed", "error", "missing", "skipped"].map((status) => [
        status,
        run.results.filter((r) => r.status === status).length,
      ]),
    ),
    planned: run.plan.units.length,
    reflections: {
      attempted: run.results.filter((r) => r.reflection).length,
      completed: run.results.filter((r) => r.reflection?.status === "completed").length,
      invalid: run.results.filter((r) => r.reflection?.status === "invalid").length,
      errors: run.results.filter((r) => r.reflection?.status === "error").length,
    },
    cost: {
      knownUsd: run.results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      measured: run.results.filter((r) => r.costUsd !== null).length,
      unknown: run.results.filter((r) => r.costUsd === null).length,
    },
    metrics,
  };
}
/** Project revision may change; task/scoring/runtime/model/selection must not. */
export function comparisonIdentity(run: BenchmarkRun) {
  const { revision: _revision, codeSha256: _code, ...subject } = run.plan.subject;
  return {
    benchmark: run.plan.benchmark,
    dataset: run.plan.dataset,
    scorer: run.plan.scorer,
    protocol: run.plan.protocol,
    metrics: run.plan.metrics,
    units: run.plan.units,
    subject,
    adapter: run.provenance.adapter,
    adapterVersion: run.provenance.adapterVersion,
    executionConfigSha256: run.provenance.executionConfigSha256 ?? null,
  };
}
function interval(values: number[]): [number, number] | null {
  if (values.length < 2) return null;
  let seed = 5489;
  const draws: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sum += values[seed % values.length] ?? 0;
    }
    draws.push(sum / values.length);
  }
  draws.sort((a, b) => a - b);
  return [draws[49] ?? 0, draws[1949] ?? 0];
}
function pairedMetric(
  before: TrialResult[],
  after: TrialResult[],
  metric: string,
  direction: string,
) {
  const right = new Map(after.map((r) => [unitKey(r), r]));
  const byFamily = new Map<string, number[]>();
  let planned = 0,
    paired = 0;
  for (const row of before) {
    if (!(metric in row.metrics)) continue;
    planned++;
    const a = row.metrics[metric]?.value,
      b = right.get(unitKey(row))?.metrics[metric]?.value;
    if (typeof a !== "number" || typeof b !== "number") continue;
    paired++;
    const values = byFamily.get(row.familyId) ?? [];
    values.push(b - a);
    byFamily.set(row.familyId, values);
  }
  const familyDeltas = [...byFamily.values()].map((v) => mean(v) as number),
    delta = mean(familyDeltas);
  return {
    planned,
    paired,
    unpaired: planned - paired,
    families: familyDeltas.length,
    delta,
    improvement: delta === null ? null : direction === "lower-better" ? -delta : delta,
    confidence95: interval(familyDeltas),
    warning:
      "Paired available-case family macro difference; inspect missing trials. Bootstrap clusters are families; small family counts do not establish generalization.",
  };
}
export function compareRuns(beforeRaw: BenchmarkRun, afterRaw: BenchmarkRun) {
  const before = validateRun(beforeRaw),
    after = validateRun(afterRaw);
  const a = comparisonIdentity(before),
    b = comparisonIdentity(after);
  const mismatches = Object.keys(a).filter(
    (key) => canonical(a[key as keyof typeof a]) !== canonical(b[key as keyof typeof b]),
  );
  if (mismatches.length)
    return {
      comparable: false as const,
      before: before.id,
      after: after.id,
      mismatches,
      metrics: [],
    };
  const metrics = before.plan.protocol.arms.flatMap((arm) =>
    before.plan.metrics.map((metric) => ({
      arm: arm.id,
      metric: metric.id,
      dimension: metric.dimension,
      unit: metric.unit,
      ...pairedMetric(
        before.results.filter((r) => r.arm === arm.id),
        after.results.filter((r) => r.arm === arm.id),
        metric.id,
        metric.direction,
      ),
    })),
  );
  return {
    comparable: true as const,
    before: before.id,
    after: after.id,
    mismatches: [],
    metrics,
    beforeCoverage: summarizeRun(before),
    afterCoverage: summarizeRun(after),
  };
}
/** Explicit cross-project study; preserves data/scorer/protocol/backend equality.
 * Method differences are declared experimental variables, not silently discarded.
 */
export function compareSubjects(beforeRaw: BenchmarkRun, afterRaw: BenchmarkRun) {
  const before = validateRun(beforeRaw),
    after = validateRun(afterRaw);
  const study = before.plan.protocol.config.crossSubjectStudy;
  assert(
    typeof study === "string" && study.length > 0,
    "cross-subject comparison requires a pinned study id",
  );
  assert(after.plan.protocol.config.crossSubjectStudy === study, "cross-subject study mismatch");
  for (const run of [before, after]) {
    assert(run.plan.subject.config.study === study, "subject study identity missing");
    assert(
      run.plan.subject.config.method && typeof run.plan.subject.config.method === "object",
      "declare subject method differences",
    );
  }
  const project = (run: BenchmarkRun): BenchmarkRun => ({
    ...run,
    plan: {
      ...run.plan,
      subject: {
        ...run.plan.subject,
        id: `controlled-study:${study}`,
        revision: "controlled-study",
        codeSha256: "0".repeat(64),
        config: { study },
      },
    },
  });
  return {
    ...compareRuns(project(before), project(after)),
    subjects: [before.plan.subject, after.plan.subject],
    interpretation:
      "Controlled cross-subject difference. Method configurations are declared experimental variables; this is not a project-version regression or proof of architectural causality.",
  };
}
/** Within-run matched ablation. Unequal task membership is rejected, not silently intersected. */
export function compareArms(raw: BenchmarkRun, baseline: string, treatment: string) {
  const run = validateRun(raw);
  assert(baseline !== treatment, "different arms required");
  const project = (arm: string): BenchmarkRun => {
    const policy = run.plan.protocol.arms.find((a) => a.id === arm);
    assert(policy, `unknown arm ${arm}`);
    return {
      ...run,
      id: `${run.id}:${arm}`,
      plan: {
        ...run.plan,
        protocol: { ...run.plan.protocol, arms: [{ id: "paired", memory: "reset" }] },
        units: run.plan.units
          .filter((u) => u.arm === arm)
          .map((u) => ({ ...u, arm: "paired", sourceId: u.caseId })),
      },
      results: run.results.filter((r) => r.arm === arm).map((r) => ({ ...r, arm: "paired" })),
    };
  };
  return compareRuns(project(baseline), project(treatment));
}
