import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactAdapter,
  type ArtifactRegistry,
  createArtifact,
  createArtifactRegistry,
  type JsonValue,
} from "@mentat/core";
import type { Candidate } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { JsonStoreWorkspace } from "./data-workspace";

interface Row {
  id: string;
  text?: string;
}

const rowsAdapter: ArtifactAdapter<Row[]> = {
  kind: "memory",
  form: "data",
  parse(raw: unknown): Row[] {
    if (!Array.isArray(raw)) throw new Error("rows must be an array");
    return raw as Row[];
  },
  snapshot: (rows): JsonValue => rows as unknown as JsonValue,
  restore: (snapshot): Row[] => rowsAdapter.parse(snapshot),
  materialize: () => ({ dispose: () => {} }),
};

function registry(): ArtifactRegistry {
  return createArtifactRegistry().register(rowsAdapter);
}

function jsonArtifact(id: string, payload: Row[]) {
  return createArtifact(rowsAdapter, id, payload);
}

function rootCandidate(): Candidate {
  return { id: "root", version: "root", artifacts: [jsonArtifact("memory", [])] };
}

describe("JsonStoreWorkspace", () => {
  it("rejects a competing commit without rolling back the other writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-conflict-"));
    const artifacts = registry();
    const a = new JsonStoreWorkspace(dir, rootCandidate(), artifacts),
      b = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);
    const ca = await a.apply({ id: "a", description: "a", artifacts: [] });
    const cb = await b.apply({ id: "b", description: "b", artifacts: [] });
    await a.commit(ca);
    await expect(b.commit(cb)).rejects.toThrow("publication conflict");
    await b.rollback(cb);
    expect(JsonStoreWorkspace.load(dir, artifacts)?.id).toBe("a");
  });

  it("never overwrites a resumed root, and only resumes committed candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-resume-"));
    const artifacts = registry();
    const workspace = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);
    await expect(
      workspace.apply({ id: "root", description: "collision", artifacts: [] }),
    ).rejects.toThrow("immutable");
    const child = await workspace.apply({ id: "new", description: "pending", artifacts: [] });
    expect(JsonStoreWorkspace.load(dir, artifacts)?.id).toBe("root");
    await workspace.rollback(child);
    expect(JsonStoreWorkspace.load(dir, artifacts)?.id).toBe("root");
    await expect(
      workspace.apply({ id: "../escape", description: "invalid", artifacts: [] }),
    ).rejects.toThrow("identity");
  });

  it("persists candidates as content-addressed references, not inline payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const artifacts = registry();
    const workspace = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);

    const child = await workspace.apply({
      id: "c1",
      description: "add entry",
      artifacts: [jsonArtifact("memory", [{ id: "m1", text: "hello" }])],
    });
    expect(workspace.current().id).toBe("c1");

    const stored = readFileSync(join(dir, "c1.json"), "utf8");
    expect(stored).not.toContain('"hello"');
    expect(stored).toContain('"digest"');
    const refs = readdirSync(join(dir, "artifacts"));
    expect(refs).toHaveLength(2); // empty root + c1 payload
    const payloadFile = refs.find((file) =>
      readFileSync(join(dir, "artifacts", file), "utf8").includes("hello"),
    );
    expect(payloadFile).toBeDefined();

    await workspace.rollback(child);
    expect(workspace.current().id).toBe("root");
  });

  it("loads the active candidate from disk and rehydrates its payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const artifacts = registry();
    const workspace = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);
    const child = await workspace.apply({
      id: "c1",
      description: "add entry",
      artifacts: [jsonArtifact("memory", [{ id: "m1", text: "hello" }])],
    });
    await workspace.commit(child);

    const loaded = JsonStoreWorkspace.load(dir, artifacts);
    expect(loaded?.id).toBe("c1");
    expect(rowsAdapter.parse(loaded?.artifacts[0]?.payload)).toEqual([{ id: "m1", text: "hello" }]);

    const emptyDir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    expect(JsonStoreWorkspace.load(emptyDir, artifacts)).toBeUndefined();
  });

  it("detects a payload that was modified on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const artifacts = registry();
    const workspace = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);
    const child = await workspace.apply({
      id: "c1",
      description: "add entry",
      artifacts: [jsonArtifact("memory", [{ id: "m1", text: "hello" }])],
    });
    await workspace.commit(child);

    const files = readdirSync(join(dir, "artifacts"));
    const payloadFile = files.find((file) =>
      readFileSync(join(dir, "artifacts", file), "utf8").includes("hello"),
    );
    expect(payloadFile).toBeDefined();
    const path = join(dir, "artifacts", payloadFile as string);
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify([{ id: "m1", text: "tampered" }]));
    expect(() => JsonStoreWorkspace.load(dir, artifacts)).toThrow("digest mismatch");
  });

  it("refuses code artifacts in a data workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-data-"));
    const artifacts = registry();
    const workspace = new JsonStoreWorkspace(dir, rootCandidate(), artifacts);
    const codeAdapter: ArtifactAdapter<{ commit: string }> = {
      kind: "core",
      form: "code",
      parse: (raw) => raw as { commit: string },
      snapshot: (payload) => payload as unknown as JsonValue,
      restore: (snapshot) => codeAdapter.parse(snapshot),
      materialize: () => ({ dispose: () => {} }),
    };
    await expect(
      workspace.apply({
        id: "code",
        description: "code",
        artifacts: [createArtifact(codeAdapter, "workspace", { commit: "abc1234" })],
      }),
    ).rejects.toThrow("only stores data artifacts");
  });
});
