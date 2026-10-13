#!/usr/bin/env node
// Frozen ACP stub agent for the transport-acp contract. Speaks newline-delimited
// JSON-RPC over stdio. It echoes the prompt back as "acp:<text>" in chunks so
// the adapter must genuinely speak the ACP wire protocol.

let buffer = "";
let sessionSeq = 0;
let pending = null;

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
const update = (sessionId, value) => notify("session/update", { sessionId, update: value });

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((block) => block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function onPrompt(msg) {
  const sessionId = msg.params.sessionId;
  const text = `acp:${promptText(msg.params)}`;
  const chunks = text.match(/.{1,3}/g) ?? [""];
  let index = 0;
  const state = { id: msg.id, cancelled: false };
  pending = state;
  const timer = setInterval(() => {
    if (state.cancelled) {
      clearInterval(timer);
      pending = null;
      respond(msg.id, { stopReason: "cancelled" });
      return;
    }
    if (index < chunks.length) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunks[index++] },
      });
      return;
    }
    clearInterval(timer);
    pending = null;
    respond(msg.id, { stopReason: "end_turn" });
  }, 10);
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "stub-acp", version: "0.0.0" },
      });
      break;
    case "session/new":
      sessionSeq += 1;
      respond(msg.id, { sessionId: `stub-session-${sessionSeq}` });
      break;
    case "session/prompt":
      onPrompt(msg);
      break;
    case "session/cancel":
      if (pending) pending.cancelled = true;
      break;
    default:
      if (msg.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim()) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
