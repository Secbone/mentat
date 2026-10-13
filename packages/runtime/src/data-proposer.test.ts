import type { Candidate, IterableArtifact } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { AgentDataProposer } from "./data-proposer";

describe("AgentDataProposer", () => {
  it("turns the agent output into a proposal", async () => {
    const parent: Candidate = { id: "root", version: "root", artifacts: [] };
    const artifact: IterableArtifact = {
      kind: "memory",
      id: "memory",
      version: "v",
      form: "data",
      apply: () => ({ dispose: () => {} }),
      snapshot: () => [{ id: "m1" }],
      evalSpec: () => ({ suite: "s", cases: [], metrics: [] }),
    };
    const proposer = new AgentDataProposer({
      task: "evolve memory",
      cwd: "/tmp",
      runner: async () => '```json\n[{"id":"m1"}]\n```',
      buildPrompt: ({ task }) => `task: ${task}`,
      parse: () => [artifact],
    });

    const proposal = await proposer.propose(parent, []);
    expect(proposal.artifacts?.[0]?.snapshot()).toEqual([{ id: "m1" }]);
  });
});
