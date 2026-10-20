import { fileURLToPath } from "node:url";
import type { JsonValue } from "@mentat/core";
import { type AcpRegistration, createDefaultRegistry } from "@mentat/harnesses";
import { runTurn } from "@mentat/session";

import { describe, expect, it } from "vitest";

const createAcpAdapter = (acp: AcpRegistration) => createDefaultRegistry("ask", { acp }).get("acp");

const fixture = fileURLToPath(
  new URL("../../../transport-acp/src/__fixtures__/turn-boundaries-acp.mjs", import.meta.url),
);
const text = (value: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});
const tool: JsonValue[] = [
  { sessionUpdate: "tool_call", toolCallId: "t1", name: "share", status: "in_progress" },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    content: [{ type: "text", text: "shared" }],
  },
];
async function sessionFor(turns: JsonValue[]) {
  return createAcpAdapter({
    binary: process.execPath,
    baseArgs: [fixture],
    env: { ACP_TEST_TURNS: JSON.stringify(turns) },
  }).createSession({ cwd: process.cwd() });
}

describe("ACP execution boundaries", () => {
  it.each([
    ["end_turn", "done"],
    ["max_tokens", "length"],
    ["max_turn_requests", "length"],
    ["cancelled", "aborted"],
    ["refusal", "error"],
    ["unexpected", "error"],
    [undefined, "error"],
  ])("maps stop reason %s to %s", async (stopReason, reason) => {
    const session = await sessionFor([
      { updates: [text("answer")], result: stopReason ? { stopReason } : {} },
    ]);
    try {
      expect((await runTurn(session, { text: "task" })).reason).toBe(reason);
    } finally {
      await session.dispose();
    }
  });

  it("retains progress in the trace but returns only the post-tool answer", async () => {
    const session = await sessionFor([
      {
        updates: [text("I will share it."), ...tool, text("Shared successfully.")],
        result: { stopReason: "end_turn" },
      },
    ]);
    try {
      const result = await runTurn(session, { text: "share" }, { requireFinalAnswer: true });
      expect(result.text).toBe("Shared successfully.");
      expect(result.events).toContainEqual({
        type: "message.delta",
        sessionId: session.id,
        text: "I will share it.",
      });
    } finally {
      await session.dispose();
    }
  });

  it("does not accept pre-tool narration as completion or retry a completed share", async () => {
    const session = await sessionFor([
      { updates: [text("I will share it."), ...tool], result: { stopReason: "end_turn" } },
    ]);
    try {
      const result = await runTurn(
        session,
        { text: "share" },
        { requireFinalAnswer: true, correctiveRetries: 1 },
      );
      expect(result.reason).toBe("error");
      expect(result.error).toContain("empty-answer");
      expect(result.correctiveTurns).toBeUndefined();
      expect(result.events.filter((e) => e.type === "tool.start")).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  });

  it("corrects leaked protocol through a real second ACP prompt", async () => {
    const session = await sessionFor([
      { updates: [text("<｜｜DSML｜｜ calls>unexecuted")], result: { stopReason: "end_turn" } },
      { updates: [text("I could not perform the lookup.")], result: { stopReason: "end_turn" } },
    ]);
    try {
      expect(
        await runTurn(
          session,
          { text: "lookup" },
          { requireFinalAnswer: true, correctiveRetries: 1 },
        ),
      ).toMatchObject({
        reason: "done",
        correctiveTurns: 1,
        text: "I could not perform the lookup.",
      });
    } finally {
      await session.dispose();
    }
  });
});
