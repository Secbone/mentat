import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryAudit, MemoryAuditRecord, MemoryEntry, MemoryStore } from "@mentat/memory";
import { normalizeKey } from "@mentat/memory";
import { JsonlMemoryAudit } from "./audit";
import { JsonFileMemoryStore } from "./json-memory-store";

export interface MemoryMigrationOptions {
  /** Where to write the pre-migration snapshot (no snapshot when omitted). */
  snapshotPath?: string;
  audit?: MemoryAudit;
  now?: number;
  /** Scope assigned to migrated legacy entries that lack one. */
  scope?: string;
}

export interface MemoryMigrationReport {
  total: number;
  migrated: number;
  snapshotPath?: string;
}

/**
 * Migrate legacy entries (those missing a `status`) to the unified schema
 * without inventing trust: each becomes an unconfirmed candidate with an unknown
 * source, keeps a stable key and revision, and the store is snapshotted first so
 * nothing is lost. Entries that already carry a status are left untouched, which
 * makes this idempotent.
 */
export function migrateLegacyMemory(
  store: MemoryStore,
  options: MemoryMigrationOptions = {},
): MemoryMigrationReport {
  if (store instanceof JsonFileMemoryStore) {
    if (options.audit && !(options.audit instanceof JsonlMemoryAudit))
      throw new Error("file migration requires a transactional file audit");
    return store.transaction(
      (view, audit) => migrateLegacyMemory(view, { ...options, audit }),
      options.audit?.path,
    );
  }
  const now = options.now ?? Date.now();
  const entries = store.list();
  if (options.snapshotPath && entries.length > 0) {
    mkdirSync(dirname(options.snapshotPath), { recursive: true });
    writeFileSync(options.snapshotPath, `${JSON.stringify(entries, null, 2)}\n`);
  }

  let migrated = 0;
  for (const entry of entries) {
    if (entry.status !== undefined) continue;
    const next: MemoryEntry = {
      ...entry,
      key: entry.key ?? normalizeKey(entry.text),
      basis: entry.basis ?? "unknown",
      status: "candidate",
      revision: entry.revision ?? 1,
      ...(options.scope && entry.scope === undefined ? { scope: options.scope } : {}),
    };
    store.add(next);
    migrated += 1;
    options.audit?.record({
      ts: now,
      op: "update",
      request: { text: entry.text, status: "candidate", basis: "unknown" },
      entry: next,
      previous: entry,
    } satisfies MemoryAuditRecord);
  }

  return {
    total: entries.length,
    migrated,
    ...(options.snapshotPath ? { snapshotPath: options.snapshotPath } : {}),
  };
}
