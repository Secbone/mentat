// Synthetic wire-only scenarios; no tool implementation is executed here.
import { createInterface } from "node:readline";

const turns = JSON.parse(process.env.ACP_TEST_TURNS);
let next = 0;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
  if (message.method === "session/new") reply(message.id, { sessionId: "boundary-session" });
  if (message.method !== "session/prompt") return;
  const turn = turns[next++];
  for (const update of turn.updates ?? []) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "boundary-session", update },
    });
  }
  reply(message.id, turn.result ?? {});
});
