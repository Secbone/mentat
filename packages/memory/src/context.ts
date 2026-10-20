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
  selectedIds: string[];
  /** Observation metadata, separate from model-visible text. */
  sourceRefs?: Array<{
    id: string;
    scope?: string;
    state: string;
    version?: number;
    basis?: string;
    role?: string;
  }>;
  decisions: Array<{ id: string; selected: boolean; reason: string }>;
  budget: { maxChars: number; usedChars: number };
} {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0)
    throw new RangeError("invalid context budget");
  const active = store.list().filter((entry) => memoryStatus(entry) === "active");
  const excluded = active.filter((entry) => entry.applicability === "task");
  const all = active.filter((entry) => entry.applicability !== "task");
  // Until scope/condition evaluation exists, conservatively protect every
  // active constraint in this memory file. Tags remain a legacy fallback.
  const required = all.filter(
    (entry) => entry.kind === "constraint" || entry.tags?.includes("constraint"),
  );
  const requiredIds = required.map((entry) => entry.id);
  const pinned = all.filter((entry) =>
    entry.tags?.some((tag) => ["profile", "preference", "constraint"].includes(tag)),
  );
  const relevant = store
    .search({ text: taskText, statuses: ["active"] })
    .filter((entry) => entry.applicability !== "task")
    .slice(0, 5);
  const candidates = [
    ...required,
    ...pinned,
    ...relevant,
    ...all.toSorted((a, b) => b.createdAt - a.createdAt),
  ];
  const decisions: Array<{ id: string; selected: boolean; reason: string }> = excluded.map(
    (entry) => ({ id: entry.id, selected: false, reason: "task-local" }),
  );
  const selectedIds: string[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  const omittedIds: string[] = excluded.map((entry) => entry.id);
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
      applicability: entry.applicability,
      basis: entry.basis,
      tags: entry.tags ?? [],
    });
    const addedChars = line.length + (lines.length === 0 ? 0 : 1);
    if (size + addedChars > maxChars) {
      omittedIds.push(entry.id);
      decisions.push({ id: entry.id, selected: false, reason: "budget" });
      continue;
    }
    selectedIds.push(entry.id);
    decisions.push({
      id: entry.id,
      selected: true,
      reason: requiredIds.includes(entry.id)
        ? "required"
        : pinned.some((e) => e.id === entry.id)
          ? "pinned"
          : relevant.some((e) => e.id === entry.id)
            ? "retrieved"
            : "recent",
    });
    lines.push(line);
    size += addedChars;
  }
  return {
    text: lines.join("\n"),
    selectedIds,
    sourceRefs: all
      .filter((entry) => selectedIds.includes(entry.id))
      .map((entry) => ({
        id: entry.id,
        ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
        state: memoryStatus(entry),
        ...(entry.revision !== undefined ? { version: entry.revision } : {}),
        ...(entry.basis !== undefined ? { basis: entry.basis } : {}),
        ...(entry.speaker !== undefined ? { role: entry.speaker } : {}),
      })),
    decisions,
    budget: { maxChars, usedChars: size },
    omittedIds,
    requiredIds,
    omittedRequiredIds: omittedIds.filter((id) => requiredIds.includes(id)),
  };
}
