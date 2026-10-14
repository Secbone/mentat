import { describe, expect, it } from "vitest";
import { applyEvolvedMemory, memoryEntry, runMemoryEvolutionDemo } from "./evolution";
import { MemoryService } from "./service";
import { InMemoryMemoryStore, type MemoryEntry } from "./store";

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

describe("applyEvolvedMemory", () => {
  it("routes results through MemoryService: user facts active, agent proposals candidate", () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    expect(
      applyEvolvedMemory(
        service,
        [memoryEntry("m1", "build takes 3 minutes")],
        "user",
        "evolve:test",
      ),
    ).toBe(1);
    const fact = store.list().find((entry) => entry.text === "build takes 3 minutes");
    expect(fact?.status).toBe("active");
    expect(fact?.basis).toBe("user");
    expect(fact?.evidence).toBe("evolve:test");

    expect(
      applyEvolvedMemory(service, [memoryEntry("m2", "maybe use blue-green deploys")], "agent"),
    ).toBe(1);
    const proposal = store.list().find((entry) => entry.text === "maybe use blue-green deploys");
    expect(proposal?.status).toBe("candidate");
    expect(proposal?.basis).toBe("inference");

    // Re-applying the same fact dedups instead of duplicating.
    expect(applyEvolvedMemory(service, [memoryEntry("m1", "build takes 3 minutes")], "user")).toBe(
      0,
    );
    expect(store.list()).toHaveLength(2);
  });
});
