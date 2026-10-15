import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMemoryStore } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { migrateLegacyMemory } from "./migration";

describe("migrateLegacyMemory", () => {
  it("snapshots first, marks legacy entries unconfirmed with unknown source, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mentat-mig-"));
    const snapshotPath = join(dir, "snapshot.json");
    const store = new InMemoryMemoryStore();
    store.add({ id: "a", text: "user likes dark mode", createdAt: 1 });
    store.add({ id: "b", text: "already active", createdAt: 2, status: "active" });

    const report = migrateLegacyMemory(store, { snapshotPath });
    expect(report).toEqual({ total: 2, migrated: 1, snapshotPath });

    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Array<{
      status?: string;
    }>;
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.status).toBeUndefined();

    const migrated = store.list().find((entry) => entry.id === "a");
    expect(migrated?.status).toBe("candidate");
    expect(migrated?.basis).toBe("unknown");
    expect(migrated?.key).toBe("user likes dark mode");
    expect(migrated?.revision).toBe(1);

    // Second run leaves everything untouched.
    expect(migrateLegacyMemory(store).migrated).toBe(0);
  });
});

it("migrates a file and its audit as a single recoverable batch", async () => {
  const { JsonFileMemoryStore } = await import("./json-memory-store");
  const dir = mkdtempSync(join(tmpdir(), "mentat-mig-file-"));
  const file = join(dir, "memory.json");
  const store = new JsonFileMemoryStore(file);
  store.add({ id: "a", text: "legacy a", createdAt: 1 });
  store.add({ id: "b", text: "legacy b", createdAt: 1 });
  expect(migrateLegacyMemory(store).migrated).toBe(2);
  const audit = readFileSync(`${file}.audit.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { transactionId: string });
  expect(audit).toHaveLength(2);
  expect(audit[0]?.transactionId).toBe(audit[1]?.transactionId);
  expect(store.list().every((entry) => entry.status === "candidate")).toBe(true);
});
