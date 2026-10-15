import { extractJson } from "@mentat/core";
import { AgentDataProposer, type Proposer } from "@mentat/evolution";
import type { MemoryEntry } from "@mentat/memory";
import { memoryArtifact, type RecallQuery } from "@mentat/memory-evolution";

/**
 * Build an agent-backed proposer for the memory artifact: it asks the Pi
 * harness for a revised entry set, optionally seeded with an experience digest.
 */
export function createAgentMemoryProposer(
  queries: RecallQuery[],
  runner: (prompt: string) => Promise<string>,
  digest = "",
): Proposer {
  return new AgentDataProposer({
    task: "evolve memory",
    cwd: process.cwd(),
    runner,
    buildPrompt: ({ parent, signals }) =>
      [
        "You maintain the memory store of a coding agent. Improve recall without adding noise.",
        `Queries that must be answerable (query -> expected memory id): ${JSON.stringify(queries)}`,
        `Current memory entries: ${JSON.stringify(parent.artifacts[0]?.snapshot() ?? [])}`,
        `Current signals: ${JSON.stringify(signals)}`,
        ...(digest
          ? ["", "What actually happened recently (use it to decide what memory to add):", digest]
          : []),
        'Return ONLY a JSON array of entries {"id":string,"text":string,"createdAt":number(epoch ms)}. Keep useful existing entries.',
      ].join("\n"),
    parse: (output) => {
      const parsed = extractJson(output);
      if (!Array.isArray(parsed)) throw new Error("memory proposer returned invalid entries");
      const entries = parsed as unknown as MemoryEntry[];
      return [memoryArtifact("memory", entries)];
    },
  });
}
