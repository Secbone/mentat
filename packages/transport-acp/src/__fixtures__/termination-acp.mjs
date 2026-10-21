// Dedicated termination integration fixture; no task tools or model calls.
import { createInterface } from "node:readline";

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
  if (message.method === "session/new") reply(message.id, { sessionId: "termination-session" });
  if (message.method === "session/prompt") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "termination-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: process.env.TERMINATION_TEXT ?? "partial response" },
          },
        },
      })}\n`,
    );
    reply(message.id, { stopReason: process.env.TERMINATION_REASON ?? "end_turn" });
  }
}
