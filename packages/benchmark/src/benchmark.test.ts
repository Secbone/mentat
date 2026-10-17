import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareArms, compareRuns, compareSubjects, summarizeRun } from "./analysis";
import { runEpisodes } from "./episodes";
import type { BenchmarkRun, SubjectFactory, TrialResult } from "./types";
import { assert, completeResults, validateDataset, validatePlan } from "./validation";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../benchmarks/examples/${name}.json`, import.meta.url), "utf8"),
  );
const plan = () => validatePlan(fixture("native-plan"));
const dataset = () => validateDataset(fixture("episodes"));
function row(value: number): TrialResult {
  return {
    caseId: "format-probe",
    familyId: "format",
    arm: "explicit",
    repetition: 0,
    status: "completed",
    metrics: { "protocol.echo": { value } },
    evidence: ["trace:fixture"],
    costUsd: null,
    durationMs: 1,
  };
}
function run(value = 1): BenchmarkRun {
  const p = plan();
  return {
    schemaVersion: 1,
    id: "fixture-run",
    createdAt: "2026-10-16T00:00:00Z",
    plan: p,
    provenance: {
      adapter: "fixture",
      adapterVersion: "1",
      artifactSha256: "0".repeat(64),
      execution: "imported",
      notes: [],
    },
    results: completeResults(p, [row(value)]),
  };
}

describe("benchmark validation and coverage", () => {
  it("fills every planned missing trial and score, without inventing zeros", () => {
    const r = run(),
      s = summarizeRun(r);
    expect(r.results).toHaveLength(8);
    expect(s.trials.missing).toBe(7);
    expect(s.metrics.find((m) => m.arm === "explicit")).toMatchObject({
      measured: 1,
      planned: 2,
      unknown: 1,
      macroMean: 1,
    });
    expect(s.cost).toMatchObject({ knownUsd: 0, measured: 0, unknown: 8 });
  });
  it("rejects duplicate, unexpected, failed and out-of-range measurements", () => {
    expect(() => completeResults(plan(), [row(1), row(1)])).toThrow("duplicate");
    expect(() => completeResults(plan(), [{ ...row(1), caseId: "alien" }])).toThrow("unplanned");
    expect(() => completeResults(plan(), [{ ...row(1), familyId: "alien" }])).toThrow("family");
    expect(() => completeResults(plan(), [{ ...row(1), status: "error" }])).toThrow(
      "cannot publish",
    );
    expect(() => completeResults(plan(), [row(Number.NaN)])).toThrow("finite");
    expect(() => completeResults(plan(), [row(2)])).toThrow("range");
  });
  it("requires pinned dataset/scorer identities and unambiguous plans", () => {
    const p = plan();
    p.scorer.revision = "latest";
    expect(() => validatePlan(p)).toThrow("pin");
    const q = plan();
    q.units.push(q.units[0] as never);
    expect(() => validatePlan(q)).toThrow("duplicate trial");
    const v = plan();
    required(v.metrics[0]).dimension = "invented" as never;
    expect(() => validatePlan(v)).toThrow("dimension");
  });
});

describe("paired analysis", () => {
  it("compares explicitly controlled projects while preserving backend and scoring equality", () => {
    const a = run(0),
      b = run(1);
    expect(() => compareSubjects(a, b)).toThrow("study id");
    for (const r of [a, b]) {
      r.plan.protocol.config.crossSubjectStudy = "fixed-study-1";
      r.plan.subject.config = {
        study: "fixed-study-1",
        method: { retrieval: r === a ? "native" : "bm25" },
      };
    }
    b.plan.subject.id = "other-project";
    expect(compareRuns(a, b).comparable).toBe(false);
    expect(compareSubjects(a, b).comparable).toBe(true);
    b.plan.subject.model = "different";
    expect(compareSubjects(a, b).comparable).toBe(false);
    b.plan.subject.model = a.plan.subject.model;
    b.plan.scorer.revision = "different";
    expect(compareSubjects(a, b).comparable).toBe(false);
  });
  it("allows project revision changes but rejects changes to data/scorer/model/selection", () => {
    const a = run(0),
      b = run(1);
    b.plan.subject.revision = "new";
    b.plan.subject.codeSha256 = "1".repeat(64);
    const compared = compareRuns(a, b);
    expect(compared.comparable).toBe(true);
    expect(compared.metrics.find((m) => m.arm === "explicit")).toMatchObject({
      delta: 1,
      paired: 1,
      planned: 2,
      unpaired: 1,
      confidence95: null,
    });
    for (const change of [
      (r: BenchmarkRun) => {
        r.plan.dataset.sha256 = "2".repeat(64);
      },
      (r: BenchmarkRun) => {
        r.plan.scorer.revision = "2";
      },
      (r: BenchmarkRun) => {
        r.plan.subject.model = "other";
      },
      (r: BenchmarkRun) => {
        r.plan.protocol.config.permission = "allow";
      },
      (r: BenchmarkRun) => {
        r.plan.units = r.plan.units.slice(1);
        r.results = r.results.slice(1);
      },
    ]) {
      const c = structuredClone(b);
      change(c);
      expect(compareRuns(a, c).comparable).toBe(false);
    }
  });
  it("pairs arms on cases rather than comparing differently difficult early and late tasks", () => {
    const r = run();
    r.results = completeResults(r.plan, [row(1), { ...row(0), arm: "reset" }]);
    const paired = compareArms(r, "reset", "explicit");
    expect(paired.comparable).toBe(true);
    expect(paired.metrics[0]).toMatchObject({ delta: 1, paired: 1 });
    r.plan.units = r.plan.units.filter((u) => u.caseId !== "format-probe" || u.arm !== "reset");
    r.results = r.results.filter((u) => u.caseId !== "format-probe" || u.arm !== "reset");
    expect(compareArms(r, "reset", "explicit").comparable).toBe(false);
  });
  it("uses a family macro mean instead of letting large families dominate", () => {
    const r = run();
    const first = row(1),
      other = { ...row(0), caseId: "constraint-probe", familyId: "constraint" };
    r.results = completeResults(r.plan, [first, other]);
    for (let i = 1; i < 5; i++) {
      r.plan.units.push({
        ...required(r.plan.units.find((u) => u.caseId === "format-probe" && u.arm === "explicit")),
        repetition: i,
      });
      r.results.push({ ...first, repetition: i });
    }
    expect(summarizeRun(r).metrics.find((m) => m.arm === "explicit")?.macroMean).toBe(0.5);
  });
  it("respects lower-better metrics when interpreting a version difference", () => {
    const a = run(0.8),
      b = run(0.2);
    for (const r of [a, b]) required(r.plan.metrics[0]).direction = "lower-better";
    const compared = compareRuns(a, b),
      metric = compared.metrics.find((m) => m.arm === "explicit");
    expect(metric?.delta).toBeCloseTo(-0.6);
    expect(metric?.improvement).toBeCloseTo(0.6);
  });
});

describe("longitudinal execution", () => {
  it("keeps state only within arm/family/repetition; uses fresh subjects and typed confirmation", async () => {
    const states: Array<{ key: string; caseId: string; scope: string }> = [],
      rules: unknown[] = [],
      seen: unknown[] = [];
    let closed = 0;
    const factory: SubjectFactory = async (context) => {
      states.push({ key: context.stateKey, caseId: context.unit.caseId, scope: context.memory });
      expect(context.unit.metricIds).toEqual([]);
      return {
        turn: async (input) => {
          seen.push(input);
          return { text: `fake: ${input.text}`, ok: true, costUsd: 0, evidence: ["trace"] };
        },
        remember: async (rule) => {
          rules.push(rule);
        },
        reflect: async () => ({ costUsd: 0, evidence: [] }),
        close: async () => {
          closed++;
        },
      };
    };
    const result = await runEpisodes(plan(), dataset(), factory);
    expect(result.calls).toBe(8);
    expect(closed).toBe(8);
    expect(result.results.every((r) => r.status === "completed")).toBe(true);
    const selected = states.filter((x) => x.scope === "explicit" && x.caseId.startsWith("format"));
    expect(selected[0]?.key).toBe(selected[1]?.key);
    expect(new Set(states.filter((x) => x.scope === "reset").map((x) => x.key)).size).toBe(4);
    expect(rules).toContainEqual(expect.objectContaining({ kind: "constraint" }));
    expect(JSON.stringify(seen)).not.toContain("expected");
    expect(JSON.stringify(seen)).not.toContain("metricId");
  });
  it("retains unknown costs, stops at budget, and records all unexecuted planned units", async () => {
    const p = plan();
    p.protocol.maxCalls = 1;
    let opens = 0;
    const factory: SubjectFactory = async () => {
      opens++;
      return {
        turn: async () => ({ text: "okay", ok: true, costUsd: null, evidence: [] }),
        remember: async () => {},
        reflect: async () => ({ costUsd: null, evidence: [] }),
        close: async () => {},
      };
    };
    const result = await runEpisodes(p, dataset(), factory);
    expect(opens).toBe(1);
    expect(result.results).toHaveLength(8);
    expect(result.results.filter((r) => r.status === "missing")).toHaveLength(7);
    expect(result.results[0]?.costUsd).toBeNull();
  });
  it("charges reflection against the call budget and keeps failed-call billing unknown", async () => {
    const p = plan();
    p.protocol.arms = [{ id: "reflect", memory: "reflect" }];
    p.units = p.units.filter((u) => u.arm === "explicit").map((u) => ({ ...u, arm: "reflect" }));
    let reflections = 0,
      closes = 0;
    const result = await runEpisodes(p, dataset(), async () => ({
      turn: async (input) => ({ text: input.text, ok: true, costUsd: 0.01, evidence: ["turn"] }),
      remember: async () => {},
      reflect: async () => {
        reflections++;
        throw new Error("reflection transport failed");
      },
      close: async () => {
        closes++;
      },
    }));
    expect(result.calls).toBe(8);
    expect(reflections).toBe(4);
    expect(closes).toBe(4);
    expect(result.results.every((r) => r.status === "completed")).toBe(true);
    expect(result.results.every((r) => r.reflection?.status === "error")).toBe(true);
    expect(result.results.every((r) => r.costUsd === null)).toBe(true);
  });
  it("blocks a failed learning branch but continues independent families, and closes subjects", async () => {
    const p = plan();
    p.units = p.units.filter((u) => u.arm === "explicit");
    const opened: string[] = [],
      closed: string[] = [];
    const result = await runEpisodes(p, dataset(), async ({ unit }) => {
      opened.push(unit.caseId);
      return {
        turn: async (input) => {
          if (unit.caseId === "format-learn") throw new Error("fixture failure");
          return { text: input.text, ok: true, costUsd: 0, evidence: [] };
        },
        remember: async () => {},
        reflect: async () => ({ costUsd: 0, evidence: [] }),
        close: async () => {
          closed.push(unit.caseId);
        },
      };
    });
    expect(opened).not.toContain("format-probe");
    expect(closed).toEqual(opened);
    expect(result.results.map((r) => r.status)).toEqual([
      "error",
      "missing",
      "completed",
      "completed",
    ]);
  });
  it("fails invalid native bindings and upstream claims before opening a subject", async () => {
    const p = plan();
    p.benchmark.track = "upstream";
    await expect(
      runEpisodes(p, dataset(), async () => {
        throw new Error("must not open");
      }),
    ).rejects.toThrow("adapted or smoke");
    const d = dataset();
    required(required(required(d.episodes[0]).turns[0]).remember?.[0]).kind = "candidate" as never;
    expect(() => validateDataset(d)).toThrow("remember kind");
  });
});

function required<T>(value: T | undefined): T {
  assert(value !== undefined, "fixture required");
  return value;
}
