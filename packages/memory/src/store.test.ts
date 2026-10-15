import { describe, expect, it } from "vitest";
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

  it("filters by effective status", () => {
    const store = new InMemoryMemoryStore();
    store.add(entry("active", "build note"));
    store.add({ ...entry("candidate", "build guess"), status: "candidate" });
    store.add({ ...entry("archived", "build old"), status: "archived" });

    // Legacy (no status) and active only.
    expect(store.search({ statuses: ["active"] }).map((e) => e.id)).toEqual(["active"]);
    expect(
      store
        .search({ statuses: ["active", "candidate"] })
        .map((e) => e.id)
        .sort(),
    ).toEqual(["active", "candidate"]);
  });
});
