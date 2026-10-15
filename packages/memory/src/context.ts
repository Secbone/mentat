import { type MemoryStore, memoryStatus } from "./store";

/** Build a bounded snapshot; selection policy can evolve without changing transports. */
export function buildTurnContext(
  store: MemoryStore,
  taskText: string,
  maxChars = 6000,
): {
  text: string;
  omittedIds: string[];
  requiredIds: string[];
  omittedRequiredIds: string[];
} {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0)
    throw new RangeError("invalid context budget");
  const all = store.list().filter((entry) => memoryStatus(entry) === "active");
  // Until scope/condition evaluation exists, conservatively protect every
  // active constraint in this memory file. Tags remain a legacy fallback.
  const required = all.filter(
    (entry) => entry.kind === "constraint" || entry.tags?.includes("constraint"),
  );
  const requiredIds = required.map((entry) => entry.id);
  const pinned = all.filter((entry) =>
    entry.tags?.some((tag) => ["profile", "preference", "constraint"].includes(tag)),
  );
  const candidates = [
    ...required,
    ...pinned,
    ...store.search({ text: taskText, limit: 5, statuses: ["active"] }),
    ...all.toSorted((a, b) => b.createdAt - a.createdAt),
  ];
  const seen = new Set<string>();
  const lines: string[] = [];
  const omittedIds: string[] = [];
  let size = 0;
  for (const entry of candidates) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const line = JSON.stringify({
      id: entry.id,
      text: entry.text,
      kind: entry.kind,
      scope: entry.scope,
      condition: entry.condition,
      basis: entry.basis,
      tags: entry.tags ?? [],
    });
    const addedChars = line.length + (lines.length === 0 ? 0 : 1);
    if (size + addedChars > maxChars) {
      omittedIds.push(entry.id);
      continue;
    }
    lines.push(line);
    size += addedChars;
  }
  return {
    text: lines.join("\n"),
    omittedIds,
    requiredIds,
    omittedRequiredIds: omittedIds.filter((id) => requiredIds.includes(id)),
  };
}

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
