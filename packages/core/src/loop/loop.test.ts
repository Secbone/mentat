import { describe, expect, it } from "vitest";
import type { IterableArtifact, Runtime } from "../artifact";
import { MemoryTracer } from "../trace";
import type { Disposable } from "../types";
import { Archive } from "./archive";
import { type EvalTask, FunctionEvaluator } from "./evaluator";
import { functionGate } from "./gate";
import { SelfIterationLoop } from "./loop";
import { type ProposeStep, ScriptedProposer } from "./proposer";
import type { Candidate } from "./types";
import { InMemoryWorkspace } from "./workspace";

function knob(value: number, options: { protected?: boolean } = {}): IterableArtifact {
  return {
    kind: "prompt",
    id: "knob",
    version: `knob:${value}`,
    form: "data",
    ...(options.protected ? { protected: true } : {}),
    apply: (runtime: Runtime): Disposable => runtime.provide("knob", value),
    snapshot: () => value,
    evalSpec: () => ({ suite: "knob", cases: ["knob"], metrics: ["knob"] }),
  };
}

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

function signalValue(signals: { name: string; value: number }[] | undefined): number | undefined {
  return signals?.find((signal) => signal.name === "knob")?.value;
}

describe("SelfIterationLoop", () => {
  it("accepts an improvement, then rolls back a regression, keeping lineage", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2), propose(0)]),
      evaluator: new FunctionEvaluator([readKnob]),
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
    expect(result.best.artifacts[0]?.snapshot()).toBe(2);

    // the regression was rolled back: active state is still the improved child
    expect(workspace.current().id).toBe("cand-2");
  });

  it("rejects a change that fails a gate without evaluating or archiving it", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(10)]),
      evaluator: new FunctionEvaluator([readKnob]),
      gates: functionGate("max", (candidate) => Number(candidate.artifacts[0]?.snapshot()) <= 5),
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
      evaluator: new FunctionEvaluator([readKnob]),
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
      evaluator: new FunctionEvaluator([readKnob]),
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

  it("emits a structured trace of every step", async () => {
    const workspace = new InMemoryWorkspace(root(1));
    const tracer = new MemoryTracer();
    const loop = new SelfIterationLoop({
      workspace,
      proposer: new ScriptedProposer([propose(2)]),
      evaluator: new FunctionEvaluator([readKnob]),
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
