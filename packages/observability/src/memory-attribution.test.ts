import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryAttribution } from "./memory-attribution";
import { FileTrajectoryStore } from "./trajectory";

describe("memoryAttribution", () => {
  it("aggregates injections, reads, writes, reflections and history retrieval", async () => {
    const root = mkdtempSync(join(tmpdir(), "mentat-attr-"));
    const store = new FileTrajectoryStore(join(root, "trace"));
    store.emit("context.selection", {
      selectedIds: ["a", "b"],
      omittedIds: ["c"],
      omittedRequiredIds: [],
    });
    store.emit("memory.search", { query: {}, result: [] });
    store.emit("memory.write", { request: {}, result: { op: "add" } });
    store.emit("memory.write", { request: {}, result: { op: "dedup" } });
    store.emit("reflection.end", { status: "ok", added: 1, merged: 0, skipped: 2, rejected: 0 });
    store.emit("history.selection", { matchingChunks: 5, selectedIds: ["x", "y"] });
    await store.close();

    const attr = memoryAttribution(store.dir);
    expect(attr.injections).toBe(1);
    expect(attr.injectedEntries).toBe(2);
    expect(attr.omittedEntries).toBe(1);
    expect(attr.searches).toBe(1);
    expect(attr.writes).toBe(2);
    expect(attr.writeOps).toEqual({ add: 1, dedup: 1 });
    expect(attr.reflections).toBe(1);
    expect(attr.reflectionApplied.added).toBe(1);
    expect(attr.historySelections).toBe(1);
    expect(attr.historyMatchedChunks).toBe(5);
    expect(attr.historyRetrievedEntries).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
