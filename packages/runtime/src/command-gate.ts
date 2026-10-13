import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Gate, GateResult } from "@mentat/core";

const exec = promisify(execFile);

export interface CommandSpec {
  cwd: string;
  timeoutMs?: number;
  /** Program + args form, e.g. `pnpm typecheck`. */
  command?: string;
  args?: string[];
  /** Shell form, e.g. `pnpm typecheck && pnpm test`. */
  shell?: string;
}

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const command = spec.shell ? "sh" : (spec.command ?? "");
  const args = spec.shell ? ["-c", spec.shell] : (spec.args ?? []);
  if (command.length === 0) throw new Error("runCommand: no command provided");
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd: spec.cwd,
      timeout: spec.timeoutMs ?? 600_000,
      maxBuffer: 1 << 26,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** A gate that passes when a command exits 0. */
export function commandGate(name: string, spec: CommandSpec): Gate {
  return {
    name,
    check: async (): Promise<GateResult> => {
      const result = await runCommand(spec);
      if (result.ok) return { passed: true, gate: name };
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
      return { passed: false, gate: name, reason: `${name} failed (${result.code}): ${detail}` };
    },
  };
}
