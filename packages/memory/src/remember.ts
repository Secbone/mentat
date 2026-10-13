import type { MemoryEntry, MemoryStore } from "./store";

function hashId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return `mem-${(hash >>> 0).toString(36)}`;
}

/**
 * Rule-driven online memory write: add a fact unless an entry with identical
 * text already exists (id is content-addressed, so re-remembering is a no-op).
 * Returns the added entry, or undefined when it was empty or a duplicate.
 */
export function rememberFact(
  store: MemoryStore,
  text: string,
  now = Date.now(),
): MemoryEntry | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (store.list().some((entry) => entry.text === trimmed)) return undefined;
  const entry: MemoryEntry = { id: hashId(trimmed), text: trimmed, createdAt: now };
  store.add(entry);
  return entry;
}
