import type { RunCompletion, RunTermination } from "@mentat/core";

/** Extract known text without pretending images, diffs or unknown content are empty text. */
export function readContent(content: unknown): {
  output: string;
  outputCoverage: "complete" | "partial" | "unsupported";
} {
  let output = "";
  let unsupported = false;
  const visit = (value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const block of value) visit(block);
      return;
    }
    if (typeof value !== "object") {
      unsupported = true;
      return;
    }
    const block = value as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") output += block.text;
    else if (block.type === "content" && block.content !== undefined) visit(block.content);
    else if (
      block.type === "resource" &&
      block.resource &&
      typeof block.resource === "object" &&
      typeof (block.resource as Record<string, unknown>).text === "string"
    )
      output += (block.resource as { text: string }).text;
    else unsupported = true;
  };
  visit(content);
  return {
    output,
    outputCoverage: unsupported ? (output ? "partial" : "unsupported") : "complete",
  };
}

export function blockText(content: unknown): string {
  return readContent(content).output;
}

export function mapStopReason(stopReason: string): "done" | "aborted" | "length" | "error" {
  if (stopReason === "end_turn") return "done";
  if (stopReason === "cancelled") return "aborted";
  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") return "length";
  if (stopReason === "refusal") return "error";
  return "error";
}

export function acpTermination(rawReason: string): RunTermination {
  const causes: Record<string, RunTermination["cause"]> = {
    end_turn: "turn-ended",
    cancelled: "cancelled",
    max_tokens: "token-limit",
    max_turn_requests: "request-limit",
    refusal: "error",
  };
  return { source: "acp", rawReason, cause: causes[rawReason] ?? "unknown" };
}

/** Compatibility signal for engines that report a limit only in final text. */
export function acpCompletion(text: string): RunCompletion {
  const reported = text
    .trimStart()
    .match(
      /^Maximum steps for this agent have been reached, so no further tool calls can be made\./,
    );
  return {
    response: text.trim() ? "present" : "absent",
    verification: "unverified",
    warnings: reported
      ? [{ code: "assistant-reported-step-limit", source: "assistant", text: reported[0] }]
      : [],
  };
}
