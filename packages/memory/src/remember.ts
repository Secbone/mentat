import { MemoryService } from "./service";
import type { MemoryEntry, MemoryStore } from "./store";

/**
 * Rule-driven online memory write (a thin wrapper over {@link MemoryService}):
 * add a fact unless the same text/key already exists. Returns the written
 * entry, or undefined when the request was empty, a duplicate, or rejected.
 */
export function rememberFact(
  store: MemoryStore,
  text: string,
  now = Date.now(),
): MemoryEntry | undefined {
  const result = new MemoryService(store).write(
    { text, kind: "fact", basis: "user", speaker: "user" },
    now,
  );
  return result.op === "add" || result.op === "update" ? result.entry : undefined;
}
