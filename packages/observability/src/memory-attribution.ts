import { readTrajectory, resolveEventData } from "./trajectory";

/**
 * Aggregated memory-operation attribution for one trajectory. This is the
 * substrate-side account of what memory actually did during a run, so a failed
 * answer can be attributed to "not retrieved / not injected" versus "injected
 * but not followed" instead of a single opaque score.
 */
export interface MemoryAttribution {
  /** context.selection calls (memory injected into a turn). */
  injections: number;
  /** Entries actually placed in an injected context. */
  injectedEntries: number;
  /** Entries dropped for budget or task-local scope. */
  omittedEntries: number;
  /** Active constraints dropped because the budget could not fit them. */
  omittedRequired: number;
  /** memory.search calls (explicit reads). */
  searches: number;
  /** memory.write calls (proposals + confirmations). */
  writes: number;
  writeOps: Record<string, number>;
  /** reflection.end calls and their accepted/applied counts. */
  reflections: number;
  reflectionApplied: Record<string, number>;
  /** Imported-history retrieval selections (LongMemEval-style ingestion). */
  historySelections: number;
  /** Native experience recall, separate from imported historical data. */
  nativeSelections: number;
  nativeRetrievedEntries: number;
  /** Query chunks with a positive score (candidate evidence). */
  historyMatchedChunks: number;
  /** Reference pieces actually placed in the injected context. */
  historyRetrievedEntries: number;
}

const zero = (): MemoryAttribution => ({
  injections: 0,
  injectedEntries: 0,
  omittedEntries: 0,
  omittedRequired: 0,
  searches: 0,
  writes: 0,
  writeOps: {},
  reflections: 0,
  reflectionApplied: {},
  historySelections: 0,
  nativeSelections: 0,
  nativeRetrievedEntries: 0,
  historyMatchedChunks: 0,
  historyRetrievedEntries: 0,
});

function count(map: Record<string, number>, key: unknown): void {
  if (typeof key !== "string" || !key) return;
  map[key] = (map[key] ?? 0) + 1;
}

export function memoryAttribution(dir: string): MemoryAttribution {
  const out = zero();
  for (const event of readTrajectory(dir)) {
    const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
    if (!data) continue;
    switch (event.type) {
      case "context.selection":
        out.injections += 1;
        out.injectedEntries += Array.isArray(data.selectedIds) ? data.selectedIds.length : 0;
        out.omittedEntries += Array.isArray(data.omittedIds) ? data.omittedIds.length : 0;
        out.omittedRequired += Array.isArray(data.omittedRequiredIds)
          ? data.omittedRequiredIds.length
          : 0;
        break;
      case "memory.search":
        out.searches += 1;
        break;
      case "memory.write": {
        out.writes += 1;
        const result = data.result as { op?: unknown } | undefined;
        count(out.writeOps, result?.op);
        break;
      }
      case "reflection.end":
        out.reflections += 1;
        for (const key of ["added", "merged", "skipped", "rejected"])
          if (typeof data[key] === "number") out.reflectionApplied[key] = data[key] as number;
        break;
      case "experience.selection":
        out.nativeSelections += 1;
        out.nativeRetrievedEntries += Array.isArray(data.selectedIds) ? data.selectedIds.length : 0;
        break;
      case "history.selection":
        out.historySelections += 1;
        out.historyMatchedChunks +=
          typeof data.matchingChunks === "number" ? (data.matchingChunks as number) : 0;
        out.historyRetrievedEntries += Array.isArray(data.selectedIds)
          ? data.selectedIds.length
          : 0;
        break;
      default:
        break;
    }
  }
  return out;
}
