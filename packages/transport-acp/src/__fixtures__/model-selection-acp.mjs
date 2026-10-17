// Dedicated model-selection protocol fixture; no real model or credentials.
import { createInterface } from "node:readline";

let model = "provider/default";
const options = () => [{ id: "model", category: "model", type: "select", currentValue: model }];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") reply({ protocolVersion: 1 });
  else if (message.method === "session/new")
    reply({ sessionId: "model-session", configOptions: options() });
  else if (message.method === "session/set_config_option") {
    if (process.env.IGNORE_MODEL_SELECTION !== "1") model = message.params.value;
    reply({ configOptions: options() });
  } else if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "model-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: model } },
      },
    });
    reply({ stopReason: "end_turn" });
  } else if (message.id !== undefined) reply({});
}
