import { type AgentEvent, extractJson, type Proposer } from "@mentat/core";
import { type MemoryEntry, memoryArtifact, type RecallQuery } from "@mentat/memory";
import { AgentDataProposer } from "@mentat/runtime";
import { createPermissionHandler } from "./permission";
import { createDefaultRegistry } from "./registry";

/**
 * Build an agent-backed proposer for the memory artifact: it asks the Pi
 * harness for a revised entry set, optionally seeded with an experience digest.
 */
export function createAgentMemoryProposer(
  queries: RecallQuery[],
  model: string | undefined,
  digest = "",
): Proposer {
  const adapter = createDefaultRegistry("full").get("pi");
  const runner = async (prompt: string): Promise<string> => {
    const session = await adapter.createSession(
      { cwd: process.cwd(), ...(model ? { model } : {}) },
      { onPermission: createPermissionHandler("full") },
    );
    let text = "";
    try {
      const settled = new Promise<void>((resolve) => {
        session.subscribe((event: AgentEvent) => {
          if (event.type === "message.completed") text = event.message.text;
          else if (event.type === "run.settled") resolve();
        });
      });
      await session.send({ text: prompt });
      await settled;
    } finally {
      await session.dispose();
    }
    return text;
  };

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
      const entries = Array.isArray(parsed) ? (parsed as unknown as MemoryEntry[]) : [];
      return [memoryArtifact("memory", entries)];
    },
  });
}
