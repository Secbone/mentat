import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, PermissionHandler } from "@mentat/core";
import { runOnce } from "@mentat/core/testing";
import { describe, expect, it } from "vitest";
import { createAcpAdapter } from "./adapter";

const stub = fileURLToPath(new URL("./__fixtures__/replay-acp-agent.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./__fixtures__/multiturn-tooling.json", import.meta.url));
const replay = async (path: string, onPermission?: PermissionHandler) => {
  const adapter = createAcpAdapter({
    binary: process.execPath,
    baseArgs: [stub],
    env: { ACP_REPLAY_FILE: path },
  });
  const session = await adapter.createSession({ cwd: process.cwd() }, { onPermission });
  try {
    return await runOnce(session, { text: "replay" });
  } finally {
    await session.dispose();
  }
};

// Independent reference extraction for these frozen shapes; not the adapter's helper.
function expectedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(expectedText).join("");
  if (!value || typeof value !== "object") return "";
  const block = value as Record<string, unknown>;
  if (block.type === "text") return String(block.text ?? "");
  return expectedText(block.content);
}

describe("ACP observed-protocol regression", () => {
  it("preserves all 17 delayed inputs/results and 21 permission decisions from the experiment", async () => {
    const frames = JSON.parse(readFileSync(fixture, "utf8"));
    const { events } = await replay(fixture, { request: () => "deny" });
    const starts = events.filter((e) => e.type === "tool.start");
    const results = events.filter((e) => e.type === "tool.result");
    const requests = events.filter((e) => e.type === "permission.request");
    const decisions = events.filter((e) => e.type === "permission.resolved");
    expect(starts).toHaveLength(17);
    expect(results).toHaveLength(17);
    expect(requests).toHaveLength(21);
    expect(decisions).toHaveLength(21);
    const expectedInputs = new Map<string, unknown>(),
      expectedContent = new Map<string, unknown>();
    for (const frame of frames) {
      const update = frame.params.update;
      if (!update) continue;
      if (update.rawInput !== undefined) expectedInputs.set(update.toolCallId, update.rawInput);
      if (update.content !== undefined) expectedContent.set(update.toolCallId, update.content);
    }
    for (const start of starts) {
      const updates = events.filter((e) => e.type === "tool.update" && e.id === start.id);
      const lastInput = updates.findLast((e) => e.type === "tool.update" && e.input !== undefined);
      expect(lastInput?.type === "tool.update" ? lastInput.input : start.input).toEqual(
        expectedInputs.get(start.id),
      );
    }
    for (const result of results) {
      expect(result.content).toEqual(expectedContent.get(result.id));
      expect(result.output).toBe(expectedText(expectedContent.get(result.id)));
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.outputCoverage).toBe("complete");
    }
    for (const request of requests) {
      expect(request.toolCallId).toBeTruthy();
      expect(decisions.find((e) => e.id === request.id)).toMatchObject({
        decision: "deny",
        outcome: "selected",
      });
    }
    // Intermediate narration remains in deltas; completed text is the post-tool answer.
    const transcript = events
      .filter((e) => e.type === "message.delta")
      .map((e) => e.text)
      .join("");
    expect(transcript.match(/"selected"/g)).toHaveLength(21);
  });

  it.each(["allow", "deny", "error", "no-option"] as const)(
    "records actual permission lifecycle: %s",
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), "acp-permission-"));
      const path = join(dir, "frames.json");
      writeFileSync(
        path,
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: "p1",
            method: "session/request_permission",
            params: {
              sessionId: "replay-session",
              toolCall: { toolCallId: "t1", title: "read", rawInput: { path: "x" } },
              options:
                mode === "no-option"
                  ? []
                  : [
                      { optionId: "allow", kind: "allow_once" },
                      { optionId: "deny", kind: "reject_once" },
                    ],
            },
          },
        ]),
      );
      const { events } = await replay(path, {
        request: () => {
          if (mode === "error") throw Error("policy unavailable");
          return mode === "allow" ? "allow" : "deny";
        },
      });
      const decision = events.find((e) => e.type === "permission.resolved");
      expect(decision).toMatchObject({
        decision: mode === "allow" ? "allow" : "deny",
        outcome: mode === "error" ? "error" : mode === "no-option" ? "cancelled" : "selected",
      });
      const answer = events.find((e) => e.type === "message.completed");
      expect(answer?.type === "message.completed" ? answer.message.text : "").toContain(
        mode === "error" || mode === "no-option" ? '"cancelled"' : `"optionId":"${mode}"`,
      );
    },
  );

  it("retains content before terminal updates, unknown content and stable tool names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-content-"));
    const path = join(dir, "frames.json");
    const values = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        name: "read",
        title: "Reading file",
        status: "pending",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "Read complete",
        rawInput: { path: "x" },
        content: [
          { type: "content", content: { type: "text", text: "part" } },
          { type: "image", data: "opaque" },
        ],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "image",
        rawInput: {},
        status: "completed",
        content: [{ type: "image", data: "opaque" }],
      },
    ];
    writeFileSync(
      path,
      JSON.stringify(
        values.map((update) => ({
          method: "session/update",
          params: { sessionId: "replay-session", update },
        })),
      ),
    );
    const { events } = await replay(path);
    expect(events.find((e) => e.type === "tool.start" && e.id === "t1")).toMatchObject({
      name: "read",
      input: null,
    });
    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool.result" }> => e.type === "tool.result",
    );
    expect(results[0]).toMatchObject({
      output: "part",
      isError: true,
      outputCoverage: "partial",
      content: values[1]?.content,
    });
    expect(results[1]).toMatchObject({
      output: "",
      outputCoverage: "unsupported",
      content: values[3]?.content,
    });
  });
});
