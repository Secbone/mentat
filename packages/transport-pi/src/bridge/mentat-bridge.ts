/**
 * Mentat bridge extension for Pi.
 *
 * Loaded by Pi via `--extension <this file>`. It registers a `tool_call`
 * gate that forwards the approval decision to the Mentat host through the
 * RPC extension-UI subprotocol (`ctx.ui.confirm`). The host applies the
 * ask/auto/full policy and answers.
 *
 * Deliberately dependency-free: Pi loads it with jiti, so we avoid importing
 * `@earendil-works/pi-coding-agent` types to keep the transport self-contained.
 */

interface PiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown;
}

interface UiLike {
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export default function mentatBridge(pi: PiLike): void {
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
    if (!ui?.confirm) return;

    const allowed = await ui.confirm(`mentat: ${toolName}`, JSON.stringify({ toolName, input }));
    if (!allowed) return { block: true, reason: `blocked by mentat (${toolName})` };
    return;
  });
}
