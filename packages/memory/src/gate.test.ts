import type { Candidate } from "@mentat/core";
import { describe, expect, it } from "vitest";
import { memoryArtifact } from "./artifact";
import { memoryGate } from "./gate";
import type { MemoryEntry } from "./store";

function candidate(entries: MemoryEntry[]): Candidate {
  return { id: "c", version: "c", artifacts: [memoryArtifact("memory", entries)] };
}

describe("memoryGate", () => {
  const gate = memoryGate();

  it("passes valid entries", async () => {
    const result = await gate.check(candidate([{ id: "m1", text: "hello", createdAt: 0 }]));
    expect(result.passed).toBe(true);
  });

  it("rejects a non-number createdAt", async () => {
    const result = await gate.check(
      candidate([{ id: "m1", text: "hello", createdAt: "yesterday" } as unknown as MemoryEntry]),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("createdAt");
  });

  it("rejects duplicate ids", async () => {
    const result = await gate.check(
      candidate([
        { id: "m1", text: "a", createdAt: 0 },
        { id: "m1", text: "b", createdAt: 0 },
      ]),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("duplicate");
  });
});
