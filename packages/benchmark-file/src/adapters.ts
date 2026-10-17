import {
  assert,
  completeResults,
  object,
  type ResultAdapter,
  type RunPlan,
  type TrialResult,
  type TrialUnit,
} from "@mentat/benchmark";

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "invalid usage/duration",
  );
  return value;
}
function bound(plan: RunPlan, sourceId: unknown): TrialUnit {
  assert(typeof sourceId === "string", "upstream trial identity required");
  const matches = plan.units.filter((u) => u.sourceId === sourceId);
  assert(matches.length === 1, `upstream identity must bind exactly once: ${sourceId}`);
  const unit = matches[0];
  assert(unit, "missing binding");
  return unit;
}
function measured(
  plan: RunPlan,
  unit: TrialUnit,
  lookup: (source: string) => unknown,
  failed: boolean,
) {
  return Object.fromEntries(
    unit.metricIds.map((id) => {
      const def = plan.metrics.find((m) => m.id === id);
      assert(def, "missing metric definition");
      if (failed) return [id, { value: null, reason: "upstream trial failed" }];
      assert(def.source, `${id}: explicit upstream score source required`);
      const raw = lookup(def.source);
      if (raw === undefined || raw === null)
        return [id, { value: null, reason: `upstream score absent: ${def.source}` }];
      const value =
        typeof raw === "string" && def.valueMap && Object.hasOwn(def.valueMap, raw)
          ? def.valueMap[raw]
          : raw;
      assert(
        typeof value === "number" && Number.isFinite(value),
        `unmapped or nonnumeric upstream score: ${id}`,
      );
      return [id, { value }];
    }),
  );
}
function base(unit: TrialUnit): TrialResult {
  return {
    caseId: unit.caseId,
    familyId: unit.familyId,
    arm: unit.arm,
    repetition: unit.repetition,
    status: "completed",
    metrics: {},
    evidence: [],
    durationMs: null,
    costUsd: null,
  };
}
function duration(start: unknown, end: unknown): number | null {
  if (start == null || end == null) return null;
  assert(typeof start === "string" && typeof end === "string", "invalid timestamps");
  const result = Date.parse(end) - Date.parse(start);
  return nullableNumber(result);
}
export const normalizedAdapter: ResultAdapter = {
  id: "normalized-v1",
  version: "1",
  read(input, plan) {
    assert(Array.isArray(input), "normalized input must contain per-trial records");
    return completeResults(plan, input as TrialResult[]);
  },
};
/** Harbor TrialResult, single-step trials. Do not parse the job aggregate as trials. */
export const harborAdapter: ResultAdapter = {
  id: "harbor-trials-v1",
  version: "1",
  read(input, plan) {
    const trials = Array.isArray(input) ? input : [input];
    return completeResults(
      plan,
      trials.map((raw) => {
        const trial = object(raw),
          unit = bound(plan, trial.trial_name);
        assert(trial.task_name === unit.caseId, "Harbor task identity mismatch");
        assert(
          !Array.isArray(trial.step_results) || trial.step_results.length === 0,
          "multi-step Harbor trials require an explicit step aggregation adapter",
        );
        const row = base(unit),
          failed = trial.exception_info != null;
        row.status = failed ? "error" : "completed";
        if (failed) row.error = JSON.stringify(trial.exception_info);
        const verifier = trial.verifier_result == null ? {} : object(trial.verifier_result);
        const rewards = verifier.rewards == null ? {} : object(verifier.rewards);
        row.metrics = measured(
          plan,
          unit,
          (source) => (Object.hasOwn(rewards, source) ? rewards[source] : undefined),
          failed,
        );
        const usage = trial.agent_result == null ? {} : object(trial.agent_result);
        row.costUsd = nullableNumber(usage.cost_usd);
        row.durationMs = duration(trial.started_at, trial.finished_at);
        row.evidence = [String(trial.trial_uri ?? `harbor:${unit.sourceId}`)];
        return row;
      }),
    );
  },
};
/** Inspect's exported EvalLog JSON with retained samples. .eval archives need conversion upstream. */
export const inspectAdapter: ResultAdapter = {
  id: "inspect-json-v1",
  version: "1",
  read(input, plan) {
    const log = object(input);
    assert(log.version === 2, "unsupported Inspect JSON schema version; expected 2");
    assert(
      Array.isArray(log.samples),
      "Inspect per-sample JSON required; summary-only/.eval archives unsupported",
    );
    return completeResults(
      plan,
      log.samples.map((raw) => {
        const sample = object(raw);
        assert(
          typeof sample.id === "string" || typeof sample.id === "number",
          "Inspect sample id required",
        );
        assert(
          Number.isSafeInteger(sample.epoch) && Number(sample.epoch) >= 0,
          "Inspect epoch required",
        );
        const unit = bound(plan, `${sample.id}:${sample.epoch}`),
          row = base(unit);
        const failed = sample.error != null || sample.completed === false;
        row.status =
          sample.error != null ? "error" : sample.completed === false ? "missing" : "completed";
        if (failed) row.error = JSON.stringify(sample.error);
        if (sample.completed === false && sample.error == null)
          row.error = "Inspect sample incomplete";
        const scores = sample.scores == null ? {} : object(sample.scores);
        row.metrics = measured(
          plan,
          unit,
          (source) => {
            // Exact scorer names first; dotted source optionally selects an object-valued score.
            if (Object.hasOwn(scores, source)) return object(scores[source]).value;
            const index = source.lastIndexOf(".");
            if (index < 0 || !Object.hasOwn(scores, source.slice(0, index))) return undefined;
            const value = object(scores[source.slice(0, index)]).value;
            return value != null && typeof value === "object"
              ? object(value)[source.slice(index + 1)]
              : undefined;
          },
          failed,
        );
        row.evidence = [`inspect:${sample.id}:${sample.epoch}`];
        // Inspect usage is commonly aggregate or token-only; never divide a job bill across samples.
        row.costUsd = null;
        row.durationMs =
          sample.total_time == null ? null : (nullableNumber(sample.total_time) ?? 0) * 1000;
        return row;
      }),
    );
  },
};
export class ResultAdapterRegistry {
  private readonly adapters = new Map<string, ResultAdapter>();
  register(adapter: ResultAdapter) {
    assert(!this.adapters.has(adapter.id), `duplicate result adapter ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  get(id: string) {
    const adapter = this.adapters.get(id);
    assert(adapter, `unknown result adapter ${id}`);
    return adapter;
  }
  list() {
    return [...this.adapters.values()].map(({ id, version }) => ({ id, version }));
  }
}
export function defaultResultAdapters() {
  return new ResultAdapterRegistry()
    .register(normalizedAdapter)
    .register(harborAdapter)
    .register(inspectAdapter);
}
