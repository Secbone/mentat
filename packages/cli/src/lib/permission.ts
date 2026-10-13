import { createInterface } from "node:readline/promises";
import type { PermissionHandler } from "@mentat/core";
import type { PermissionMode } from "@mentat/transport-pi";

/** Build a permission handler: prompt on stdin (`ask`) or allow everything. */
export function createPermissionHandler(mode: PermissionMode): PermissionHandler {
  if (mode === "ask") {
    return {
      request: async (request) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = await rl.question(
            `\n[permission] allow ${request.toolName} ${JSON.stringify(request.input)}? (y/N) `,
          );
          return answer.trim().toLowerCase().startsWith("y") ? "allow" : "deny";
        } finally {
          rl.close();
        }
      },
    };
  }
  return { request: () => "allow" };
}

export function parsePermissionMode(value: string | undefined): PermissionMode {
  if (value === "ask" || value === "auto" || value === "full") return value;
  process.stderr.write(`run: invalid permission mode "${value ?? ""}"\n`);
  return "auto";
}
