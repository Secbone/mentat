import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
  AdapterDeps,
  AgentEvent,
  AgentEventListener,
  HarnessAdapter,
  HarnessCapabilities,
  JsonValue,
  McpServerSpec,
  PermissionRequest,
  SendOptions,
  SessionHandle,
  SessionOptions,
  UserInput,
} from "@mentat/core";
import { renderTurnInput } from "@mentat/core";

export interface AcpAdapterOptions {
  binary: string;
  baseArgs?: string[];
  id?: string;
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface AcpConnectionOptions {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onDiagnostic?: AdapterDeps["onDiagnostic"];
  onProtocol?: AdapterDeps["onProtocol"];
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onRequest: (id: number | string, method: string, params: Record<string, unknown>) => void;
  onExit: (code: number | null) => void;
}

/** Extract known text without pretending images, diffs or unknown content are empty text. */
function readContent(content: unknown): {
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

function blockText(content: unknown): string {
  return readContent(content).output;
}

function mapStopReason(stopReason: string): "done" | "aborted" | "length" | "error" {
  if (stopReason === "cancelled") return "aborted";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "error";
  return "done";
}

/**
 * Minimal newline-delimited JSON-RPC client for an Agent Client Protocol
 * child process. Framing is strict LF only (never readline, which also
 * splits on U+2028/U+2029).
 */
class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private nextId = 0;
  private closed = false;

  constructor(private readonly options: AcpConnectionOptions) {
    this.child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleChunk(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      options.onDiagnostic?.({ code: "ACP_STDERR", message: chunk });
    });

    this.child.on("exit", (code) => {
      this.closed = true;
      this.rejectAll(new Error("ACP agent exited"));
      options.onExit(code);
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      index = this.buffer.indexOf("\n");
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onDiagnostic?.({ code: "ACP_MALFORMED_FRAME", message: line });
      return;
    }
    this.options.onProtocol?.({ direction: "in", data: parsed });
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    const method = record.method;
    const id = record.id;

    if (typeof method === "string") {
      const params = (
        record.params && typeof record.params === "object" ? record.params : {}
      ) as Record<string, unknown>;
      if (typeof id === "number" || typeof id === "string") {
        this.options.onRequest(id, method, params);
      } else {
        this.options.onNotification(method, params);
      }
      return;
    }

    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in record) {
      const error = record.error as { message?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : "ACP request failed";
      pending.reject(new Error(message));
      return;
    }
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as Record<string, unknown>)
        : {};
    pending.resolve(result);
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(record: Record<string, unknown>): void {
    this.options.onProtocol?.({ direction: "out", data: record });
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("ACP connection closed"));
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

interface AcpSessionSpawn {
  model?: string;
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  systemPrompt?: string;
  mcpServers?: McpServerSpec[];
}

class AcpSession implements SessionHandle {
  readonly id: string;
  private readonly connection: AcpConnection;
  private readonly cwd: string;
  private readonly deps: AdapterDeps;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly systemContext: string;
  private readonly mcpServers: McpServerSpec[];
  private wireSessionId = "";
  private readonly requestedModel?: string;
  private accumulated = "";
  private running = false;
  private disposed = false;
  private readonly toolContent = new Map<string, JsonValue>();

  constructor(id: string, spawnOptions: AcpSessionSpawn, deps: AdapterDeps) {
    this.id = id;
    this.cwd = spawnOptions.cwd;
    this.requestedModel = spawnOptions.model;
    this.systemContext = spawnOptions.systemPrompt ?? "";
    this.mcpServers = spawnOptions.mcpServers ?? [];
    this.deps = deps;
    this.connection = new AcpConnection({
      binary: spawnOptions.binary,
      args: spawnOptions.args,
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      onDiagnostic: deps.onDiagnostic,
      onProtocol: deps.onProtocol,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (id, method, params) => this.handleRequest(id, method, params),
      onExit: () => {
        /* pending requests are rejected by the connection */
      },
    });
  }

  /** Perform the ACP handshake and open a wire session. */
  async start(): Promise<void> {
    await this.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "mentat", version: "0.0.0" },
    });
    const result = await this.connection.request("session/new", {
      cwd: this.cwd,
      mcpServers: this.mcpServers.map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      })),
    });
    this.wireSessionId = typeof result.sessionId === "string" ? result.sessionId : "";
    const configOptions = Array.isArray(result.configOptions)
      ? (result.configOptions as Array<{ category?: string; id?: string; currentValue?: string }>)
      : [];
    const currentModel =
      configOptions.find((option) => option.category === "model" || option.id === "model")
        ?.currentValue ??
      (result.models as { currentModelId?: string } | undefined)?.currentModelId;
    this.deps.onDiagnostic?.({
      code: currentModel ? "ACP_MODEL_CONFIRMED" : "ACP_MODEL_UNVERIFIED",
      message: JSON.stringify({
        requested: this.requestedModel ?? null,
        effective: currentModel ?? null,
      }),
    });
    if (currentModel && this.requestedModel && currentModel !== this.requestedModel)
      throw new Error(
        `ACP model mismatch: requested ${this.requestedModel}, engine selected ${currentModel}; configure the engine model explicitly`,
      );
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const sessionId = params.sessionId;
    if (typeof sessionId === "string" && this.wireSessionId && sessionId !== this.wireSessionId) {
      return;
    }
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = blockText(update.content);
        if (text.length === 0) return;
        this.accumulated += text;
        this.emit({ type: "message.delta", sessionId: this.id, text });
        return;
      }
      case "agent_thought_chunk": {
        const text = blockText(update.content);
        if (text.length === 0) return;
        this.emit({ type: "message.reasoning", sessionId: this.id, text });
        return;
      }
      case "tool_call":
        this.toolContent.delete(String(update.toolCallId ?? ""));
        this.emit({
          type: "tool.start",
          sessionId: this.id,
          id: String(update.toolCallId ?? ""),
          name: String(update.name ?? update.title ?? update.kind ?? "tool"),
          ...(typeof update.title === "string" ? { title: update.title } : {}),
          input: (update.rawInput ?? null) as JsonValue,
        });
        this.emitToolUpdate(update);
        if (update.status === "completed" || update.status === "failed")
          this.emitToolResult(update);
        return;
      case "tool_call_update":
        this.emitToolUpdate(update);
        if (update.status === "completed" || update.status === "failed")
          this.emitToolResult(update);
        return;
      default:
        return;
    }
  }

  private emitToolUpdate(update: Record<string, unknown>): void {
    const id = String(update.toolCallId ?? "");
    if (update.content !== undefined) this.toolContent.set(id, update.content as JsonValue);
    this.emit({
      type: "tool.update",
      sessionId: this.id,
      id,
      ...(typeof update.name === "string" ? { name: update.name } : {}),
      ...(typeof update.title === "string" ? { title: update.title } : {}),
      ...(update.rawInput !== undefined ? { input: update.rawInput as JsonValue } : {}),
      ...(typeof update.status === "string" ? { status: update.status } : {}),
      ...(update.content !== undefined
        ? { content: update.content as JsonValue, ...readContent(update.content) }
        : {}),
    });
  }

  private emitToolResult(update: Record<string, unknown>): void {
    const id = String(update.toolCallId ?? "");
    const content = this.toolContent.get(id);
    this.emit({
      type: "tool.result",
      sessionId: this.id,
      id,
      ...readContent(content),
      ...(content !== undefined ? { content } : {}),
      isError: update.status === "failed",
    });
    this.toolContent.delete(id);
  }

  private handleRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "session/request_permission") {
      void this.resolvePermission(id, params);
      return;
    }
    this.connection.respondError(id, -32601, `Method not found: ${method}`);
  }

  private async resolvePermission(
    id: number | string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const options = Array.isArray(params.options) ? params.options : [];
    const toolCall = (
      params.toolCall && typeof params.toolCall === "object" ? params.toolCall : {}
    ) as Record<string, unknown>;
    const request: PermissionRequest = {
      toolName:
        typeof toolCall.name === "string"
          ? toolCall.name
          : typeof toolCall.title === "string"
            ? toolCall.title
            : "tool",
      input: (toolCall.rawInput ?? null) as JsonValue,
    };
    const eventId = `acp-permission:${typeof id}:${id}`;
    this.emit({
      type: "permission.request",
      sessionId: this.id,
      id: eventId,
      ...(typeof toolCall.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
      request,
    });
    try {
      if (typeof params.sessionId === "string" && params.sessionId !== this.wireSessionId)
        throw new Error("permission request session mismatch");
      const decision = this.deps.onPermission
        ? await this.deps.onPermission.request(request)
        : "allow";
      if (decision !== "allow" && decision !== "deny")
        throw new Error("invalid permission decision");
      const kinds =
        decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const match = options.find((option) => {
        if (!option || typeof option !== "object") return false;
        const item = option as Record<string, unknown>;
        return (
          typeof item.kind === "string" &&
          kinds.includes(item.kind) &&
          typeof item.optionId === "string"
        );
      }) as { optionId: string } | undefined;
      this.connection.respond(id, {
        outcome: match
          ? { outcome: "selected", optionId: match.optionId }
          : { outcome: "cancelled" },
      });
      this.emit({
        type: "permission.resolved",
        sessionId: this.id,
        id: eventId,
        decision,
        outcome: match ? "selected" : "cancelled",
        ...(match ? { optionId: match.optionId } : {}),
      });
    } catch (error) {
      this.connection.respond(id, { outcome: { outcome: "cancelled" } });
      this.emit({
        type: "permission.resolved",
        sessionId: this.id,
        id: eventId,
        decision: "deny",
        outcome: "error",
        error: String(error),
      });
      this.deps.onDiagnostic?.({ code: "ACP_PERMISSION_ERROR", message: String(error) });
    }
  }

  async send(input: UserInput, _options?: SendOptions): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.running) throw new Error("session busy: a run is already in flight");
    this.running = true;
    this.accumulated = "";
    this.emit({ type: "run.started", sessionId: this.id });
    try {
      const blocks: Array<{ type: "text"; text: string }> = [];
      if (this.systemContext) blocks.push({ type: "text", text: this.systemContext });
      blocks.push({ type: "text", text: renderTurnInput(input) });
      const result = await this.connection.request("session/prompt", {
        sessionId: this.wireSessionId,
        prompt: blocks,
      });
      const stopReason = typeof result.stopReason === "string" ? result.stopReason : "";
      this.emit({
        type: "message.completed",
        sessionId: this.id,
        message: { role: "assistant", text: this.accumulated },
      });
      this.emit({ type: "run.settled", sessionId: this.id, reason: mapStopReason(stopReason) });
    } catch (error) {
      this.emit({
        type: "run.settled",
        sessionId: this.id,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async interrupt(): Promise<void> {
    if (this.disposed) return;
    this.connection.notify("session/cancel", { sessionId: this.wireSessionId });
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
    await this.connection.close();
  }
}

const CAPABILITIES: HarnessCapabilities = {
  steer: false,
  compact: false,
  fork: false,
  permissions: true,
  systemPrompt: "task-context",
};

let sessionSeq = 0;

/**
 * Create the Agent Client Protocol transport adapter. Each session spawns
 * `binary baseArgs...` and speaks newline-delimited JSON-RPC over stdio,
 * normalizing `session/update` chunks into {@link AgentEvent}s.
 */
export function createAcpAdapter(options: AcpAdapterOptions): HarnessAdapter {
  const baseArgs = options.baseArgs ?? [];
  return {
    id: options.id ?? "acp",
    label: "ACP",
    capabilities: () => CAPABILITIES,
    createSession: async (sessionOptions: SessionOptions, deps: AdapterDeps = {}) => {
      if (sessionOptions.systemPromptMode === "replace") {
        throw new Error(
          "ACP adapter cannot replace the agent system prompt; use task-context delivery",
        );
      }
      const session = new AcpSession(
        `acp-${++sessionSeq}`,
        {
          binary: options.binary,
          args: baseArgs,
          cwd: sessionOptions.cwd,
          model: sessionOptions.model,
          env: options.env,
          ...(sessionOptions.systemPrompt ? { systemPrompt: sessionOptions.systemPrompt } : {}),
          ...(sessionOptions.mcpServers && sessionOptions.mcpServers.length > 0
            ? { mcpServers: sessionOptions.mcpServers }
            : {}),
        },
        deps,
      );
      try {
        await session.start();
      } catch (error) {
        // never leak the child process if the ACP handshake fails
        await session.dispose();
        throw error;
      }
      return session;
    },
  };
}
