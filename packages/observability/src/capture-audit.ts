import type { JsonValue } from "@mentat/core";

type Row = { type: string; data?: JsonValue };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
// Independent supported-text reference. Unknown formats remain explicitly outside the audit.
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  const block = object(value);
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource")
    return typeof object(block.resource).text === "string"
      ? String(object(block.resource).text)
      : "";
  return textChild(block);
}
function textChild(block: Record<string, unknown>): string {
  return block.type === "content" ? text(block.content) : "";
}

/** Compare captured ACP fields with normalized observations; not proof of protocol capture completeness. */
export function auditAcpCapture(rows: Row[]) {
  const mapping = new Map<string, string>();
  let activeSession = "";
  let protocolFrames = 0;
  const expected = new Map<string, { input?: unknown; content?: unknown; terminal?: boolean }>();
  const actual = new Map<
    string,
    { input?: unknown; content?: unknown; output?: unknown; terminal?: boolean }
  >();
  const permissionWire = new Map<string, Record<string, unknown>>();
  const permissionEvents = new Map<string, Record<string, unknown>>();
  const permissionDecisions = new Set<string>();
  const issues: string[] = [];
  const key = (session: string, id: unknown) => JSON.stringify([session, id]);
  // Bind normalized sessions using outgoing session/prompt, not guesses based on tool names.
  for (const row of rows) {
    const data = object(row.data);
    if (row.type === "agent.event" && data.type === "run.started")
      activeSession = String(data.sessionId);
    if (row.type === "adapter.protocol" && data.direction === "out") {
      const wire = object(data.data),
        params = object(wire.params);
      if (wire.method === "session/prompt" && typeof params.sessionId === "string" && activeSession)
        mapping.set(activeSession, params.sessionId);
    }
  }
  for (const row of rows) {
    const data = object(row.data);
    if (row.type === "adapter.protocol" && data.direction === "in") {
      const wire = object(data.data),
        params = object(wire.params);
      const update = object(params.update);
      if (wire.method === "session/request_permission") {
        protocolFrames++;
        permissionWire.set(
          key(String(params.sessionId), `acp-permission:${typeof wire.id}:${wire.id}`),
          object(params.toolCall),
        );
      }
      if (
        wire.method === "session/update" &&
        ["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))
      ) {
        protocolFrames++;
        const id = key(String(params.sessionId), update.toolCallId);
        const state = expected.get(id) ?? {};
        if (update.rawInput !== undefined) state.input = update.rawInput;
        if (update.content !== undefined) state.content = update.content;
        if (update.status === "completed" || update.status === "failed") state.terminal = true;
        expected.set(id, state);
      }
    }
    if (row.type !== "agent.event") continue;
    const wireSession = mapping.get(String(data.sessionId));
    if (!wireSession) continue;
    const id = key(wireSession, data.id);
    if (data.type === "permission.request") permissionEvents.set(id, data);
    if (data.type === "permission.resolved") permissionDecisions.add(id);
    if (data.type === "tool.start" || data.type === "tool.update" || data.type === "tool.result") {
      const state = actual.get(id) ?? {};
      if (data.input !== undefined) state.input = data.input;
      if (data.type === "tool.result") {
        state.terminal = true;
        state.content = data.content;
        state.output = data.output;
      }
      actual.set(id, state);
    }
  }
  for (const [id, state] of expected) {
    const observed = actual.get(id);
    if (!observed) {
      issues.push(`missing normalized tool: ${id}`);
      continue;
    }
    if (state.input !== undefined && canonical(state.input) !== canonical(observed.input))
      issues.push(`tool input mismatch: ${id}`);
    if (state.terminal && !observed.terminal) issues.push(`missing normalized result: ${id}`);
    if (state.terminal && state.content !== undefined) {
      if (canonical(state.content) !== canonical(observed.content))
        issues.push(`tool content mismatch: ${id}`);
      if (text(state.content) !== observed.output) issues.push(`tool text mismatch: ${id}`);
    }
  }
  for (const [id, request] of permissionWire) {
    const event = permissionEvents.get(id);
    if (!event) issues.push(`missing normalized permission: ${id}`);
    else {
      if (event.toolCallId !== request.toolCallId) issues.push(`permission tool mismatch: ${id}`);
      if (canonical(object(event.request).input) !== canonical(request.rawInput ?? null))
        issues.push(`permission input mismatch: ${id}`);
    }
    if (!permissionDecisions.has(id)) issues.push(`missing permission decision: ${id}`);
  }
  return {
    status: issues.length
      ? ("mismatch" as const)
      : protocolFrames
        ? ("matched-captured-fields" as const)
        : ("unverified" as const),
    protocolFrames,
    tools: expected.size,
    permissionRequests: permissionWire.size,
    issues,
    coverage:
      "Captured ACP tool inputs, terminal content/text and permission requests/decision presence only; capture completeness and task correctness are not verified.",
  };
}
