import { spawn } from "node:child_process";
import type { JsonValue, Tracer } from "@mentat/core";
import type { Gate, GateResult } from "@mentat/evolution";

export interface CommandSpec {
  tracer?: Tracer;
  onDiagnostic?: (error: unknown) => void;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  command?: string;
  args?: string[];
  shell?: string;
}
export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
}
/** Capture is bounded; cancellation kills the owned POSIX process group. */
export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const command = spec.shell ? "sh" : (spec.command ?? "");
  const args = spec.shell ? ["-c", spec.shell] : (spec.args ?? []);
  const timeout = spec.timeoutMs ?? 600_000;
  if (!command || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error("invalid command or timeout");
  const started = Date.now();
  const emit = (type: string, data: JsonValue) => {
    try {
      spec.tracer?.emit(type, data);
    } catch (error) {
      try {
        spec.onDiagnostic?.(error);
      } catch {}
    }
  };
  emit("command.start", { cwd: spec.cwd, command, args, timeoutMs: timeout });
  const result = await new Promise<CommandResult>((resolve) => {
    if (spec.signal?.aborted)
      return resolve({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "command cancelled",
        cancelled: true,
      });
    const child = spawn(command, args, {
      cwd: spec.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      timedOut = false,
      cancelled = false,
      failure = "";
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ||= String(error);
      }
    };
    const cancel = () => {
      cancelled = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    spec.signal?.addEventListener("abort", cancel, { once: true });
    if (spec.signal?.aborted) cancel();
    const capture = (chunk: string, output: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024 * 1024) {
        failure = "command output exceeds capture limit";
        kill();
        return;
      }
      if (output === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => capture(chunk, "stderr"));
    child.on("error", (error) => {
      failure = String(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", cancel);
      const error =
        failure || (timedOut ? "command timed out" : cancelled ? "command cancelled" : "");
      resolve({
        ok: code === 0 && !error,
        code: code ?? 1,
        stdout,
        stderr: stderr + (error ? `\n${error}` : ""),
        ...(timedOut ? { timedOut } : {}),
        ...(cancelled ? { cancelled } : {}),
      });
    });
  });
  emit(result.ok ? "command.end" : "command.error", {
    ...result,
    durationMs: Date.now() - started,
  });
  return result;
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
