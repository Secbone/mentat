import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkJsonCriteria, validateCriteria } from "./criteria";
import { runEpisodes } from "./episodes";
import type { EpisodeDataset, RunPlan } from "./types";

describe("structured business checks", () => {
  const criteria = { all: [{ path: ["margin"], op: "gte" as const, value: 5 }], keys: ["margin"] };
  it("requires the whole answer, correct types and exact requested keys", () => {
    expect(checkJsonCriteria('{"margin":5}', criteria)).toBe(true);
    for (const answer of [
      '{"margin":"5"}',
      '{"margin":4}',
      '```json\n{"margin":5}\n```',
      '{"margin":5,"extra":true}',
    ])
      expect(checkJsonCriteria(answer, criteria)).toBe(false);
    expect(() => validateCriteria({ all: [{ path: ["__proto__"], op: "absent" }] })).toThrow(
      "path",
    );
  });
  it("runs feedback only after failure and preserves first-answer scores and final accounting", async () => {
    const p = JSON.parse(
      readFileSync(
        new URL("../../../benchmarks/examples/native-plan.json", import.meta.url),
        "utf8",
      ),
    ) as RunPlan;
    p.protocol.arms = [{ id: "reset", memory: "reset" }];
    p.metrics = [
      {
        id: "quality",
        dimension: "task-quality",
        direction: "higher-better",
        unit: "ratio",
        min: 0,
        max: 1,
      },
      {
        id: "corrections",
        dimension: "interaction",
        direction: "lower-better",
        unit: "turns",
        min: 0,
        source: "runtime.correctiveTurns",
      },
    ];
    p.units = [false, true].map((_, i) => ({
      caseId: `c${i}`,
      familyId: `f${i}`,
      arm: "reset",
      repetition: 0,
      sourceId: `c${i}`,
      metricIds: ["quality", "corrections"],
    }));
    const d: EpisodeDataset = {
      schemaVersion: 1,
      episodes: p.units.map((u) => ({
        id: u.caseId,
        familyId: u.familyId,
        phase: "probe",
        turns: [
          { input: { text: "answer" } },
          { input: { text: "correct" }, when: { previousTurn: 0, unless: criteria } },
        ],
        checks: [
          {
            metricId: "quality",
            turn: 0,
            kind: "json-criteria",
            expected: JSON.stringify(criteria),
          },
        ],
      })),
    };
    const r = await runEpisodes(p, d, async ({ unit }) => ({
      turn: async (input) => ({
        text: JSON.stringify({ margin: unit.caseId === "c0" && input.text === "answer" ? 4 : 5 }),
        ok: true,
        costUsd: null,
        evidence: [],
      }),
      remember: async () => {},
      reflect: async () => ({ costUsd: null, evidence: [] }),
      close: async () => ({
        costUsd: 0.02,
        evidence: ["billing"],
        observations: { verified: true },
      }),
    }));
    expect(r.calls).toBe(3);
    expect(r.results.map((x) => x.metrics.quality?.value)).toEqual([0, 1]);
    expect(r.results.map((x) => x.metrics.corrections?.value)).toEqual([1, 0]);
    expect(r.results.every((x) => x.costUsd === 0.02 && x.observations?.verified === true)).toBe(
      true,
    );
  });
});
