/**
 * Mentat bridge extension for Pi.
 *
 * Loaded by Pi via `--extension <this file>`. It:
 *  - registers any MCP servers requested by the host (`MENTAT_MCP_SERVERS`), e.g.
 *    the mentat memory server; and
 *  - registers a `tool_call` gate that forwards the approval decision to the
 *    Mentat host through the RPC extension-UI subprotocol (`ctx.ui.confirm`).
 *
 * Deliberately dependency-free: Pi loads it with jiti, so we avoid importing
 * `@earendil-works/pi-coding-agent` types to keep the transport self-contained.
 */

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface PiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown;
  registerMcpServer?(name: string, config: McpServerConfig): unknown;
}

interface UiLike {
  confirm?: (title: string, message: string) => Promise<boolean>;
}

function registerMcpServers(pi: PiLike): void {
  const raw = process.env.MENTAT_MCP_SERVERS;
  if (!raw) return;
  if (!pi.registerMcpServer) throw new Error("Pi MCP registration is unavailable");
  const servers = JSON.parse(raw) as Array<{ name: string } & McpServerConfig>;
  for (const server of servers) {
    pi.registerMcpServer(server.name, {
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
    });
  }
}

export default function mentatBridge(pi: PiLike): void {
  registerMcpServers(pi);

  if ((process.env.MENTAT_PERMISSION_MODE ?? "ask") === "full") return;

  pi.on("tool_call", async (event: unknown, ctx: unknown) => {
    const record = (event ?? {}) as {
      toolName?: unknown;
      tool?: unknown;
      name?: unknown;
      input?: unknown;
      args?: unknown;
    };
    const toolName = String(record.toolName ?? record.tool ?? record.name ?? "tool");
    const input = record.input ?? record.args ?? null;
    const ui = (ctx as { ui?: UiLike } | undefined)?.ui;
    if (!ui?.confirm) return { block: true, reason: "mentat permission bridge unavailable" };

    const allowed = await ui.confirm(`mentat: ${toolName}`, JSON.stringify({ toolName, input }));
    if (!allowed) return { block: true, reason: `blocked by mentat (${toolName})` };
    return;
  });
}
