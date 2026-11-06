import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { PackArchive } from "./archive";
import { EvolutionLoop } from "./loop";
import { MatrixPackEvaluator } from "./matrix";
import { RulePackProposer } from "./proposer";
import type { PackEvaluator } from "./types";

const pack = (version: number) =>
  defineCapabilityPack({
    id: "worker",
    version,
    prompt: { system: `v${version}`, role: "worker" },
  });

function evaluator(values: Record<number, number>): PackEvaluator {
  return {
    async evaluate(candidate) {
      return [
        {
          name: "quality",
          value: values[candidate.version] ?? 0,
          direction: "higher-better",
        },
      ];
    },
  };
}

const observation = [
  {
    id: "obs-1",
    at: "2026-11-06T00:00:00.000Z",
    text: "retry once",
    kind: "failure" as const,
  },
];

describe("MatrixPackEvaluator", () => {
  it("namespaces every signal by worker", async () => {
    const matrix = new MatrixPackEvaluator([
      { worker: "opencode", evaluator: evaluator({ 1: 1, 2: 2 }) },
      { worker: "pi", evaluator: evaluator({ 1: 0.5, 2: 0.75 }) },
    ]);
    await expect(matrix.evaluate(pack(1))).resolves.toEqual([
      { name: "opencode.quality", value: 1, direction: "higher-better" },
      { name: "pi.quality", value: 0.5, direction: "higher-better" },
    ]);
  });

  it("accepts a candidate only when no worker regresses", async () => {
    const improving = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: new MatrixPackEvaluator([
        { worker: "opencode", evaluator: evaluator({ 1: 1, 2: 2 }) },
        { worker: "pi", evaluator: evaluator({ 1: 1, 2: 2 }) },
      ]),
      archive: new PackArchive(),
    });
    expect((await improving.run(pack(1), observation)).accepted).toBe(true);

    const regressing = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: new MatrixPackEvaluator([
        { worker: "opencode", evaluator: evaluator({ 1: 1, 2: 2 }) },
        { worker: "pi", evaluator: evaluator({ 1: 1, 2: 0.5 }) },
      ]),
      archive: new PackArchive(),
    });
    expect((await regressing.run(pack(1), observation)).accepted).toBe(false);
  });

  it("rejects empty or duplicate worker lists", () => {
    expect(() => new MatrixPackEvaluator([])).toThrow("at least one worker");
    expect(
      () =>
        new MatrixPackEvaluator([
          { worker: "pi", evaluator: evaluator({ 1: 1 }) },
          { worker: "pi", evaluator: evaluator({ 1: 1 }) },
        ]),
    ).toThrow("duplicate matrix worker");
  });
});
