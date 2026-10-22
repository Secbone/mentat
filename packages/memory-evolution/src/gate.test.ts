import type { Artifact } from "@mentat/core";
import type { Candidate } from "@mentat/evolution";
import type { MemoryEntry } from "@mentat/memory";
import { describe, expect, it } from "vitest";
import { memoryArtifact } from "./artifact";
import { memoryGate } from "./gate";

function candidate(payload: unknown): Candidate {
  // Build a malformed artifact on purpose: creation validates, but legacy data
  // or hand-edited files still reach the gate.
  const valid = memoryArtifact("memory", []);
  const artifact: Artifact = { ref: valid.ref, payload: payload as Artifact["payload"] };
  return { id: "c", version: "c", artifacts: [artifact] };
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
