import { fileURLToPath } from "node:url";
import { runOnce } from "@mentat/core/testing";
import { describe, expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

const stub = fileURLToPath(new URL("./__fixtures__/termination-acp.mjs", import.meta.url));
const limitText =
  "Maximum steps for this agent have been reached, so no further tool calls can be made.";

describe("ACP termination provenance over the wire", () => {
  it.each([
    ["end_turn", "done", "turn-ended"],
    ["max_tokens", "length", "token-limit"],
    ["max_turn_requests", "length", "request-limit"],
    ["cancelled", "aborted", "cancelled"],
    ["refusal", "error", "error"],
    ["new_unknown_reason", "error", "unknown"],
    ["", "error", "unknown"],
  ])("preserves native %s without declaring task success", async (rawReason, reason, cause) => {
    const session = await createAcpAdapter({
      binary: process.execPath,
      baseArgs: [stub],
      env: { TERMINATION_REASON: rawReason },
    }).createSession({ cwd: process.cwd() });
    try {
      const { end } = await runOnce(session, { text: "task" });
      expect(end).toMatchObject({
        reason,
        termination: { rawReason, source: "acp", cause },
        completion: { response: "present", verification: "unverified", warnings: [] },
      });
    } finally {
      await session.dispose();
    }
  });

  it.each([
    [limitText, true],
    [`Documentation example: ${limitText}`, false],
    ["All checks passed.", false],
  ])("treats self-report as advisory, preserving end_turn (%s)", async (text, warned) => {
    const session = await createAcpAdapter({
      binary: process.execPath,
      baseArgs: [stub],
      env: { TERMINATION_TEXT: text },
    }).createSession({ cwd: process.cwd() });
    try {
      const { end } = await runOnce(session, { text: "task" });
      expect(end).toMatchObject({
        reason: "done",
        termination: { rawReason: "end_turn", cause: "turn-ended" },
        completion: { verification: "unverified" },
      });
      if (end.type !== "run.settled") throw new Error("missing terminal event");
      expect(end.completion?.warnings).toHaveLength(warned ? 1 : 0);
      if (warned) expect(end.completion?.warnings[0]?.source).toBe("assistant");
    } finally {
      await session.dispose();
    }
  });
});
