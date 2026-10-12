import { describe, expect, it } from "vitest";
import type { IterableArtifact, Signal } from "../artifact";
import { Archive } from "./archive";
import type { Candidate } from "./types";

function candidate(id: string, parentId?: string): Candidate {
  return {
    id,
    version: id,
    artifacts: [] as IterableArtifact[],
    ...(parentId ? { parentId } : {}),
  };
}

const score = (value: number): Signal[] => [{ name: "s", value, direction: "higher-better" }];

describe("Archive", () => {
  it("tracks lineage and child counts", () => {
    const archive = new Archive();
    archive.add(candidate("root"), { signals: score(0) });
    archive.add(candidate("child", "root"), { parentId: "root", signals: score(1) });
    expect(archive.get("root")?.children).toBe(1);
    expect(archive.get("child")?.parentId).toBe("root");
    expect(archive.size()).toBe(2);
  });

  it("best picks the highest selection score", () => {
    const archive = new Archive();
    archive.add(candidate("a"), { signals: score(1) });
    archive.add(candidate("b"), { signals: score(5) });
    expect(archive.best()?.id).toBe("b");
  });

  it("selectParent favors the higher score with a low random draw", () => {
    const archive = new Archive(() => 0.99);
    archive.add(candidate("a"), { signals: score(1) });
    archive.add(candidate("b"), { signals: score(10) });
    expect(archive.selectParent()?.id).toBe("b");
  });

  it("selectParent can pick a lower-scored stepping stone", () => {
    const archive = new Archive(() => 0.01);
    archive.add(candidate("a"), { signals: score(1) });
    archive.add(candidate("b"), { signals: score(10) });
    expect(archive.selectParent()?.id).toBe("a");
  });
});
