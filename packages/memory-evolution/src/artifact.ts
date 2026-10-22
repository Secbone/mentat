import {
  type Artifact,
  type ArtifactAdapter,
  type ArtifactRegistry,
  type CreateArtifactOptions,
  createArtifact,
  createArtifactRegistry,
  type Disposable,
  type JsonValue,
} from "@mentat/core";
import type { Candidate } from "@mentat/evolution";
import { InMemoryMemoryStore, type MemoryEntry } from "@mentat/memory";

export const MEMORY_SERVICE = "mentat.memory";

function invalid(reason: string): never {
  throw new Error(`invalid memory artifact: ${reason}`);
}

/**
 * Validate and normalize the JSON payload of a memory artifact. Kept in one
 * place so the adapter, the gate and disk loading agree on the schema.
 */
export function parseMemoryEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) invalid("payload is not an array");
  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("entry is not an object");
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0)
      invalid("entry.id must be a non-empty string");
    if (typeof entry.text !== "string") invalid("entry.text must be a string");
    if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt))
      invalid("entry.createdAt must be finite");
    if (seen.has(entry.id)) invalid(`duplicate entry id: ${entry.id}`);
    seen.add(entry.id);
    entries.push(value as unknown as MemoryEntry);
  }
  return entries;
}

/** Data artifact adapter for the memory entry set. */
export const memoryAdapter: ArtifactAdapter<MemoryEntry[]> = {
  kind: "memory",
  form: "data",
  parse: parseMemoryEntries,
  snapshot: (entries): JsonValue => entries as unknown as JsonValue,
  restore: (snapshot): MemoryEntry[] => parseMemoryEntries(snapshot),
  materialize: (entries, host): Disposable => {
    const store = new InMemoryMemoryStore();
    for (const entry of entries) store.add(entry);
    return host.provide(MEMORY_SERVICE, store);
  },
  diff: (before, after) => {
    const beforeIds = new Set(before.map((entry) => entry.id));
    const afterIds = new Set(after.map((entry) => entry.id));
    const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
    const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
    const changed = before.some((entry) => {
      const next = after.find((item) => item.id === entry.id);
      return next !== undefined && JSON.stringify(next) !== JSON.stringify(entry);
    });
    return {
      changed: added.length > 0 || removed.length > 0 || changed,
      summary: `+${added.length} -${removed.length}${changed ? " ~" : ""}`,
      details: { added, removed, changed },
    };
  },
};

/** Build an immutable memory artifact. */
export function memoryArtifact(
  id: string,
  entries: MemoryEntry[],
  options: CreateArtifactOptions = {},
): Artifact {
  return createArtifact(memoryAdapter, id, entries, options);
}

/** Read the typed entry set out of a candidate without unsafe casts at call sites. */
export function memoryEntries(candidate: Candidate, id = "memory"): MemoryEntry[] {
  const artifact = candidate.artifacts.find(
    (item) => item.ref.kind === "memory" && item.ref.id === id,
  );
  return artifact ? memoryAdapter.parse(artifact.payload) : [];
}

/** Registry containing the memory adapter, for evaluators and workspaces. */
export function memoryArtifactRegistry(): ArtifactRegistry {
  return createArtifactRegistry().register(memoryAdapter);
}
