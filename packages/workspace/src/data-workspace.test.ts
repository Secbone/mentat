import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IterableArtifact, JsonValue } from "@mentat/core";
import type { Candidate } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { type ArtifactSnapshot, JsonStoreWorkspace } from "./data-workspace";

/** A trivial data artifact used to exercise the generic store. */
function jsonArtifact(id: string, payload: JsonValue): IterableArtifact {
  return {
    kind: "memory",
    id,
    version: `${id}:${JSON.stringify(payload)}`,
    form: "data",
    apply: () => ({ dispose: () => {} }),
    snapshot: () => payload,
    evalSpec: () => ({ suite: "json", cases: [id], metrics: ["size"] }),
  };
}

const rebuild = (snapshot: ArtifactSnapshot) => jsonArtifact(snapshot.id, snapshot.snapshot);

const rootCandidate = (): Candidate => ({
  id: "root",
  version: "root",
  artifacts: [jsonArtifact("memory", [])],
});

describe("JsonStoreWorkspace", () => {
  it("persists a candidate and rolls back to the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const workspace = new JsonStoreWorkspace(dir, rootCandidate());

    const child = await workspace.apply({
      id: "c1",
      description: "add entry",
      artifacts: [jsonArtifact("memory", [{ id: "m1", text: "hello" }])],
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
      description: "add entry",
      artifacts: [jsonArtifact("memory", [{ id: "m1", text: "hello" }])],
    });
    await workspace.commit(child);

    const loaded = JsonStoreWorkspace.load(dir, rebuild);
    expect(loaded?.id).toBe("c1");
    const entries = loaded?.artifacts[0]?.snapshot() as unknown as Array<{ id: string }>;
    expect(entries[0]?.id).toBe("m1");

    const emptyDir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    expect(JsonStoreWorkspace.load(emptyDir, rebuild)).toBeUndefined();
  });
});
