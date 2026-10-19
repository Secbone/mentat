import type { AgentEvent } from "@mentat/core";
import type { TurnResult } from "@mentat/session";
import { describe, expect, it } from "vitest";
import { verifyReadiness } from "./readiness";

function result(events: AgentEvent[]): TurnResult {
  return {
    turnId: "t",
    sessionId: "s",
    reason: "done",
    text: "",
    events,
    durationMs: 0,
  };
}

const probe = { toolName: "memory_ready", expectedOutput: "NONCE" };

describe("verifyReadiness", () => {
  it("verifies when the named tool runs and returns the expected output", async () => {
    let attempts = 0;
    await verifyReadiness({
      sessionId: "s",
      probe,
      emit: () => {},
      probeTurn: async () => {
        attempts += 1;
        return result([
          { type: "tool.start", sessionId: "s", id: "1", name: "memory_ready", input: {} },
          {
            type: "tool.result",
            sessionId: "s",
            id: "1",
            output: "value NONCE ok",
            isError: false,
          },
        ]);
      },
    });
    expect(attempts).toBe(1);
  });

  it("throws when no tool result evidences the probe", async () => {
    await expect(
      verifyReadiness({
        sessionId: "s",
        probe,
        emit: () => {},
        probeTurn: async () => result([]),
      }),
    ).rejects.toThrow("startup tool probe failed");
  });

  it("retries within the attempt budget and fails after exhausting it", async () => {
    let attempts = 0;
    await expect(
      verifyReadiness({
        sessionId: "s",
        probe: { ...probe, maxAttempts: 2 },
        emit: () => {},
        probeTurn: async () => {
          attempts += 1;
          return result([
            { type: "tool.start", sessionId: "s", id: "1", name: "other", input: {} },
          ]);
        },
      }),
    ).rejects.toThrow("startup tool probe failed");
    expect(attempts).toBe(2);
  });
});
