import type { IterableArtifact, Runtime } from "../artifact";
import type { Disposable, JsonValue } from "../types";
import { InMemoryMemoryStore, type MemoryEntry } from "./store";

export const MEMORY_SERVICE = "mentat.memory";

/** A data artifact whose payload is the memory entries; the loop can iterate it. */
export function memoryArtifact(id: string, entries: MemoryEntry[]): IterableArtifact {
  return {
    kind: "memory",
    id,
    version: `memory:${entries.map((entry) => entry.id).join(",")}`,
    form: "data",
    apply: (runtime: Runtime): Disposable => {
      const store = new InMemoryMemoryStore();
      for (const entry of entries) store.add(entry);
      return runtime.provide(MEMORY_SERVICE, store);
    },
    snapshot: () => entries as unknown as JsonValue,
    evalSpec: () => ({ suite: "memory", cases: [id], metrics: ["recall"] }),
  };
}
