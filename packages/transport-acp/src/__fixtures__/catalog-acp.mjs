// Test-only engine: session creation completes before a delayed catalog receipt.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  if (request.method === "initialize") reply({ protocolVersion: 1 });
  if (request.method === "session/new") {
    reply({ sessionId: "catalog-fixture" });
    if (process.env.CATALOG_EMIT === "yes")
      setTimeout(() => {
        appendFileSync(
          process.env.CATALOG_PATH,
          `${JSON.stringify({
            event: "tools/list-sent",
            token: process.env.CATALOG_TOKEN,
            tools: ["memory_search"],
          })}\n`,
        );
      }, 80);
  }
});
