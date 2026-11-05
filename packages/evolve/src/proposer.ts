import { type CapabilityPack, defineCapabilityPack } from "@mentat/pack";
import type { Observation, PackProposer } from "./types";

export interface RulePackProposerOptions {
  maxObservations?: number;
  rationale?: string;
}

/**
 * Deterministic proposer used by Dream and tests: append reusable lessons to
 * the worker prompt and bump the pack version. It never mutates the base pack.
 */
export class RulePackProposer implements PackProposer {
  readonly id = "rule";
  private readonly maxObservations: number;
  private readonly rationale: string;

  constructor(options: RulePackProposerOptions = {}) {
    this.maxObservations = options.maxObservations ?? 5;
    this.rationale = options.rationale ?? "append reusable lessons";
  }

  async propose(base: CapabilityPack, observations: Observation[]): Promise<CapabilityPack> {
    const lessons = observations
      .filter((observation) => observation.kind !== "success")
      .map((observation) => observation.text.trim())
      .filter(Boolean)
      .slice(0, this.maxObservations);
    const { digest, ...input } = base;
    void digest;
    const lessonBlock =
      lessons.length > 0
        ? `Lessons learned:\n${lessons.map((text) => `- ${text}`).join("\n")}`
        : "";
    const system = [base.prompt.system, lessonBlock].filter(Boolean).join("\n\n");
    return defineCapabilityPack({
      ...input,
      version: base.version + 1,
      prompt: { ...base.prompt, system },
    });
  }

  get description(): string {
    return this.rationale;
  }
}
