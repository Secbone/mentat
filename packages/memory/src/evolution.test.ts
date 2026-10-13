import { describe, expect, it } from "vitest";
import { runMemoryEvolutionDemo } from "./evolution";
import type { MemoryEntry } from "./store";

describe("memory evolution (offline, data artifact)", () => {
  it("accepts useful memories and rolls back noise", async () => {
    const result = await runMemoryEvolutionDemo();

    expect(result.records).toHaveLength(3);
    expect(result.records[0]?.accepted).toBe(true); // add build memory
    expect(result.records[1]?.accepted).toBe(true); // add deploy memory
    expect(result.records[2]?.accepted).toBe(false); // noise rejected
    expect(result.records[2]?.reason).toBe("no improvement");

    const entries = result.best.artifacts[0]?.snapshot() as unknown as MemoryEntry[];
    expect(entries.map((entry) => entry.id).sort()).toEqual(["m-build", "m-deploy"]);

    const recall = result.records[1]?.after?.find((signal) => signal.name === "recall")?.value;
    expect(recall).toBe(1);
  });
});
