import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { JsonFileMemoryStore } from "./json-memory-store";

const entry = (id: string, text: string): MemoryEntry => ({ id, text, createdAt: 0 });

describe("JsonFileMemoryStore", () => {
  it("persists across instances and forgets", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mentat-mem-")), "memory.json");
    const first = new JsonFileMemoryStore(path);
    first.add(entry("m1", "the build takes 3 minutes"));
    first.add(entry("m2", "deploy target is staging"));

    const second = new JsonFileMemoryStore(path);
    expect(
      second
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["m1", "m2"]);
    expect(second.search({ text: "build" })[0]?.id).toBe("m1");

    expect(second.forget("m1")).toBe(true);
    const third = new JsonFileMemoryStore(path);
    expect(third.list().map((e) => e.id)).toEqual(["m2"]);
  });
});
