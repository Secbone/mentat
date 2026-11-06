import {
  type EpisodeDataset,
  type RunPlan,
  type SubjectFactory,
  validateDataset,
  validatePlan,
} from "@mentat/benchmark";
import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { BenchmarkPackEvaluator } from "./benchmark-evaluator";

const plan: RunPlan = validatePlan({
  schemaVersion: 1,
  benchmark: { id: "evaluator-test", version: "1", track: "smoke" },
  dataset: { revision: "1", sha256: "a".repeat(64), split: "smoke", source: "test" },
  scorer: { id: "rules", revision: "1", config: {} },
  protocol: {
    id: "episodes",
    revision: "1",
    config: {},
    arms: [{ id: "reset", memory: "reset" }],
    maxCalls: 2,
    turnTimeoutMs: 1000,
  },
  subject: {
    id: "mentat",
    revision: "1",
    codeSha256: "b".repeat(64),
    harness: "fake",
    harnessVersion: "1",
    model: "fake",
    modelVersion: "1",
    config: {},
  },
  metrics: [
    {
      id: "answer.exact",
      dimension: "task-quality",
      direction: "higher-better",
      unit: "ratio",
      min: 0,
      max: 1,
    },
  ],
  units: [
    {
      caseId: "echo",
      familyId: "echo",
      arm: "reset",
      repetition: 0,
      sourceId: "echo",
      metricIds: ["answer.exact"],
    },
  ],
});

const dataset: EpisodeDataset = validateDataset({
  schemaVersion: 1,
  episodes: [
    {
      id: "echo",
      familyId: "echo",
      phase: "probe",
      turns: [{ input: { text: "say pong" } }],
      checks: [{ metricId: "answer.exact", turn: 0, kind: "exact", expected: "pong" }],
    },
  ],
});

function subjectFor(pack: ReturnType<typeof defineCapabilityPack>): SubjectFactory {
  return async () => ({
    async turn() {
      return {
        text: pack.prompt.system?.includes("pong") ? "pong" : "nope",
        ok: true,
        costUsd: null,
        evidence: [],
      };
    },
    async remember() {},
    async reflect() {
      return { costUsd: null, evidence: [] };
    },
    async close() {
      return { costUsd: null, evidence: [] };
    },
  });
}

const pack = (system: string, version = 1) =>
  defineCapabilityPack({ id: "worker", version, prompt: { system, role: "worker" } });

describe("BenchmarkPackEvaluator", () => {
  it("turns macro-averaged episode metrics into named signals", async () => {
    const evaluator = new BenchmarkPackEvaluator({
      plan,
      dataset,
      createSubject: subjectFor,
      id: () => "run-1",
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    await expect(evaluator.evaluate(pack("base"))).resolves.toEqual([
      { name: "reset.answer.exact", value: 0, direction: "higher-better" },
    ]);
    await expect(evaluator.evaluate(pack("the passphrase is pong", 2))).resolves.toEqual([
      { name: "reset.answer.exact", value: 1, direction: "higher-better" },
    ]);
  });

  it("fails when no trial produced a measured value", async () => {
    const evaluator = new BenchmarkPackEvaluator({
      plan,
      dataset,
      createSubject: () => async () => ({
        async turn() {
          return { text: "pong", ok: false, costUsd: null, evidence: [] };
        },
        async remember() {},
        async reflect() {
          return { costUsd: null, evidence: [] };
        },
        async close() {
          return { costUsd: null, evidence: [] };
        },
      }),
    });
    await expect(evaluator.evaluate(pack("base"))).rejects.toThrow("no measured trials");
  });
});
