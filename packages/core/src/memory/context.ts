import type { MemoryStore } from "./store";

export interface MemoryContextOptions {
  limit?: number;
  maxChars?: number;
}

/**
 * Retrieve memories relevant to the task and format them as a stable context
 * block ("fast weights" read). Returns "" when nothing relevant is found.
 */
export function buildMemoryContext(
  store: MemoryStore,
  taskText: string,
  options: MemoryContextOptions = {},
): string {
  const limit = options.limit ?? 5;
  const maxChars = options.maxChars ?? 2000;
  const entries = store.search({ text: taskText, limit });
  if (entries.length === 0) return "";

  const block = ["Relevant memory (from previous tasks):", ...entries.map((e) => `- ${e.text}`)]
    .join("\n")
    .trim();
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}
