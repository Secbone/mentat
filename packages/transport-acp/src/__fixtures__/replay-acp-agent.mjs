// Replays recorded protocol data. Tool code in the fixture is never executed.
import { readFileSync } from "node:fs";

const frames = JSON.parse(readFileSync(process.argv[2] ?? process.env.ACP_REPLAY_FILE, "utf8"));
const pending = new Map();
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
let buffer = "";
async function handle(message) {
  if (!message.method) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
  if (message.method === "session/new") reply(message.id, { sessionId: "replay-session" });
  if (message.method === "session/prompt") {
    for (const frame of frames) {
      const response =
        frame.id === undefined
          ? undefined
          : new Promise((resolve) => pending.set(frame.id, resolve));
      write(frame);
      if (response) {
        const result = await response;
        // Echo the wire decision so tests can assert it rather than just trusting events.
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "replay-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: JSON.stringify(result) },
            },
          },
        });
      }
    }
    reply(message.id, { stopReason: "end_turn" });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
