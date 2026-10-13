import { describe, expect, it } from "vitest";
import type { ExperienceRecord } from "./experience";
import { buildExperienceDigest } from "./experience-digest";

const record = (overrides: Partial<ExperienceRecord>): ExperienceRecord => ({
  id: "e",
  ts: 0,
  prompt: "a task",
  cwd: "/tmp",
  harness: "pi",
  outcome: "done",
  toolErrors: 0,
  tools: [],
  ...overrides,
});

describe("buildExperienceDigest", () => {
  it("returns empty for no records", () => {
    expect(buildExperienceDigest([])).toBe("");
  });

  it("summarizes outcome, tools and errors", () => {
    const digest = buildExperienceDigest([
      record({ prompt: "fix the build", outcome: "done", tools: ["bash", "read"] }),
      record({ prompt: "deploy", outcome: "error", toolErrors: 2, error: "boom" }),
    ]);
    expect(digest).toContain("[done] fix the build");
    expect(digest).toContain("tools: bash,read");
    expect(digest).toContain("[error] deploy");
    expect(digest).toContain("2 errors");
    expect(digest).toContain("boom");
  });

  it("caps records, prompt length and total size", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      record({ id: `e${i}`, prompt: `task ${i} ${"x".repeat(300)}` }),
    );
    const digest = buildExperienceDigest(many, { maxRecords: 3, maxPromptChars: 10, maxChars: 60 });
    expect(digest.length).toBeLessThanOrEqual(61);
    expect(digest).not.toContain("task 0 ");
  });
});
