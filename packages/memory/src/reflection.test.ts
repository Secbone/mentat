import { describe, expect, it } from "vitest";
import { parseReflectedMemories, parseReflectionCandidates, reflectionPrompt } from "./reflection";

describe("evidence validation", () => {
  it("distinguishes no new memories from invalid output and unknown evidence", () => {
    expect(parseReflectionCandidates("[]", ["e1"]).status).toBe("ok");
    for (const output of [
      "bad",
      '[{"text":"invented"}]',
      '[{"text":"invented","evidenceIds":["future"]}]',
    ]) {
      expect(parseReflectionCandidates(output, ["e1"]).status).toBe("invalid");
    }
    expect(
      parseReflectionCandidates('[{"text":"confirmed","evidenceIds":["e1"]}]', ["e1"]).candidates,
    ).toHaveLength(1);
  });
});

describe("parseReflectedMemories", () => {
  it("extracts non-empty text fields from a fenced JSON array", () => {
    const output = '```json\n[{"id":"a","text":" a fact "},{"id":"b","text":"b"},{"nope":1}]\n```';
    expect(parseReflectedMemories(output)).toEqual(["a fact", "b"]);
  });

  it("returns [] for empty arrays, bad JSON, or non-arrays", () => {
    expect(parseReflectedMemories("[]")).toEqual([]);
    expect(parseReflectedMemories("no json here")).toEqual([]);
    expect(parseReflectedMemories('{"text":"x"}')).toEqual([]);
  });
});

describe("reflectionPrompt", () => {
  it("mentions the task, outcome and tools", () => {
    const prompt = reflectionPrompt({ task: "fix the build", outcome: "done", tools: ["bash"] });
    expect(prompt).toContain("fix the build");
    expect(prompt).toContain("done");
    expect(prompt).toContain("bash");
  });
});
