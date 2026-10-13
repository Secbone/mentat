import type { Candidate, EvalTask, Signal } from "@mentat/core";
import {
  FunctionEvaluator,
  InMemoryWorkspace,
  type LoopResult,
  type ProposeStep,
  ScriptedProposer,
  SelfIterationLoop,
} from "@mentat/core";
import { MEMORY_SERVICE, memoryArtifact } from "./artifact";
import type { InMemoryMemoryStore, MemoryEntry } from "./store";

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

function currentEntries(parent: Candidate): MemoryEntry[] {
  const snapshot = parent.artifacts[0]?.snapshot();
  return Array.isArray(snapshot) ? (snapshot as unknown as MemoryEntry[]) : [];
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
    evaluator: new FunctionEvaluator([recallTask(queries)]),
    config: { maxIterations: 3 },
  });
  return loop.run();
}
