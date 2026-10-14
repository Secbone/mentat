import type { MemoryStore } from "./store";

export interface MemoryContextOptions {
  limit?: number;
  maxChars?: number;
  /** Include unconfirmed candidates, clearly marked (default: false). */
  includeCandidate?: boolean;
}

/**
 * Retrieve memories relevant to the task and format them as a stable context
 * block ("fast weights" read). Only currently-valid entries are surfaced by
 * default: candidates (e.g. model-inferred suggestions) are excluded unless
 * `includeCandidate` is set, and superseded/expired/archived entries never are.
 * Returns "" when nothing relevant is found.
 */
export function buildMemoryContext(
  store: MemoryStore,
  taskText: string,
  options: MemoryContextOptions = {},
): string {
  const limit = options.limit ?? 5;
  const maxChars = options.maxChars ?? 2000;
  const statuses = options.includeCandidate
    ? (["active", "candidate"] as const)
    : (["active"] as const);
  const entries = store.search({ text: taskText, limit, statuses: [...statuses] });
  if (entries.length === 0) return "";

  const block = [
    "Relevant memory (from previous tasks):",
    ...entries.map((e) => `${e.status === "candidate" ? "- (unconfirmed) " : "- "}${e.text}`),
  ]
    .join("\n")
    .trim();
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}
