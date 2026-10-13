import { Context } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { MEMORY_SERVICE, memoryArtifact } from "./artifact";
import { InMemoryMemoryStore, type MemoryEntry } from "./store";

function entry(id: string, text: string, tags?: string[]): MemoryEntry {
  return { id, text, createdAt: 0, ...(tags ? { tags } : {}) };
}

describe("InMemoryMemoryStore", () => {
  it("searches by keyword overlap, ranked", () => {
    const store = new InMemoryMemoryStore();
    store.add(entry("a", "the build takes 3 minutes", ["perf"]));
    store.add(entry("b", "deploy uses docker"));
    expect(store.search({ text: "build minutes" })[0]?.id).toBe("a");
    expect(store.search({ text: "docker" })[0]?.id).toBe("b");
  });

  it("filters by tags and forgets", () => {
    const store = new InMemoryMemoryStore();
    store.add(entry("a", "x", ["perf"]));
    store.add(entry("b", "y", ["ui"]));
    expect(store.search({ tags: ["perf"] }).map((e) => e.id)).toEqual(["a"]);
    expect(store.forget("a")).toBe(true);
    expect(store.list().map((e) => e.id)).toEqual(["b"]);
  });
});

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
