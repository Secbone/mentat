import type { JsonValue } from "./types";

/** Token / cost accounting for one run. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Why a run stopped. */
export type StopReason = "done" | "aborted" | "error" | "length";

export interface Message {
  role: "assistant" | "user";
  text: string;
}

export interface PermissionRequest {
  toolName: string;
  input: JsonValue;
  reason?: string;
}

export type PermissionDecision = "allow" | "deny";

/**
 * Normalized event stream. Every harness adapter translates its native
 * events into this union so the rest of the framework stays engine-agnostic.
 */
export type AgentEvent =
  | { type: "run.started"; sessionId: string }
  | { type: "message.delta"; sessionId: string; text: string }
  | { type: "message.reasoning"; sessionId: string; text: string }
  | { type: "message.completed"; sessionId: string; message: Message }
  | {
      type: "tool.start";
      sessionId: string;
      id: string;
      name: string;
      title?: string;
      input: JsonValue;
    }
  /** Fields present in an update replace the previous snapshot, never imply an empty value. */
  | {
      type: "tool.update";
      sessionId: string;
      id: string;
      name?: string;
      title?: string;
      input?: JsonValue;
      status?: string;
      output?: string;
      content?: JsonValue;
      outputCoverage?: "complete" | "partial" | "unsupported";
    }
  | {
      type: "tool.result";
      sessionId: string;
      id: string;
      output: string;
      isError: boolean;
      content?: JsonValue;
      outputCoverage?: "complete" | "partial" | "unsupported";
    }
  | {
      type: "permission.request";
      sessionId: string;
      id: string;
      toolCallId?: string;
      request: PermissionRequest;
    }
  | {
      type: "permission.resolved";
      sessionId: string;
      id: string;
      decision: PermissionDecision;
      outcome?: "selected" | "cancelled" | "error";
      optionId?: string;
      error?: string;
    }
  | { type: "usage"; sessionId: string; usage: Usage }
  | { type: "context.compacting"; sessionId: string; reason: string }
  | { type: "run.settled"; sessionId: string; reason: StopReason; error?: string };

export type AgentEventListener = (event: AgentEvent) => void;
