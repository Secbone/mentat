import type { Disposable, IterableArtifact, Runtime } from "@mentat/core";
import { type EvalTask, FunctionEvaluator } from "./evaluator";
import { type LoopResult, SelfIterationLoop } from "./loop";
import { type ProposeStep, ScriptedProposer } from "./proposer";
import type { Candidate } from "./types";
import { InMemoryWorkspace } from "./workspace";

/** A trivial artifact whose single "knob" value is the thing being optimized. */
export function knobArtifact(value: number): IterableArtifact {
  return {
    kind: "prompt",
    id: "knob",
    version: `knob:${value}`,
    form: "data",
    apply: (runtime: Runtime): Disposable => runtime.provide("knob", value),
    snapshot: () => value,
    evalSpec: () => ({ suite: "knob", cases: ["knob"], metrics: ["knob"] }),
  };
}

export function readKnobTask(): EvalTask {
  return {
    id: "read-knob",
    metrics: ["knob"],
    run: (runtime) => [
      { name: "knob", value: runtime.get<number>("knob"), direction: "higher-better" },
    ],
  };
}

/**
 * Deterministic end-to-end demo of the loop: start at knob=1, try the given
 * values in order, accept improvements and roll back regressions. Used by the
 * CLI (`mentat loop demo`) and useful as a smoke test for the loop wiring.
 */
export async function runDemoLoop(values: number[] = [2, 0, 3]): Promise<LoopResult> {
  const root: Candidate = { id: "root", version: "root", artifacts: [knobArtifact(1)] };
  const steps: ProposeStep[] = values.map((value) => () => ({
    id: `cand-${value}`,
    description: `set knob to ${value}`,
    artifacts: [knobArtifact(value)],
  }));

  const loop = new SelfIterationLoop({
    workspace: new InMemoryWorkspace(root),
    proposer: new ScriptedProposer(steps),
    evaluator: new FunctionEvaluator([readKnobTask()]),
    config: { maxIterations: values.length },
  });
  return loop.run();
}
