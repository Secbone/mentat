import { Context } from "@mentat/kernel";
import type { InMemoryMemoryStore } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { MEMORY_SERVICE, memoryArtifact, memoryArtifactRegistry } from "./artifact";

describe("memoryArtifact", () => {
  it("provides a memory store when materialized", async () => {
    const runtime = new Context();
    const artifact = memoryArtifact("mem", [{ id: "a", text: "hello world", createdAt: 1 }]);
    await memoryArtifactRegistry().materialize(artifact, runtime);
    const store = runtime.get<InMemoryMemoryStore>(MEMORY_SERVICE);
    expect(store.search({ text: "hello" })).toHaveLength(1);
    await runtime.dispose();
  });

  it("content-addresses the payload deterministically", () => {
    const first = memoryArtifact("mem", [{ id: "a", text: "hello", createdAt: 1 }]);
    const second = memoryArtifact("mem", [{ text: "hello", createdAt: 1, id: "a" }]);
    expect(first.ref.digest).toBe(second.ref.digest);
    expect(first.ref.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects a payload whose digest was changed", () => {
    const artifact = memoryArtifact("mem", [{ id: "a", text: "hello", createdAt: 1 }]);
    const tampered = {
      ...artifact,
      payload: [{ id: "a", text: "changed", createdAt: 1 }],
    };
    expect(() => memoryArtifactRegistry().validate(tampered)).toThrow("digest mismatch");
  });
});
