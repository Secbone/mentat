#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

// Transparent stdio relay: only records model/session/usage metadata for this trial.
const child = spawn(process.env.MENTAT_OPENCODE_BIN ?? "opencode", ["acp"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
process.stdin.pipe(child.stdin);
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log({ type: "startupDiagnostic", text: chunk.toString() });
});
let buffer = "";
const file = process.env.MENTAT_EXPERIMENT_METRICS;
const log = (value) => {
  if (file) appendFileSync(file, `${JSON.stringify(value)}\n`);
};
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk.toString();
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    try {
      const record = JSON.parse(line);
      if (record.result?.sessionId) {
        log({
          type: "model",
          wireSessionId: record.result.sessionId,
          currentModelId: record.result.models?.currentModelId,
          modelConfig: record.result.configOptions
            ?.filter((item) => item.category === "model")
            .map((item) => ({ id: item.id, currentValue: item.currentValue })),
        });
      }
      const update = record.params?.update;
      if (update?.sessionUpdate === "usage_update") {
        log({ type: "acpUsage", wireSessionId: record.params.sessionId, ...update });
      }
      if (record.error) log({ type: "rpcError", message: record.error.message });
    } catch {
      /* non-JSON logging is forwarded unchanged */
    }
  }
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
