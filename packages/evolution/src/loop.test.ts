import { MemoryTracer } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { Archive } from "./archive";
import { knobArtifact as knob, knobRegistry } from "./demo";
import { type EvalTask, FunctionEvaluator } from "./evaluator";
import { functionGate } from "./gate";
import { SelfIterationLoop } from "./loop";
import { type ProposeStep, ScriptedProposer } from "./proposer";
import { defineEvalProtocol } from "./protocol";
import type { IterationReceipt } from "./receipt";
import type { Candidate } from "./types";
import { InMemoryWorkspace } from "./workspace";

const readKnob: EvalTask = {
  id: "read-knob",
  metrics: ["knob"],
  run: (runtime) => [
    { name: "knob", value: runtime.get<number>("knob"), direction: "higher-better" },
  ],
};

function propose(value: number): ProposeStep {
  return () => ({
    id: `cand-${value}`,
    description: `set knob to ${value}`,
    artifacts: [knob(value)],
  });
}

function root(value = 1): Candidate {
  return { id: "root", version: "root", artifacts: [knob(value)] };
}

function resultDigest(candidate: Candidate): string | undefined {
  return candidate.artifacts[0]?.ref.digest;
}

function signalValue(signals: { name: string; value: number }[] | undefined): number | undefined {
  return signals?.find((signal) => signal.name === "knob")?.value;
}

describe("SelfIterationLoop", () => {
  it("counts consecutive failures and resets the failure budget after acceptance", async () => {
    const result = await new SelfIterationLoop({
      workspace: new InMemoryWorkspace(root()),
      proposer: new ScriptedProposer([propose(0), propose(2), propose(1), propose(3)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      config: { maxIterations: 4, maxFailures: 2 },
    }).run();
    expect(result.records).toHaveLength(4);
    expect(result.best.id).toBe("cand-3");
  });
  it("keeps rejected tradeoffs for exploration without publishing them", async () => {
    const workspace = new InMemoryWorkspace(root());
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: {
        evaluate: async (c) => [
          { name: "quality", value: c.id === "root" ? 0.5 : 1, direction: "higher-better" },
          { name: "noise", value: c.id === "root" ? 0 : 0.4, direction: "lower-better" },
        ],
      },
      config: { maxIterations: 1 },
    });
    const result = await loop.run();
    expect(result.records[0]?.accepted).toBe(false);
    expect(result.archive.best()?.id).toBe("cand-2");
    expect(result.best.id).toBe("root");
    expect(workspace.current().id).toBe("root");
  });

  it("rejects deletion and forged replacement of protected artifacts", async () => {
    for (const artifacts of [undefined, [], [knob(1)], [knob(99, { protected: true })]]) {
      const workspace = new InMemoryWorkspace({
        ...root(),
        artifacts: [knob(1, { protected: true })],
      });
      const result = await new SelfIterationLoop({
        workspace,
        proposer: new ScriptedProposer([() => ({ id: "bad", description: "bypass", artifacts })]),
        evaluator: new FunctionEvaluator([readKnob], knobRegistry),
        config: { maxIterations: 1 },
      }).run();
      expect(result.records[0]?.reason).toBe("protected artifact");
    }
  });

  it("rolls back an evaluated candidate with an incomplete metric vector", async () => {
    const workspace = new InMemoryWorkspace(root());
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: {
        evaluate: async (c) =>
          c.id === "root"
            ? [
                { name: "quality", value: 1, direction: "higher-better" },
                { name: "safety", value: 1, direction: "higher-better" },
              ]
            : [{ name: "quality", value: 2, direction: "higher-better" }],
      },
      config: { maxIterations: 1 },
    });
    await expect(loop.run()).rejects.toThrow("metric contract changed");
    expect(workspace.current().id).toBe("root");
  });
  it("accepts an improvement, then rolls back a regression, keeping lineage", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2), propose(0)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      config: { maxIterations: 2 },
    });

    const result = await loop.run();

    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.accepted).toBe(true);
    expect(signalValue(result.records[0]?.after)).toBe(2);
    expect(result.records[1]?.accepted).toBe(false);
    expect(result.records[1]?.reason).toBe("no improvement");

    // root + accepted child + rejected child are all archived (stepping stones)
    expect(result.archive.size()).toBe(3);
    expect(result.archive.get("cand-2")?.parentId).toBe("root");
    expect(result.best.artifacts[0]?.payload).toBe(2);

    // the regression was rolled back: active state is still the improved child
    expect(workspace.current().id).toBe("cand-2");
  });

  it("rejects a change that fails a gate without evaluating or archiving it", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(10)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      gates: functionGate("max", (candidate) => Number(candidate.artifacts[0]?.payload) <= 5),
      config: { maxIterations: 1 },
    });

    const result = await loop.run();

    expect(result.records[0]?.accepted).toBe(false);
    expect(result.records[0]?.gate?.passed).toBe(false);
    expect(result.records[0]?.after).toBeUndefined();
    expect(result.archive.size()).toBe(1);
    expect(workspace.current().id).toBe("root");
  });

  it("blocks modification of protected artifacts", async () => {
    const workspace = new InMemoryWorkspace({
      id: "root",
      version: "root",
      artifacts: [knob(1, { protected: true })],
    });
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      config: { maxIterations: 1 },
    });

    const result = await loop.run();

    expect(result.records[0]?.accepted).toBe(false);
    expect(result.records[0]?.reason).toBe("protected artifact");
    expect(workspace.current().id).toBe("root");
  });

  it("branches from an archived stepping stone in archive mode", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const archive = new Archive(() => 0.0);
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(3), propose(2)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      archive,
      config: { maxIterations: 2, parentSelection: "archive" },
    });

    const result = await loop.run();

    expect(result.records[0]?.accepted).toBe(true);
    expect(result.records[0]?.childId).toBe("cand-3");
    // second iteration branches from the root stepping stone, not the latest
    expect(result.records[1]?.parentId).toBe("root");
    expect(result.records[1]?.accepted).toBe(true);
  });

  it("emits a receipt that binds the change, signals and protocol", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const protocol = defineEvalProtocol({ id: "knob", version: 1, mode: "metric" });
    const receipts: IterationReceipt[] = [];
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      protocol,
      environment: "test",
      config: { maxIterations: 1 },
      onReceipt: (receipt) => receipts.push(receipt),
    });

    await loop.run();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.accepted).toBe(true);
    expect(receipts[0]?.protocol?.digest).toBe(protocol.digest);
    expect(receipts[0]?.candidate.artifacts[0]?.digest).toBe(resultDigest(workspace.current()));
  });

  it("emits a structured trace of every step", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const tracer = new MemoryTracer();
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: new FunctionEvaluator([readKnob], knobRegistry),
      config: { maxIterations: 1 },
      tracer,
    });

    await loop.run();

    const types = tracer.types();
    expect(types).toContain("loop.start");
    expect(types).toContain("iteration.propose");
    expect(types).toContain("iteration.apply");
    expect(types).toContain("iteration.gate");
    expect(types).toContain("iteration.select");
    expect(types).toContain("loop.end");
    expect(tracer.find("iteration.select")[0]?.data).toMatchObject({ accepted: true });
  });
});

