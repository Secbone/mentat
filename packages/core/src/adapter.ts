import type { AgentEventListener, PermissionDecision, PermissionRequest } from "./events";
import type { MaybePromise } from "./types";

export type HarnessId = string;

/** What a harness can do beyond the normalized baseline. */
export interface HarnessCapabilities {
  /** Can inject a message into a running turn. */
  steer: boolean;
  /** Can compact/reset context explicitly. */
  compact: boolean;
  /** Can fork a session at a message. */
  fork: boolean;
  /** Surfaces pre-execution tool permission requests. */
  permissions: boolean;
}

/** A stdio MCP server a session should connect to. */
export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  /** MCP servers the harness should connect for this session. */
  mcpServers?: McpServerSpec[];
}

export interface UserInput {
  text: string;
}

export interface SendOptions {
  mode?: "queue" | "steer";
}

export interface PermissionHandler {
  request(req: PermissionRequest): MaybePromise<PermissionDecision>;
}

/** Dependencies the runtime injects into a harness session. */
export interface AdapterDeps {
  onPermission?: PermissionHandler;
}

export interface SessionHandle {
  readonly id: string;
  send(input: UserInput, options?: SendOptions): Promise<void>;
  interrupt(): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  dispose(): Promise<void>;
}

/**
 * The single seam every engine plugs into. Adapters own the process /
 * protocol boundary; everything upstream speaks {@link AgentEvent}.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly label?: string;
  capabilities(): HarnessCapabilities;
  createSession(options: SessionOptions, deps?: AdapterDeps): Promise<SessionHandle>;
}
