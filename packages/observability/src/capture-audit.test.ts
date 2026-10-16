import type { JsonValue } from "@mentat/core";
import { expect, it } from "vitest";
import { auditAcpCapture } from "./capture-audit";

it("does not mistake a structurally ended run for faithful ACP capture", () => {
  const rows: Array<{ type: string; data: JsonValue }> = [
    { type: "agent.event", data: { type: "run.started", sessionId: "normalized" } },
    {
      type: "adapter.protocol",
      data: { direction: "out", data: { method: "session/prompt", params: { sessionId: "wire" } } },
    },
    {
      type: "adapter.protocol",
      data: {
        direction: "in",
        data: {
          method: "session/update",
          params: {
            sessionId: "wire",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "t",
              rawInput: { path: "x" },
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "error" } }],
            },
          },
        },
      },
    },
    {
      type: "agent.event",
      data: { type: "tool.start", sessionId: "normalized", id: "t", input: {} },
    },
    {
      type: "agent.event",
      data: { type: "tool.result", sessionId: "normalized", id: "t", output: "" },
    },
    {
      type: "adapter.protocol",
      data: {
        direction: "in",
        data: {
          id: 1,
          method: "session/request_permission",
          params: { sessionId: "wire", toolCall: { toolCallId: "t" } },
        },
      },
    },
  ];
  const result = auditAcpCapture(rows);
  expect(result.status).toBe("mismatch");
  expect(result.issues.map((issue) => issue.split(":")[0])).toEqual([
    "tool input mismatch",
    "tool content mismatch",
    "tool text mismatch",
    "missing normalized permission",
    "missing permission decision",
  ]);
  expect(auditAcpCapture([]).status).toBe("unverified");
});
