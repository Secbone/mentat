import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@mentat/core";
import { defineCapabilityPack } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import { PackArchive } from "./archive";
import { functionGate, improvementGate } from "./gate";
import { DreamService, EvolutionLoop } from "./loop";
import { RulePackProposer } from "./proposer";
import type { Observation, PackEvaluator } from "./types";

function basePack() {
  return defineCapabilityPack({
    id: "worker",
    version: 1,
    prompt: { system: "do the work", role: "worker" },
  });
}

const observations: Observation[] = [
  {
    id: "o1",
    at: "2026-11-06T00:00:00.000Z",
    text: "always retry the failing test once",
    kind: "failure",
  },
];

function evaluator(quality: number, cost = 0.1): PackEvaluator {
  return {
    async evaluate(pack): Promise<Signal[]> {
      return [
        { name: "quality", value: pack.version === 1 ? 0.5 : quality, direction: "higher-better" },
        { name: "cost", value: cost, direction: "lower-better" },
      ];
    },
  };
}

describe("RulePackProposer", () => {
  it("bumps the version and appends reusable lessons", async () => {
    const base = basePack();
    const candidate = await new RulePackProposer().propose(base, observations);
    expect(candidate.version).toBe(2);
    expect(candidate.digest).not.toBe(base.digest);
    expect(candidate.prompt.system).toContain("always retry");
    expect(candidate.prompt.system).toContain("do the work");
  });
});

describe("EvolutionLoop", () => {
  it("accepts a Pareto improvement and archives it", async () => {
    const archive = new PackArchive();
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
      archive,
    });
    const result = await loop.run(basePack(), observations);
    expect(result.accepted).toBe(true);
    expect(result.candidate.status).toBe("accepted");
    expect(result.candidate.gate?.gate).toBe("improvement");
    expect(archive.accepted()).toHaveLength(1);
  });

  it("rejects a candidate that does not improve", async () => {
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.5),
    });
    const result = await loop.run(basePack(), observations);
    expect(result.accepted).toBe(false);
    expect(result.candidate.status).toBe("rejected");
    expect(result.candidate.reason).toBe("no improvement");
  });

  it("honours an additional gate", async () => {
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
      gates: functionGate("manual", () => false),
    });
    const result = await loop.run(basePack(), observations);
    expect(result.accepted).toBe(false);
    expect(result.gate.gate).toBe("manual");
  });

  it("keeps the default improvement gate when no gates are supplied", async () => {
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
      gates: improvementGate(),
    });
    expect((await loop.run(basePack(), observations)).accepted).toBe(true);
  });
});

describe("PackArchive", () => {
  it("persists candidates across instances", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mentat-pack-archive-")), "archive.json");
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
      archive: new PackArchive(path),
    });
    const result = await loop.run(basePack(), observations);
    const reloaded = new PackArchive(path);
    expect(reloaded.get(result.candidate.id)?.pack.digest).toBe(result.candidate.pack.digest);
    expect(reloaded.accepted()).toHaveLength(1);
  });
});

describe("DreamService", () => {
  it("returns the same propose/evaluate/gate/archive result", async () => {
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
    });
    const result = await new DreamService(loop).dream(basePack(), observations);
    expect(result.accepted).toBe(true);
    expect(result.candidate.pack.version).toBe(2);
  });
});

describe("Dream effects", () => {
  it("runs one Dream pass through the durable queue", async () => {
    const { EffectQueue } = await import("@mentat/effects");
    const { enqueueDream, registerDream } = await import("./queue");
    const queue = new EffectQueue({
      path: join(mkdtempSync(join(tmpdir(), "mentat-dream-queue-")), "effects.json"),
      now: () => new Date("2026-11-06T00:00:00.000Z"),
    });
    const loop = new EvolutionLoop({
      proposer: new RulePackProposer(),
      evaluator: evaluator(0.8),
    });
    const dream = new DreamService(loop);
    const results: unknown[] = [];
    registerDream(queue, dream, (result) => results.push(result));
    enqueueDream(queue, { base: basePack(), observations });
    await queue.runDue();
    expect(results).toHaveLength(1);
    expect(queue.idle()).toBe(true);
  });
});
