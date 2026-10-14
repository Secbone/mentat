import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyMemory } from "./migration";
import { InMemoryMemoryStore } from "./store";

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
