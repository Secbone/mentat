import { type ArtifactAdapter, createArtifact } from "@mentat/core";
import type { Candidate } from "@mentat/evolution";
import { describe, expect, it } from "vitest";
import { AgentDataProposer } from "./data-proposer";

interface Row {
  id: string;
}

const rowsAdapter: ArtifactAdapter<Row[]> = {
  kind: "memory",
  form: "data",
  parse(raw: unknown): Row[] {
    if (!Array.isArray(raw)) throw new Error("rows must be an array");
    return raw as Row[];
  },
  snapshot: (rows) => rows as unknown as import("@mentat/core").JsonValue,
  restore: (snapshot) => rowsAdapter.parse(snapshot),
  materialize: () => ({ dispose: () => {} }),
};

describe("AgentDataProposer", () => {
  it("turns the agent output into a proposal", async () => {
    const parent: Candidate = { id: "root", version: "root", artifacts: [] };
    const artifact = createArtifact(rowsAdapter, "memory", [{ id: "m1" }]);
    const proposer = new AgentDataProposer({
      task: "evolve memory",
      cwd: "/tmp",
      runner: async () => '```json\n[{"id":"m1"}]\n```',
      buildPrompt: ({ task }) => `task: ${task}`,
      parse: () => [artifact],
    });

    const proposal = await proposer.propose(parent, []);
    expect(proposal.artifacts?.[0]?.payload).toEqual([{ id: "m1" }]);
  });
});
