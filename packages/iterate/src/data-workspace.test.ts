import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Candidate, type MemoryEntry, memoryArtifact, memoryEntry } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { type ArtifactSnapshot, JsonStoreWorkspace } from "./data-workspace";

const rebuild = (snapshot: ArtifactSnapshot) =>
  memoryArtifact(snapshot.id, snapshot.snapshot as unknown as MemoryEntry[]);

const rootCandidate = (): Candidate => ({
  id: "root",
  version: "root",
  artifacts: [memoryArtifact("memory", [])],
});

describe("JsonStoreWorkspace", () => {
  it("persists a candidate and rolls back to the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const workspace = new JsonStoreWorkspace(dir, rootCandidate());

    const child = await workspace.apply({
      id: "c1",
      description: "add memory",
      artifacts: [memoryArtifact("memory", [memoryEntry("m1", "hello")])],
    });
    expect(workspace.current().id).toBe("c1");
    expect(readFileSync(join(dir, "c1.json"), "utf8")).toContain('"m1"');

    await workspace.rollback(child);
    expect(workspace.current().id).toBe("root");
  });

  it("loads the active candidate from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const workspace = new JsonStoreWorkspace(dir, rootCandidate());
    const child = await workspace.apply({
      id: "c1",
      description: "add memory",
      artifacts: [memoryArtifact("memory", [memoryEntry("m1", "hello")])],
    });
    await workspace.commit(child);

    const loaded = JsonStoreWorkspace.load(dir, rebuild);
    expect(loaded?.id).toBe("c1");
    const entries = loaded?.artifacts[0]?.snapshot() as unknown as MemoryEntry[];
    expect(entries[0]?.id).toBe("m1");

    const emptyDir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    expect(JsonStoreWorkspace.load(emptyDir, rebuild)).toBeUndefined();
  });
});
