import type { ExperienceRecord } from "@mentat/session";
import { describe, expect, it } from "vitest";
import { reflectionTrigger } from "./reflection-trigger";

function record(toolErrors: number): ExperienceRecord {
  return {
    id: "exp-1",
    ts: 0,
    prompt: "t",
    cwd: "/tmp",
    harness: "fake",
    outcome: "done",
    toolErrors,
    tools: [],
  };
}

describe("reflectionTrigger", () => {
  it("always reflects on an explicit request", () => {
    expect(reflectionTrigger({ explicit: true })).toMatchObject({
      reflect: true,
      reason: "explicit",
    });
  });

  it("does not reflect without interactions", () => {
    expect(reflectionTrigger({ interactions: [] })).toMatchObject({
      reflect: false,
      reason: "no-interactions",
    });
  });

  it("reflects on reusable failure evidence, not on mere completion", () => {
    expect(reflectionTrigger({ interactions: [record(2)] })).toMatchObject({
      reflect: true,
      reason: "tool-failures",
    });
    expect(reflectionTrigger({ interactions: [record(0)] })).toMatchObject({
      reflect: false,
      reason: "no-new-evidence",
    });
  });

  it("prefers a user correction as the trigger reason", () => {
    expect(reflectionTrigger({ interactions: [record(1)], corrections: 1 })).toMatchObject({
      reflect: true,
      reason: "user-correction",
    });
  });
});
