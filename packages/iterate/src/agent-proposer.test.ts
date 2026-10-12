import { describe, expect, it } from "vitest";
import { AgentProposer } from "./agent-proposer";

describe("AgentProposer", () => {
  it("runs the runner with a prompt derived from the signals", async () => {
    let captured = "";
    const proposer = new AgentProposer({
      task: "add a feature",
      cwd: "/tmp",
      runner: async (prompt) => {
        captured = prompt;
      },
    });

    const proposal = await proposer.propose({ id: "root", version: "root", artifacts: [] }, [
      { name: "tests", value: 2, direction: "higher-better" },
    ]);

    expect(proposal.description).toBe("add a feature");
    expect(captured).toContain("add a feature");
    expect(captured).toContain("tests=2");
  });
});
