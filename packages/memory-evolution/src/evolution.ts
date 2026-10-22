import { createArtifactRegistry, type Signal } from "@mentat/core";
import type { Candidate, EvalTask } from "@mentat/evolution";
import {
  FunctionEvaluator,
  InMemoryWorkspace,
  type LoopResult,
  type ProposeStep,
  ScriptedProposer,
  SelfIterationLoop,
} from "@mentat/evolution";
import type { InMemoryMemoryStore, MemoryEntry, MemoryService } from "@mentat/memory";
import { MEMORY_SERVICE, memoryAdapter, memoryArtifact, memoryEntries } from "./artifact";

/** A held-out query with the memory id we expect retrieval to surface. */
export interface RecallQuery {
  query: string;
  expectId: string;
}

export function memoryEntry(id: string, text: string, tags?: string[]): MemoryEntry {
  return { id, text, createdAt: 0, ...(tags ? { tags } : {}) };
}

/**
 * Objective memory signals: `recall` (higher is better) over a held-out query
 * set, and `noise` (lower is better) = fraction of stored entries that no query
 * needs. Adding a relevant memory raises recall; adding an irrelevant one only
 * raises noise, so the loop rejects it.
 */
export function recallTask(queries: RecallQuery[], topK = 1): EvalTask {
  return {
    id: "recall",
    metrics: ["recall", "noise"],
    run: (runtime): Signal[] => {
      const store = runtime.get<InMemoryMemoryStore>(MEMORY_SERVICE);
      const entries = store.list();
      let hits = 0;
      for (const query of queries) {
        const results = store.search({ text: query.query, limit: topK });
        if (results.some((entry) => entry.id === query.expectId)) hits += 1;
      }
      const relevant = new Set(queries.map((query) => query.expectId));
      const noiseCount = entries.filter((entry) => !relevant.has(entry.id)).length;
      return [
        {
          name: "recall",
          value: queries.length === 0 ? 0 : hits / queries.length,
          direction: "higher-better",
        },
        {
          name: "noise",
          value: noiseCount / Math.max(1, entries.length),
          direction: "lower-better",
        },
      ];
    },
  };
}

export type EvolveSource = "user" | "agent";

/**
 * Apply an offline-evolution result to the *live* memory through the same
 * {@link MemoryService} as every other write, so evolved memories get the same
 * source checks, key-based dedup/versioning and audit trail. User-supplied facts
 * are trusted (active); agent proposals are stored as unconfirmed candidates.
 * Returns the number of entries actually added or updated.
 */
export function applyEvolvedMemory(
  service: MemoryService,
  entries: MemoryEntry[],
  source: EvolveSource,
  evidence?: string,
): number {
  let applied = 0;
  for (const entry of entries) {
    const provenance =
      source === "agent"
        ? ({ kind: "method", basis: "inference", speaker: "assistant" } as const)
        : ({ basis: "user", speaker: "user" } as const);
    const result = service.write({
      text: entry.text,
      ...provenance,
      ...(entry.key ? { key: entry.key } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.condition ? { condition: entry.condition } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(evidence ? { evidence } : {}),
    });
    if (result.op === "add" || result.op === "update") applied += 1;
  }
  return applied;
}

function currentEntries(parent: Candidate): MemoryEntry[] {
  return memoryEntries(parent);
}

/** Mutation operator for memory: append one entry to the parent's entries (heredity). */
function addEntry(entry: MemoryEntry): ProposeStep {
  return (parent) => ({
    id: `add-${entry.id}`,
    description: `add memory ${entry.id}`,
    artifacts: [memoryArtifact("memory", [...currentEntries(parent), entry])],
  });
}

/**
 * Demonstrates offline evolution of a *data* artifact (memory): the proposer
 * mutates the entry set, the evaluator scores recall/noise on held-out queries,
 * and Pareto selection keeps useful memories and rolls back noise.
 */
export async function runMemoryEvolutionDemo(): Promise<LoopResult> {
  const queries: RecallQuery[] = [
    { query: "build time", expectId: "m-build" },
    { query: "deploy target", expectId: "m-deploy" },
  ];
  const root: Candidate = {
    id: "mem-root",
    version: "mem-root",
    artifacts: [memoryArtifact("memory", [])],
  };
  const loop = new SelfIterationLoop({
    workspace: new InMemoryWorkspace(root),
    proposer: new ScriptedProposer([
      addEntry(memoryEntry("m-build", "the build takes 3 minutes")),
      addEntry(memoryEntry("m-deploy", "the deploy target is staging")),
      addEntry(memoryEntry("m-noise", "unrelated note about coffee")),
    ]),
    evaluator: new FunctionEvaluator(
      [recallTask(queries)],
      createArtifactRegistry().register(memoryAdapter),
    ),
    config: { maxIterations: 3 },
  });
  return loop.run();
}
