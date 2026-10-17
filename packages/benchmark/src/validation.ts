import { validateCriteria } from "./criteria";
import {
  type BenchmarkRun,
  DIMENSIONS,
  type EpisodeDataset,
  type RunPlan,
  type TrialResult,
  type TrialUnit,
} from "./types";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${label}: expected nonempty string`,
  );
}
export function finite(value: unknown, label: string): asserts value is number {
  assert(typeof value === "number" && Number.isFinite(value), `${label}: expected finite number`);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  assert(encoded !== undefined, "value is not JSON");
  return encoded;
}
export function unitKey(unit: Pick<TrialUnit, "caseId" | "arm" | "repetition">): string {
  return canonical([unit.caseId, unit.arm, unit.repetition]);
}
function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, `duplicate ${label}`);
}
function identity(value: unknown, label: string) {
  nonempty(value, label);
  assert(
    !["unknown", "latest", "main", "master"].includes(value.toLowerCase()),
    `${label}: pin a revision, not ${value}`,
  );
}
function digest(value: unknown, label: string) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${label}: expected sha256`);
}
export function validatePlan(value: unknown): RunPlan {
  const p = object(value);
  assert(p.schemaVersion === 1, "unsupported plan schema");
  const b = object(p.benchmark),
    d = object(p.dataset),
    s = object(p.scorer),
    subject = object(p.subject),
    protocol = object(p.protocol);
  nonempty(b.id, "benchmark.id");
  identity(b.version, "benchmark.version");
  assert(["upstream", "adapted", "smoke"].includes(String(b.track)), "invalid benchmark track");
  for (const key of ["revision", "split", "source"]) nonempty(d[key], `dataset.${key}`);
  identity(d.revision, "dataset.revision");
  digest(d.sha256, "dataset.sha256");
  for (const [name, entry] of [
    ["scorer", s],
    ["protocol", protocol],
  ] as const) {
    nonempty(entry.id, `${name}.id`);
    identity(entry.revision, `${name}.revision`);
    object(entry.config);
  }
  for (const key of ["id", "revision", "harness", "harnessVersion", "model", "modelVersion"])
    identity(subject[key], `subject.${key}`);
  digest(subject.codeSha256, "subject.codeSha256");
  object(subject.config);
  for (const key of ["maxCalls", "turnTimeoutMs"])
    assert(
      Number.isSafeInteger(protocol[key]) && Number(protocol[key]) > 0,
      `invalid protocol.${key}`,
    );
  assert(Array.isArray(protocol.arms) && protocol.arms.length > 0, "arms required");
  const arms = protocol.arms.map((v: unknown) => {
    const arm = object(v);
    nonempty(arm.id, "arm.id");
    assert(["reset", "explicit", "reflect"].includes(String(arm.memory)), "invalid memory arm");
    return arm.id;
  });
  unique(arms, "arm");
  assert(Array.isArray(p.metrics) && p.metrics.length > 0, "metrics required");
  const metrics = p.metrics.map((v: unknown) => {
    const m = object(v);
    nonempty(m.id, "metric.id");
    nonempty(m.unit, "metric.unit");
    assert(DIMENSIONS.includes(m.dimension as never), "invalid metric dimension");
    assert(
      ["higher-better", "lower-better"].includes(String(m.direction)),
      "invalid metric direction",
    );
    if (m.source !== undefined) nonempty(m.source, "metric.source");
    for (const bound of ["min", "max"])
      if (m[bound] !== undefined) finite(m[bound], `metric.${bound}`);
    if (m.min !== undefined && m.max !== undefined)
      assert(Number(m.min) <= Number(m.max), "invalid metric bounds");
    if (m.valueMap !== undefined)
      for (const x of Object.values(object(m.valueMap))) finite(x, "valueMap");
    return m.id;
  });
  unique(metrics, "metric");
  assert(Array.isArray(p.units) && p.units.length > 0, "planned units required");
  const keys: string[] = [];
  const families = new Map<string, string>();
  for (const v of p.units) {
    const u = object(v);
    for (const key of ["caseId", "familyId", "arm", "sourceId"]) nonempty(u[key], `unit.${key}`);
    assert(arms.includes(String(u.arm)), "unknown arm");
    assert(Number.isSafeInteger(u.repetition) && Number(u.repetition) >= 0, "invalid repetition");
    assert(
      Array.isArray(u.metricIds) && u.metricIds.every((id) => metrics.includes(id)),
      "unknown planned metric",
    );
    unique(u.metricIds as string[], "unit metric");
    const family = families.get(String(u.caseId));
    assert(family === undefined || family === u.familyId, "case assigned to different families");
    families.set(String(u.caseId), String(u.familyId));
    keys.push(unitKey(u as unknown as TrialUnit));
  }
  unique(keys, "trial");
  // Native episodes reuse ids across arms/repetitions; external adapters use unitKey bindings.
  return value as RunPlan;
}
export function completeResults(plan: RunPlan, rows: TrialResult[]): TrialResult[] {
  const planned = new Map(plan.units.map((u) => [unitKey(u), u]));
  const seen = new Map<string, TrialResult>();
  for (const row of rows) {
    const key = unitKey(row),
      unit = planned.get(key);
    assert(unit, `unplanned result ${key}`);
    assert(!seen.has(key), `duplicate result ${key}`);
    assert(row.familyId === unit.familyId, "result family mismatch");
    assert(
      ["completed", "error", "skipped", "missing"].includes(row.status),
      "invalid result status",
    );
    assert(
      Array.isArray(row.evidence) && row.evidence.every((x) => typeof x === "string"),
      "invalid evidence",
    );
    if (row.error !== undefined) nonempty(row.error, "result error");
    if (row.reflection !== undefined) {
      const reflection = object(row.reflection);
      assert(
        ["completed", "invalid", "error"].includes(String(reflection.status)),
        "invalid reflection status",
      );
      for (const key of ["added", "merged", "skipped", "rejected"])
        if (reflection[key] !== undefined)
          assert(
            Number.isSafeInteger(reflection[key]) && Number(reflection[key]) >= 0,
            "invalid reflection count",
          );
    }
    for (const field of ["durationMs", "costUsd"] as const) {
      if (row[field] !== null) {
        finite(row[field], field);
        assert(row[field] >= 0, `negative ${field}`);
      }
    }
    object(row.metrics);
    const measurements: TrialResult["metrics"] = {};
    for (const id of Object.keys(row.metrics))
      assert(unit.metricIds.includes(id), `unplanned metric ${id}`);
    for (const id of unit.metricIds) {
      const m = row.metrics[id] ?? { value: null, reason: "metric absent from source" };
      object(m);
      if (m.value !== null) {
        finite(m.value, id);
        assert(row.status === "completed", "failed/skipped/missing trials cannot publish scores");
        const def = plan.metrics.find((d) => d.id === id);
        assert(
          def &&
            (def.min === undefined || m.value >= def.min) &&
            (def.max === undefined || m.value <= def.max),
          `metric ${id} out of range`,
        );
      } else nonempty(m.reason, `unknown ${id} reason`);
      measurements[id] = { ...m };
    }
    seen.set(key, { ...row, metrics: measurements });
  }
  return plan.units.map(
    (unit) =>
      seen.get(unitKey(unit)) ?? {
        caseId: unit.caseId,
        familyId: unit.familyId,
        arm: unit.arm,
        repetition: unit.repetition,
        status: "missing",
        metrics: Object.fromEntries(
          unit.metricIds.map((id) => [id, { value: null, reason: "planned trial not reported" }]),
        ),
        evidence: [],
        error: "planned trial not reported",
        durationMs: null,
        costUsd: null,
      },
  );
}
export function validateRun(value: unknown): BenchmarkRun {
  const r = object(value);
  assert(r.schemaVersion === 1, "unsupported run schema");
  nonempty(r.id, "run.id");
  nonempty(r.createdAt, "createdAt");
  assert(Number.isFinite(Date.parse(r.createdAt)), "invalid run date");
  const p = object(r.provenance);
  nonempty(p.adapter, "adapter");
  identity(p.adapterVersion, "adapterVersion");
  digest(p.artifactSha256, "artifactSha256");
  if (p.executionConfigSha256 !== undefined)
    digest(p.executionConfigSha256, "executionConfigSha256");
  assert(["imported", "completed", "failed"].includes(String(p.execution)), "invalid execution");
  assert(Array.isArray(p.notes) && p.notes.every((x) => typeof x === "string"), "notes required");
  const plan = validatePlan(r.plan);
  assert(Array.isArray(r.results), "results required");
  return { ...(value as BenchmarkRun), results: completeResults(plan, r.results as TrialResult[]) };
}
export function validateDataset(value: unknown): EpisodeDataset {
  const d = object(value);
  assert(
    d.schemaVersion === 1 && Array.isArray(d.episodes) && d.episodes.length > 0,
    "invalid episode dataset",
  );
  const ids: string[] = [];
  for (const raw of d.episodes) {
    const e = object(raw);
    nonempty(e.id, "episode.id");
    nonempty(e.familyId, "episode.familyId");
    ids.push(e.id);
    assert(
      ["learn", "probe", "update", "exception", "regression"].includes(String(e.phase)),
      "invalid phase",
    );
    assert(Array.isArray(e.turns) && e.turns.length > 0, "turns required");
    for (const [turnIndex, rawTurn] of e.turns.entries()) {
      const t = object(rawTurn),
        input = object(t.input);
      if (t.when !== undefined) {
        const when = object(t.when);
        assert(
          Number.isSafeInteger(when.previousTurn) &&
            Number(when.previousTurn) >= 0 &&
            Number(when.previousTurn) < turnIndex,
          "conditional feedback requires an earlier turn",
        );
        validateCriteria(when.unless);
      }
      nonempty(input.text, "input.text");
      if (input.hostPolicy !== undefined) nonempty(input.hostPolicy, "hostPolicy");
      if (input.memoryScope !== undefined)
        assert(
          ["task", "reusable", "unspecified"].includes(String(input.memoryScope)),
          "invalid memoryScope",
        );
      if (input.materials !== undefined) {
        assert(Array.isArray(input.materials), "invalid materials");
        for (const rawMaterial of input.materials) {
          const m = object(rawMaterial);
          nonempty(m.text, "material.text");
          if (m.attribution !== undefined) nonempty(m.attribution, "material.attribution");
          if (m.memoryScope !== undefined)
            assert(
              ["task", "reusable", "unspecified"].includes(String(m.memoryScope)),
              "invalid material scope",
            );
        }
      }
      if (t.remember !== undefined) {
        assert(Array.isArray(t.remember), "remember must be typed rules");
        for (const rawMemory of t.remember) {
          const m = object(rawMemory);
          nonempty(m.text, "remember.text");
          assert(
            ["fact", "preference", "constraint", "method"].includes(String(m.kind)),
            "invalid remember kind",
          );
          for (const k of ["key", "condition"])
            if (m[k] !== undefined) nonempty(m[k], `remember.${k}`);
        }
      }
    }
    assert(Array.isArray(e.checks), "checks required");
    const checked: string[] = [];
    for (const rawCheck of e.checks) {
      const c = object(rawCheck);
      nonempty(c.metricId, "check.metricId");
      checked.push(c.metricId);
      assert(
        Number.isSafeInteger(c.turn) && Number(c.turn) >= 0 && Number(c.turn) < e.turns.length,
        "invalid check turn",
      );
      assert(
        ["exact", "includes", "json-equals", "json-criteria"].includes(String(c.kind)),
        "unknown check kind",
      );
      nonempty(c.expected, "check.expected");
      if (c.kind === "json-equals") JSON.parse(c.expected);
      if (c.kind === "json-criteria") validateCriteria(JSON.parse(c.expected));
    }
    unique(checked, "episode check metric");
  }
  unique(ids, "episode");
  return value as EpisodeDataset;
}
