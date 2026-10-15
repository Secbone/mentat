import { Context } from "@mentat/kernel";
import type { InMemoryMemoryStore } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { MEMORY_SERVICE, memoryArtifact } from "./artifact";

describe("memoryArtifact", () => {
  it("provides a memory store when applied", async () => {
    const runtime = new Context();
    const artifact = memoryArtifact("mem", [{ id: "a", text: "hello world", createdAt: 1 }]);
    await artifact.apply(runtime);
    const store = runtime.get<InMemoryMemoryStore>(MEMORY_SERVICE);
    expect(store.search({ text: "hello" })).toHaveLength(1);
    await runtime.dispose();
  });
});
