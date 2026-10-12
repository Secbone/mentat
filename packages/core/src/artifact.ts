import type { Disposable, JsonValue, MaybePromise } from "./types";

/**
 * Everything the framework can iterate on. Memory, tools, skills, models,
 * prompts, policies, adapters, core code and even the loop itself are all
 * artifacts under the same contract.
 */
export type ArtifactKind =
  | "prompt"
  | "tool"
  | "skill"
  | "memory"
  | "model"
  | "policy"
  | "adapter"
  | "core"
  | "pipeline";

/** How the artifact is mutated: source code (hot-reloaded) or data (versioned). */
export type ArtifactForm = "code" | "data";

/** A single measured dimension of an evaluation. */
export interface Signal {
  name: string;
  value: number;
  direction: "higher-better" | "lower-better";
}

export interface EvalResult {
  artifactId: string;
  version: string;
  signals: Signal[];
  passed: boolean;
}

export interface EvalSpec {
  suite: string;
  cases: string[];
  metrics: string[];
}

/** Minimal surface an artifact applies itself to. */
export interface Runtime {
  get<T>(key: string): T;
}

export interface IterableArtifact {
  kind: ArtifactKind;
  id: string;
  version: string;
  form: ArtifactForm;
  apply(rt: Runtime): MaybePromise<Disposable>;
  snapshot(): JsonValue;
  evalSpec(): EvalSpec;
}
