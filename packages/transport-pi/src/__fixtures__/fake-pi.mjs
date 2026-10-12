#!/usr/bin/env node
// Minimal `pi --mode rpc` stub for tests. Speaks just enough of the protocol:
// prompt -> agent_start -> text_delta -> message_end -> agent_settled, with an
// interruptible settle window and an optional permission round-trip.

let buffer = "";
let running = false;

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function settle(reason) {
  if (!running) return;
  running = false;
  send({ type: "agent_settled", aborted: reason === "aborted" });
}

function emitText(text) {
  send({
    type: "message_update",
    usage: { input: 5, output: text.length, cost: { total: 0 } },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  setTimeout(() => {
    if (!running) return;
    send({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    settle("done");
  }, 15);
}

function onPrompt(command) {
  send({
    id: command.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  running = true;
  send({ type: "agent_start" });

  if (process.env.FAKE_PI_PERM === "1") {
    send({
      type: "extension_ui_request",
      id: "perm-1",
      method: "confirm",
      title: "mentat: tool",
      message: JSON.stringify({ toolName: "bash", input: { command: "rm -rf /" } }),
    });
    return;
  }
  emitText("pong");
}

function onUiResponse(record) {
  const allowed = record.confirmed === true || record.value === "Allow";
  emitText(allowed ? "allowed" : "blocked");
}

function handle(command) {
  if (!command || typeof command !== "object") return;
  switch (command.type) {
    case "prompt":
      onPrompt(command);
      break;
    case "abort":
      send({ id: command.id, type: "response", command: "abort", success: true, data: {} });
      settle("aborted");
      break;
    case "get_state":
      send({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "stub" },
      });
      break;
    case "extension_ui_response":
      onUiResponse(command);
      break;
    default:
      if (command.id) {
        send({ id: command.id, type: "response", command: command.type, success: true, data: {} });
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
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