it("records failed evaluation and rolls back the materialized candidate", async () => {
  const workspace = new InMemoryWorkspace(root());
  const tracer = new MemoryTracer();
  let calls = 0;
  const loop = new SelfIterationLoop({
    workspace,
    proposer: new ScriptedProposer([propose(2)]),
    evaluator: {
      async evaluate() {
        if (calls++) throw Error("evaluation crashed");
        return [{ name: "knob", value: 1, direction: "higher-better" }];
      },
    },
    tracer,
    config: { maxIterations: 1 },
  });
  await expect(loop.run()).rejects.toThrow("evaluation crashed");
  expect(workspace.current().id).toBe("root");
  expect(tracer.types()).toContain("workspace.rollback.end");
});
it("records successful commits and failed rollback explicitly", async () => {
  const tracer = new MemoryTracer();
  const workspace = new InMemoryWorkspace(root());
  const loop = new SelfIterationLoop({
    workspace,
    proposer: new ScriptedProposer([propose(2)]),
    evaluator: new FunctionEvaluator([readKnob], knobRegistry),
    tracer,
    config: { maxIterations: 1 },
  });
  await loop.run();
  expect(tracer.types()).toContain("workspace.commit.end");
  const bad = new InMemoryWorkspace(root());
  bad.rollback = async () => {
    throw Error("rollback crashed");
  };
  const rejected = new SelfIterationLoop({
    workspace: bad,
    proposer: new ScriptedProposer([propose(0)]),
    evaluator: new FunctionEvaluator([readKnob], knobRegistry),
    tracer,
    config: { maxIterations: 1 },
  });
  await expect(rejected.run()).rejects.toThrow("rollback crashed");
  expect(tracer.types()).toContain("workspace.rollback.error");
});
