import { readFileSync } from "node:fs";
import { assert, summarizeRun, validatePlan } from "@mentat/benchmark";
import { describe, expect, it } from "vitest";
import { defaultResultAdapters } from "./adapters";
import { makeRun } from "./storage";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../benchmarks/examples/${name}.json`, import.meta.url), "utf8"),
  );

describe("upstream result adapters", () => {
  it("imports Harbor trial rewards and preserves missing billing", () => {
    const run = makeRun(
      validatePlan(fixture("harbor-plan")),
      fixture("harbor-trials"),
      "harbor-trials-v1",
    );
    expect(run.results.map((r) => r.metrics["task.success"]?.value)).toEqual([1, 0]);
    expect(summarizeRun(run).cost).toEqual({ knownUsd: 0.01, measured: 1, unknown: 1 });
  });
  it("does not turn absent verifier rewards or exception-bearing scores into success", () => {
    const input = fixture("harbor-trials");
    input[0].verifier_result = null;
    input[1].exception_info = { exception_type: "Timeout", exception_message: "fixture" };
    const run = makeRun(validatePlan(fixture("harbor-plan")), input, "harbor-trials-v1");
    expect(run.results[0]?.metrics["task.success"]?.value).toBeNull();
    expect(run.results[1]?.status).toBe("error");
    expect(run.results[1]?.metrics["task.success"]?.value).toBeNull();
  });
  it("rejects aggregate-only, multi-step and ambiguous/unplanned Harbor results", () => {
    const p = validatePlan(fixture("harbor-plan"));
    expect(() => makeRun(p, { stats: { mean: 1 } }, "harbor-trials-v1")).toThrow("identity");
    const input = fixture("harbor-trials");
    input[0].step_results = [{}];
    expect(() => makeRun(p, input, "harbor-trials-v1")).toThrow("multi-step");
    const q = structuredClone(p);
    required(q.units[1]).sourceId = required(q.units[0]).sourceId;
    expect(() => makeRun(q, fixture("harbor-trials"), "harbor-trials-v1")).toThrow("exactly once");
    const raw = fixture("harbor-trials");
    raw[0].task_name = "different-task";
    expect(() => makeRun(p, raw, "harbor-trials-v1")).toThrow("identity mismatch");
  });
  it("imports Inspect scores with explicit letter conversion and object-score paths", () => {
    const p = validatePlan(fixture("inspect-plan"));
    expect(
      makeRun(p, fixture("inspect-log"), "inspect-json-v1").results.map(
        (r) => r.metrics["task.success"]?.value,
      ),
    ).toEqual([1, 0]);
    required(p.metrics[0]).source = "rubric.pass";
    const raw = fixture("inspect-log");
    raw.samples.forEach((s: Record<string, unknown>) => {
      s.scores = { rubric: { value: { pass: 0.5 } } };
    });
    expect(makeRun(p, raw, "inspect-json-v1").results[0]?.metrics["task.success"]?.value).toBe(0.5);
  });
  it("requires explicit score semantics, sample identity and no duplicate attempts", () => {
    const p = validatePlan(fixture("inspect-plan"));
    delete required(p.metrics[0]).valueMap;
    expect(() => makeRun(p, fixture("inspect-log"), "inspect-json-v1")).toThrow("unmapped");
    expect(() => makeRun(p, { version: 2, results: {} }, "inspect-json-v1")).toThrow("per-sample");
    expect(() => makeRun(p, { version: 3, samples: [] }, "inspect-json-v1")).toThrow(
      "schema version",
    );
    const raw = fixture("inspect-log");
    raw.samples.push(raw.samples[0]);
    expect(() => makeRun(validatePlan(fixture("inspect-plan")), raw, "inspect-json-v1")).toThrow(
      "duplicate result",
    );
  });
  it("records incomplete Inspect samples and missing planned trials instead of excluding them", () => {
    const raw = fixture("inspect-log");
    raw.samples[0].completed = false;
    raw.samples.pop();
    const run = makeRun(validatePlan(fixture("inspect-plan")), raw, "inspect-json-v1");
    expect(run.results.every((r) => r.status === "missing")).toBe(true);
    expect(summarizeRun(run).metrics[0]).toMatchObject({
      planned: 2,
      measured: 0,
      unknown: 2,
      macroMean: null,
    });
  });
  it("registers new formats without changing runner or summary code", () => {
    const registry = defaultResultAdapters();
    registry.register({
      id: "test-new",
      version: "1",
      read: (_, p) =>
        defaultResultAdapters().get("harbor-trials-v1").read(fixture("harbor-trials"), p),
    });
    expect(
      makeRun(validatePlan(fixture("harbor-plan")), {}, "test-new", registry).results,
    ).toHaveLength(2);
    expect(() => registry.register(registry.get("test-new"))).toThrow("duplicate");
  });
});

function required<T>(value: T | undefined): T {
  assert(value !== undefined, "fixture required");
  return value;
}
