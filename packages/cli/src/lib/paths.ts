import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The most recent `mentat iterate` run directory under cwd, if any. */
export function latestRunDir(cwd = process.cwd()): string | undefined {
  const base = join(cwd, ".mentat", "runs");
  if (!existsSync(base)) return undefined;
  const entries = readdirSync(base).sort();
  const last = entries[entries.length - 1];
  return last ? join(base, last) : undefined;
}

export function defaultMemoryPath(cwd: string): string {
  return join(cwd, ".mentat", "memory.json");
}

export function defaultExperienceDir(cwd: string): string {
  return join(cwd, ".mentat", "experience");
}

/** Versioned data-artifact store used by `mentat evolve` (distinct from memory.json). */
export function defaultMemoryStoreDir(cwd: string): string {
  return join(cwd, ".mentat", "memory");
}
