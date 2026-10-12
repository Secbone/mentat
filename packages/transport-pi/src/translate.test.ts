import { describe, expect, it } from "vitest";
import { extractText, translate } from "./translate";

describe("extractText", () => {
  it("joins text blocks and ignores others", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "toolcall", id: "x" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("passes through plain strings", () => {
    expect(extractText("hi")).toBe("hi");
  });
});

describe("translate", () => {
  it("maps text and thinking deltas", () => {
    const text = translate(
      {
        type: "message_update",
        usage: { input: 1, output: 2, cost: { total: 0.5 } },
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      },
      "s1",
    );
    expect(text).toContainEqual({ type: "message.delta", sessionId: "s1", text: "hi" });
    expect(text).toContainEqual({
      type: "usage",
      sessionId: "s1",
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
    });

    const thinking = translate(
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "why" } },
      "s1",
    );
    expect(thinking).toContainEqual({ type: "message.reasoning", sessionId: "s1", text: "why" });
  });

  it("maps tool lifecycle events", () => {
    expect(
      translate(
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "bash",
          args: { command: "ls" },
        },
        "s1",
      ),
    ).toEqual([
      { type: "tool.start", sessionId: "s1", id: "c1", name: "bash", input: { command: "ls" } },
    ]);

    expect(
      translate(
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "out" }] },
          isError: false,
        },
        "s1",
      ),
    ).toEqual([{ type: "tool.result", sessionId: "s1", id: "c1", output: "out", isError: false }]);
  });

  it("maps settled events with aborted flag", () => {
    expect(translate({ type: "agent_settled", aborted: true }, "s1")).toEqual([
      { type: "run.settled", sessionId: "s1", reason: "aborted" },
    ]);
    expect(translate({ type: "agent_settled", aborted: false }, "s1")).toEqual([
      { type: "run.settled", sessionId: "s1", reason: "done" },
    ]);
  });

  it("maps compaction and ignores unknown records", () => {
    expect(translate({ type: "compaction_start", reason: "threshold" }, "s1")).toEqual([
      { type: "context.compacting", sessionId: "s1", reason: "threshold" },
    ]);
    expect(translate({ type: "agent_start" }, "s1")).toEqual([]);
  });
});
