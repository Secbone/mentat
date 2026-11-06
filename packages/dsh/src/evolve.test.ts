import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@mentat/core";
import type { PackEvaluator } from "@mentat/evolve";
import { describe, expect, it } from "vitest";
import { createMentatService } from "./service";

function evaluator(): PackEvaluator {
  return {
    async evaluate(pack): Promise<Signal[]> {
      return [
        {
          name: "quality",
          value: pack.version === 1 ? 1 : 2,
          direction: "higher-better",
        },
      ];
    },
  };
}

describe("Dream in the DSH service", () => {
  it("evaluates, gates and archives a candidate", async () => {
    const service = createMentatService({
      dir: mkdtempSync(join(tmpdir(), "mentat-dream-")),
      evaluator: evaluator(),
    });
    const result = await service.dream?.dream(service.runtime.currentPack, [
      {
        id: "obs-1",
        at: "2026-11-06T00:00:00.000Z",
        text: "retry once before giving up",
        kind: "failure",
      },
    ]);
    expect(result?.accepted).toBe(true);
    expect(result?.candidate.pack.version).toBe(2);
    expect(service.packs.accepted()).toHaveLength(1);
    await service.runtime.dispose();
  });
});
