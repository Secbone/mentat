import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve an OpenCode API key for Pi. Prefers the process environment, then
 * falls back to OpenCode's own credential store so `pi --model opencode-go/*`
 * works without a separate login. Never throws.
 */
export function resolveOpencodeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY;

  const dataHome =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(homedir(), ".local", "share");

  const candidates: string[] = [];
  if (env.OPENCODE_DATA_HOME) candidates.push(join(env.OPENCODE_DATA_HOME, "auth.json"));
  candidates.push(join(dataHome, "opencode", "auth.json"));

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        { key?: unknown } | undefined
      >;
      for (const providerId of ["opencode-go", "opencode"]) {
        const entry = parsed[providerId];
        if (entry && typeof entry.key === "string" && entry.key.length > 0) return entry.key;
      }
    } catch {
      /* missing or unreadable store — keep looking */
    }
  }
  return undefined;
}

/** True when Pi should use the OpenCode credential for this model id. */
export function isOpencodeModel(model: string | undefined): boolean {
  return model?.startsWith("opencode-go/") === true || model?.startsWith("opencode/") === true;
}
