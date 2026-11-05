import type { JsonValue } from "@mentat/core";
import type { ReportKind } from "@mentat/domain";

/** What a Worker can accept from the control plane. */
export interface WorkerCapabilities {
  promptInjection: "system" | "prefix" | "none";
  skills: "filesystem" | "mcp" | "none";
  mcp: boolean;
  permissions: "sandbox" | "approval" | "none";
  streaming: boolean;
  costReporting: boolean;
  steer: boolean;
  fork: boolean;
}

/** The capability subset a Worker needs for one Assignment. */
export interface WorkerPack {
  systemPrompt?: string;
  model?: string;
  /** Skill names or paths, interpreted by the adapter. */
  skills?: string[];
  /** MCP servers the adapter should connect. */
  mcpServers?: import("@mentat/core").McpServerSpec[];
  executionPolicy?: import("@mentat/core").ExecutionPolicy;
  timeoutMs?: number;
}

export interface WorkerTask {
  assignmentId: string;
  ticketId: string;
  cwd: string;
  prompt: string;
  pack: WorkerPack;
}

export type WorkerEvent =
  | { type: "message"; at: string; text: string }
  | { type: "tool.start"; at: string; name: string; input: JsonValue }
  | { type: "tool.result"; at: string; name?: string; ok: boolean }
  | { type: "usage"; at: string; inputTokens: number; outputTokens: number; costUsd?: number }
  | {
      type: "settled";
      at: string;
      reason: "done" | "aborted" | "error" | "length";
      error?: string;
    };

/** The structured result a Worker reports to its Ticket. */
export interface WorkerReport {
  kind: ReportKind;
  summary: string;
  question?: string;
  text?: string;
}

export interface WorkerSession {
  readonly id: string;
  /** Queue or steer another input; adapters that cannot do it must throw. */
  send(text: string): Promise<void>;
  events(): AsyncIterable<WorkerEvent>;
  cancel(): Promise<void>;
  /** Resolves once the Assignment's current turn has settled. */
  report(): Promise<WorkerReport>;
  dispose(): Promise<void>;
}

export interface WorkerAdapter {
  readonly id: string;
  capabilities(): WorkerCapabilities;
  spawn(task: WorkerTask): Promise<WorkerSession>;
}
