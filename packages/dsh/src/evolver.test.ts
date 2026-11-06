import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@mentat/core";
import type { PackEvaluator } from "@mentat/evolve";
import { defineCapabilityPack, packRef } from "@mentat/pack";
import { describe, expect, it } from "vitest";
import type { RuntimeReceipt } from "./runtime";
import { createMentatService } from "./service";

function evaluator(): PackEvaluator {
  return {
    async evaluate(pack): Promise<Signal[]> {
      return [{ name: "quality", value: pack.version, direction: "higher-better" }];
    },
  };
}

function receipt(
  assignment: string,
  kind: RuntimeReceipt["report"]["kind"],
  summary: string,
  outcome: RuntimeReceipt["outcome"] = "error",
  at = "2026-11-06T00:00:00.000Z",
): RuntimeReceipt {
  const pack = defineCapabilityPack({
    id: "worker",
    version: 1,
    prompt: { system: "worker" },
  });
  return {
    version: 1,
    at,
    trigger: "trigger-1",
    ticket: "ticket-1",
    assignment,
    worker: "opencode",
    packDigest: pack.digest,
    pack: packRef(pack),
    report: { kind, summary },
    events: 0,
    outcome,
  };
}

describe("MentatEvolver", () => {
  it("turns failed receipts into one deduplicated Dream observation", async () => {
    const service = createMentatService({
      dir: mkdtempSync(join(tmpdir(), "mentat-evolver-")),
      evaluator: evaluator(),
    });
    service.receipts.append(receipt("a1", "failed", "retry once before giving up"));
    service.receipts.append(receipt("a2", "failed", "retry once before giving up"));
    service.receipts.append(receipt("a3", "ready", "done", "completed"));

    const outcome = await service.evolver?.evolve();
    expect(outcome?.observations).toHaveLength(1);
    expect(outcome?.observations[0]).toMatchObject({
      id: "receipt:a1",
      kind: "failure",
      source: "receipt:a1",
    });
    expect(outcome?.result?.accepted).toBe(true);
    expect(service.packs.accepted()).toHaveLength(1);
    await service.runtime.dispose();
  });

  it("does not re-learn observations already named by an archived candidate", async () => {
    const service = createMentatService({
      dir: mkdtempSync(join(tmpdir(), "mentat-evolver-")),
      evaluator: evaluator(),
    });
    service.receipts.append(receipt("a1", "blocked", "worker timed out"));
    expect(await service.evolver?.evolve()).toMatchObject({
      observations: [{ id: "receipt:a1" }],
    });
    const second = await service.evolver?.evolve();
    expect(second?.observations).toEqual([]);
    expect(second?.result).toBeUndefined();
    await service.runtime.dispose();
  });

  it("uses only the newest observations when capped", async () => {
    const service = createMentatService({
      dir: mkdtempSync(join(tmpdir(), "mentat-evolver-")),
      evaluator: evaluator(),
      maxObservations: 1,
    });
    service.receipts.append(
      receipt("old", "failed", "old lesson", "error", "2026-11-05T00:00:00.000Z"),
    );
    service.receipts.append(
      receipt("new", "failed", "new lesson", "error", "2026-11-06T00:00:00.000Z"),
    );
    expect(service.evolver?.observe().map((row) => row.id)).toEqual(["receipt:new"]);
    await service.runtime.dispose();
  });
});
