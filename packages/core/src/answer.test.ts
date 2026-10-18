import { describe, expect, it } from "vitest";
import { correctiveInstruction, finalAnswerIssue } from "./answer";

describe("finalAnswerIssue", () => {
  it("flags empty and leaked tool-protocol answers, but not ordinary text", () => {
    expect(finalAnswerIssue("   ")).toBe("empty-answer");
    expect(finalAnswerIssue("<｜｜DSML｜｜ calls>x</｜｜DSML｜｜ calls>")).toBe(
      "tool-protocol-text",
    );
    expect(finalAnswerIssue("the build takes 3 minutes")).toBeUndefined();
    // Documentation that merely mentions the token outside a call is not flagged.
    expect(finalAnswerIssue("the DSML tool syntax is documented here")).toBeUndefined();
  });
});

describe("correctiveInstruction", () => {
  it("states the defect and forbids inventing facts", () => {
    const empty = correctiveInstruction("empty-answer");
    expect(empty).toContain("empty");
    expect(empty).toContain("plain text");
    const leak = correctiveInstruction("tool-protocol-text");
    expect(leak).toContain("tool");
    expect(leak).toContain("unknown");
  });
});
