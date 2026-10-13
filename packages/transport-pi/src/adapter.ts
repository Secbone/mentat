import { fileURLToPath } from "node:url";
import type {
  AdapterDeps,
  AgentEvent,
  AgentEventListener,
  HarnessAdapter,
  HarnessCapabilities,
  JsonValue,
  PermissionDecision,
  PermissionRequest,
  SendOptions,
  SessionHandle,
  SessionOptions,
  UserInput,
} from "@mentat/core";
import { isOpencodeModel, resolveOpencodeApiKey } from "./opencode-auth";
import { RpcClient, type RpcClientOptions, type RpcRecord } from "./rpc-client";
import { translate } from "./translate";

export type PermissionMode = "ask" | "auto" | "full";

export interface PiAdapterOptions {
  id?: string;
  binary?: string;
  baseArgs?: string[];
  extensionPath?: string;
  permissionMode?: PermissionMode;
  env?: Record<string, string>;
}

const CAPABILITIES: HarnessCapabilities = {
  steer: true,
  compact: true,
  fork: true,
  permissions: true,
};

const DEFAULT_BRIDGE = fileURLToPath(new URL("./bridge/mentat-bridge.ts", import.meta.url));

function parsePermissionRequest(record: RpcRecord): PermissionRequest {
  let toolName = typeof record.title === "string" ? record.title : "tool";
  let input: JsonValue = null;
  if (typeof record.message === "string") {
    try {
      const parsed = JSON.parse(record.message) as { toolName?: unknown; input?: unknown };
      if (typeof parsed.toolName === "string") toolName = parsed.toolName;
      if (parsed.input !== undefined) input = parsed.input as JsonValue;
    } catch {
      /* message was not the structured payload */
    }
  }
  return { toolName, input };
}

class PiSession implements SessionHandle {
  readonly id: string;
  private readonly client: RpcClient;
  private readonly deps: AdapterDeps;
  private readonly listeners = new Set<AgentEventListener>();
  private disposed = false;

  constructor(id: string, spawn: Omit<RpcClientOptions, "onRecord">, deps: AdapterDeps) {
    this.id = id;
    this.deps = deps;
    this.client = new RpcClient({
      ...spawn,
      onRecord: (record) => this.handleRecord(record),
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private handleRecord(record: RpcRecord): void {
    if (record.type === "extension_ui_request") {
      void this.handleUiRequest(record);
      return;
    }
    for (const event of translate(record, this.id)) this.emit(event);
  }

  private async handleUiRequest(record: RpcRecord): Promise<void> {
    const method = record.method;
    const id = record.id;
    if (method === "confirm") {
      const decision = await this.requestPermission(parsePermissionRequest(record));
      this.client.write({ type: "extension_ui_response", id, confirmed: decision === "allow" });
      return;
    }
    if (method === "select") {
      const decision = await this.requestPermission(parsePermissionRequest(record));
      this.client.write({
        type: "extension_ui_response",
        id,
        value: decision === "allow" ? "Allow" : "Block",
      });
      return;
    }
    if (method === "input" || method === "editor") {
      this.client.write({ type: "extension_ui_response", id, cancelled: true });
    }
    // notify / setStatus / setWidget / setTitle / set_editor_text: fire-and-forget.
  }

  private async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (!this.deps.onPermission) return "allow";
    return this.deps.onPermission.request(request);
  }

  async send(input: UserInput, _options?: SendOptions): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    this.emit({ type: "run.started", sessionId: this.id });
    let data: unknown;
    try {
      data = await this.client.request("prompt", { message: input.text });
    } catch (error) {
      this.emit({
        type: "run.settled",
        sessionId: this.id,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const disposition = (data as { disposition?: unknown } | undefined)?.disposition;
    if (disposition === "handled") {
      this.emit({ type: "run.settled", sessionId: this.id, reason: "done" });
    }
  }

  async interrupt(): Promise<void> {
    await this.client.request("abort");
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    await this.client.close();
  }
}

let sessions = 0;

export function createPiAdapter(options: PiAdapterOptions = {}): HarnessAdapter {
  const binary = options.binary ?? "pi";
  const baseArgs = options.baseArgs ?? [];
  const extensionPath = options.extensionPath ?? DEFAULT_BRIDGE;
  const permissionMode = options.permissionMode ?? "auto";

  return {
    id: options.id ?? "pi",
    label: "Pi",
    capabilities: () => CAPABILITIES,
    createSession: async (sessionOptions: SessionOptions, deps: AdapterDeps = {}) => {
      const args = [
        ...baseArgs,
        "--mode",
        "rpc",
        "--no-session",
        ...(extensionPath ? ["--extension", extensionPath] : []),
        ...(sessionOptions.model ? ["--model", sessionOptions.model] : []),
        ...(sessionOptions.systemPrompt
          ? ["--append-system-prompt", sessionOptions.systemPrompt]
          : []),
      ];
      const env: Record<string, string> = {
        ...options.env,
        MENTAT_PERMISSION_MODE: permissionMode,
      };
      if (sessionOptions.mcpServers && sessionOptions.mcpServers.length > 0) {
        env.MENTAT_MCP_SERVERS = JSON.stringify(sessionOptions.mcpServers);
      }
      if (isOpencodeModel(sessionOptions.model) && !env.OPENCODE_API_KEY) {
        const key = resolveOpencodeApiKey();
        if (key) env.OPENCODE_API_KEY = key;
      }

      return new PiSession(
        `pi-${++sessions}`,
        {
          binary,
          args,
          cwd: sessionOptions.cwd,
          env,
        },
        deps,
      );
    },
  };
}
