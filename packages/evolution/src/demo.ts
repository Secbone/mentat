import {
  type Artifact,
  type ArtifactAdapter,
  createArtifact,
  createArtifactRegistry,
  type JsonValue,
} from "@mentat/core";
import { type EvalTask, FunctionEvaluator } from "./evaluator";
import { type LoopResult, SelfIterationLoop } from "./loop";
import { type ProposeStep, ScriptedProposer } from "./proposer";
import type { Candidate } from "./types";
import { InMemoryWorkspace } from "./workspace";

/** A trivial data artifact whose single "knob" value is being optimized. */
export const knobAdapter: ArtifactAdapter<number> = {
  kind: "prompt",
  form: "data",
  parse(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw))
      throw new Error("knob must be a finite number");
    return raw;
  },
  snapshot: (value): JsonValue => value,
  restore(raw): number {
    return knobAdapter.parse(raw);
  },
  materialize: (value, host) => host.provide("knob", value),
};

export const knobRegistry = createArtifactRegistry().register(knobAdapter);

export function knobArtifact(
  value: number,
  options: { protected?: boolean; version?: string } = {},
): Artifact {
  return createArtifact(knobAdapter, "knob", value, options);
}

export function readKnobTask(): EvalTask {
  return {
    id: "read-knob",
    metrics: ["knob"],
    run: (host) => [{ name: "knob", value: host.get<number>("knob"), direction: "higher-better" }],
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
    evaluator: new FunctionEvaluator([readKnobTask()], knobRegistry),
    config: { maxIterations: values.length },
  });
  return loop.run();
}
