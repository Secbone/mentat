import type { AgentEvent, JsonValue, Usage } from "@mentat/core";
import type { RpcRecord } from "./rpc-client";

/** Extract concatenated text from a Pi content array (or plain string). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    }
  }
  return parts.join("");
}

function mapUsage(raw: unknown): Usage {
  const usage = (raw ?? {}) as {
    input?: number;
    output?: number;
    cost?: { total?: number };
  };
  const mapped: Usage = {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
  };
  if (typeof usage.cost?.total === "number") mapped.costUsd = usage.cost.total;
  return mapped;
}

/**
 * Translate one Pi RPC session event into normalized {@link AgentEvent}s.
 * Non-session records (responses, extension UI) are handled elsewhere and
 * return an empty array here.
 */
export function translate(record: RpcRecord, sessionId: string): AgentEvent[] {
  switch (record.type) {
    case "message_update": {
      const events: AgentEvent[] = [];
      if (record.usage) events.push({ type: "usage", sessionId, usage: mapUsage(record.usage) });
      const update = record.assistantMessageEvent as
        | { type?: unknown; delta?: unknown }
        | undefined;
      if (typeof update?.delta === "string") {
        if (update.type === "text_delta") {
          events.push({ type: "message.delta", sessionId, text: update.delta });
        } else if (update.type === "thinking_delta") {
          events.push({ type: "message.reasoning", sessionId, text: update.delta });
        }
      }
      return events;
    }
    case "message_end": {
      const message = record.message as
        | {
            role?: unknown;
            content?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
          }
        | undefined;
      if (message?.role !== "assistant") return [];
      // A failed/aborted model call still ends the message; never mask it as a
      // successful (empty) completion, or the CLI prints nothing and reports done.
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      if (stopReason === "error" || stopReason === "aborted") {
        const detail =
          typeof message.errorMessage === "string" && message.errorMessage.trim()
            ? message.errorMessage.trim()
            : `model stopped: ${stopReason}`;
        return [
          {
            type: "run.settled",
            sessionId,
            reason: stopReason === "aborted" ? "aborted" : "error",
            error: detail,
          },
        ];
      }
      return [
        {
          type: "message.completed",
          sessionId,
          message: { role: "assistant", text: extractText(message.content) },
        },
      ];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool.start",
          sessionId,
          id: String(record.toolCallId),
          name: String(record.toolName),
          input: (record.args ?? null) as JsonValue,
        },
      ];
    case "tool_execution_end": {
      const content = (record.result as { content?: unknown } | undefined)?.content;
      return [
        {
          type: "tool.result",
          sessionId,
          id: String(record.toolCallId),
          output: extractText(content),
          isError: record.isError === true,
        },
      ];
    }
    case "compaction_start":
      return [
        { type: "context.compacting", sessionId, reason: String(record.reason ?? "threshold") },
      ];
    case "agent_settled":
      return [
        {
          type: "run.settled",
          sessionId,
          reason: record.aborted === true ? "aborted" : "done",
        },
      ];
    default:
      return [];
  }
}
