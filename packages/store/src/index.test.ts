import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread, Trigger } from "@mentat/domain";
import { describe, expect, it } from "vitest";
import { FileRepositories } from "./index";

function trigger(): Trigger {
  return {
    id: "t1",
    source: "local",
    thread: "th1",
    actor: "alice",
    bot: false,
    addressed: "mention",
    text: "hello",
    at: "2026-11-05T00:00:00.000Z",
  };
}

describe("FileRepositories", () => {
  it("persists and reloads domain records", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-store-"));
    const store = new FileRepositories(dir);
    store.triggers.save(trigger());
    const thread: Thread = {
      id: "th1",
      source: "local",
      triggers: ["t1"],
      pending: [],
      subscriptions: [],
    };
    store.threads.save(thread);
    expect(JSON.parse(readFileSync(store.path, "utf8")).triggers).toHaveLength(1);

    const reloaded = new FileRepositories(dir);
    expect(reloaded.triggers.get("t1")?.text).toBe("hello");
    expect(reloaded.threads.get("th1")?.triggers).toEqual(["t1"]);
  });

  it("rejects a corrupt collection instead of silently dropping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-store-"));
    const store = new FileRepositories(dir);
    store.persist();
    writeFileSync(store.path, JSON.stringify({ triggers: "nope" }));
    expect(() => new FileRepositories(dir)).toThrow("triggers is not an array");
  });
});
