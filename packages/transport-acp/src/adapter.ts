import { existsSync, readFileSync } from "node:fs";
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
import { AcpConnection } from "./connection";
import { acpCompletion, acpTermination, blockText, mapStopReason, readContent } from "./content";

export interface McpCatalogReadiness {
  receiptPath: string;
  token: string;
  tools: string[];
  timeoutMs?: number;
}

export interface AcpAdapterOptions {
  binary: string;
  baseArgs?: string[];
  id?: string;
  env?: Record<string, string>;
  /** Opt-in engine workaround after session/new; a delay is not a tool-readiness proof. */
  startupSettleMs?: number;
  /** Fresh tools/list receipt from the MCP process actually connected by the engine.
   * This proves catalog exchange, not tool permission or model execution.
   */
  startupReadiness?: McpCatalogReadiness | McpCatalogReadiness[];
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
    const modelOption = configOptions.find(
      (option) => option.category === "model" || option.id === "model",
    );
    let currentModel =
      modelOption?.currentValue ??
      (result.models as { currentModelId?: string } | undefined)?.currentModelId;
    if (this.requestedModel && currentModel !== this.requestedModel && modelOption?.id) {
      this.deps.onDiagnostic?.({
        code: "ACP_MODEL_SELECTION",
        message: JSON.stringify({
          requested: this.requestedModel,
          previous: currentModel ?? null,
        }),
      });
      const selected = await this.connection.request("session/set_config_option", {
        sessionId: this.wireSessionId,
        configId: modelOption.id,
        value: this.requestedModel,
      });
      const options = Array.isArray(selected.configOptions)
        ? (selected.configOptions as Array<{
            id?: string;
            category?: string;
            currentValue?: string;
          }>)
        : [];
      currentModel = options.find(
        (option) => option.id === modelOption.id || option.category === "model",
      )?.currentValue;
      if (currentModel !== this.requestedModel)
        throw new Error(
          `ACP model selection unverified: requested ${this.requestedModel}, engine returned ${currentModel ?? "unknown"}`,
        );
    }
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
        // Pre-tool narration is progress, not the final answer after that action.
        // Keep delta events for the trace, but require fresh answer text afterwards.
        this.accumulated = "";
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
        : "deny";
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
      const reason = mapStopReason(stopReason);
      this.emit({
        type: "run.settled",
        sessionId: this.id,
        reason,
        termination: acpTermination(stopReason),
        completion: acpCompletion(this.accumulated),
        ...(reason === "error"
          ? { error: `ACP stopped: ${stopReason || "missing stopReason"}` }
          : {}),
      });
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
  const settleMs = options.startupSettleMs ?? 0;
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 10000)
    throw new RangeError("ACP startupSettleMs must be an integer from 0 to 10000");
  const baseArgs = options.baseArgs ?? [];
  const catalogs = options.startupReadiness
    ? Array.isArray(options.startupReadiness)
      ? options.startupReadiness
      : [options.startupReadiness]
    : [];
  if (catalogs.length > 16) throw new RangeError("too many ACP readiness catalogs");
  for (const readiness of catalogs)
    if (
      !readiness.receiptPath ||
      !readiness.token ||
      !readiness.tools.length ||
      !Number.isSafeInteger(readiness.timeoutMs ?? 20000) ||
      (readiness.timeoutMs ?? 20000) <= 0 ||
      (readiness.timeoutMs ?? 20000) > 60000
    )
      throw new RangeError("invalid ACP startupReadiness");
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
      const previousReceipts = catalogs.map((readiness) =>
        existsSync(readiness.receiptPath) ? readFileSync(readiness.receiptPath).length : 0,
      );
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
        for (const [index, readiness] of catalogs.entries()) {
          const deadline = Date.now() + (readiness.timeoutMs ?? 20000);
          let found = false;
          while (Date.now() < deadline) {
            const fresh = existsSync(readiness.receiptPath)
              ? readFileSync(readiness.receiptPath).subarray(previousReceipts[index]).toString()
              : "";
            found = fresh
              .split("\n")
              .slice(0, -1)
              .some((line) => {
                try {
                  const receipt = JSON.parse(line);
                  return (
                    receipt.token === readiness.token &&
                    receipt.event === "tools/list-sent" &&
                    Array.isArray(receipt.tools) &&
                    readiness.tools.every((name) => receipt.tools.includes(name))
                  );
                } catch {
                  return false;
                }
              });
            if (found) break;
            await new Promise((ready) => setTimeout(ready, 25));
          }
          if (!found) throw new Error("ACP MCP catalog readiness timed out; no prompt submitted");
          deps.onDiagnostic?.({
            code: "ACP_MCP_CATALOG_READY",
            message: JSON.stringify({
              tools: readiness.tools,
              proof:
                "fresh tools/list response; permissions and execution require independent validation",
            }),
          });
        }
        if (settleMs) {
          deps.onDiagnostic?.({
            code: "ACP_STARTUP_SETTLE",
            message: JSON.stringify({
              milliseconds: settleMs,
              policy:
                "configured engine compatibility delay; tool readiness must be verified independently",
            }),
          });
          await new Promise((ready) => setTimeout(ready, settleMs));
        }
      } catch (error) {
        // never leak the child process if the ACP handshake fails
        await session.dispose();
        throw error;
      }
      return session;
    },
  };
}
