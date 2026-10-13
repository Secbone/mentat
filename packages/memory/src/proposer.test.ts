import type { Candidate } from "@mentat/core";
import { FunctionEvaluator, InMemoryWorkspace, SelfIterationLoop } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { memoryArtifact } from "./artifact";
import { memoryEntry, type RecallQuery, recallTask } from "./evolution";
import { RuleMemoryProposer } from "./proposer";

describe("RuleMemoryProposer", () => {
  it("adds useful entries, skips noise, and dedups", async () => {
    const queries: RecallQuery[] = [
      { query: "build time", expectId: "m-build" },
      { query: "deploy target", expectId: "m-deploy" },
    ];
    const candidates = [
      memoryEntry("m-build", "the build takes 3 minutes"),
      memoryEntry("m-noise", "unrelated note about coffee"),
      memoryEntry("m-deploy", "the deploy target is staging"),
    ];
    const root: Candidate = {
      id: "root",
      version: "root",
      artifacts: [memoryArtifact("memory", [])],
    };
    const loop = new SelfIterationLoop({
      workspace: new InMemoryWorkspace(root),
      proposer: new RuleMemoryProposer(candidates),
      evaluator: new FunctionEvaluator([recallTask(queries)]),
      config: { maxIterations: 3 },
    });

    const result = await loop.run();

    expect(result.records.map((record) => record.accepted)).toEqual([true, false, true]);
    const snapshot = result.best.artifacts[0]?.snapshot();
    const ids = (Array.isArray(snapshot) ? snapshot : [])
      .map((entry) => (entry as { id: string }).id)
      .sort();
    expect(ids).toEqual(["m-build", "m-deploy"]);
  });
});
