import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "@mentat/core";
import type { Candidate, Evaluator, Gate, GateResult } from "@mentat/evolution";
import { type CommandResult, runCommand } from "./command-gate";

export interface ContainerSpec {
  image: string;
  command: string[];
  /** Host directory mounted at `workdir` inside the container. */
  cwd: string;
  workdir?: string;
  network?: "none" | "bridge" | "host";
  env?: Record<string, string>;
  timeoutMs?: number;
  docker?: string;
  signal?: AbortSignal;
  /** Runner-owned file used to reclaim the container after a client timeout. */
  cidFile?: string;
  containerName?: string;
}

/** Pure builder so the container invocation is testable without Docker. */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const workdir = spec.workdir ?? "/workspace";
  const args = ["run", "--rm", "-v", `${spec.cwd}:${workdir}`, "-w", workdir];
  args.push("--network", spec.network ?? "none");
  if (spec.cidFile) args.push("--cidfile", spec.cidFile);
  if (spec.containerName) args.push("--name", spec.containerName);
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

/** Runs an evaluation command inside an isolated container. */
export class ContainerRunner {
  constructor(private readonly docker = "docker") {}

  async run(spec: ContainerSpec): Promise<CommandResult> {
    const dir = mkdtempSync(join(tmpdir(), "mentat-container-"));
    const cidFile = join(dir, "cid"),
      containerName = `mentat-${randomUUID()}`;
    let result: CommandResult;
    try {
      result = await runCommand({
        cwd: spec.cwd,
        command: spec.docker ?? this.docker,
        args: dockerRunArgs({ ...spec, cidFile, containerName }),
        signal: spec.signal,
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      });
    } catch (error) {
      result = { ok: false, code: 1, stdout: "", stderr: String(error) };
    }
    try {
      const invalidIdentity =
        existsSync(cidFile) && !/^[a-f0-9]{12,64}$/.test(readFileSync(cidFile, "utf8").trim());
      // The random name is known even if timeout happened before cidfile publication.
      const cleanup = await runCommand({
        cwd: spec.cwd,
        command: spec.docker ?? this.docker,
        args: ["rm", "--force", containerName],
        timeoutMs: 10_000,
      });
      if (!cleanup.ok && !/No such container/i.test(cleanup.stderr))
        throw new Error(`container cleanup failed: ${cleanup.stderr}`);
      if (invalidIdentity) throw new Error("invalid runner-owned container identity");
    } catch (error) {
      result.ok = false;
      result.code ||= 1;
      result.stderr += `\n${String(error)}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return result;
  }
}

/** Container isolation as a gate: pass when the container run exits 0. */
export function containerGate(name: string, runner: ContainerRunner, spec: ContainerSpec): Gate {
  return {
    name,
    check: async (): Promise<GateResult> => {
      const result = await runner.run(spec);
      if (result.ok) return { passed: true, gate: name };
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
      return { passed: false, gate: name, reason: `${name} failed: ${detail}` };
    },
  };
}

/** Pass/fail signal from a containerized check. */
export class ContainerEvaluator implements Evaluator {
  constructor(
    private readonly runner: ContainerRunner,
    private readonly spec: ContainerSpec,
    private readonly name = "container",
  ) {}

  async evaluate(_candidate: Candidate): Promise<Signal[]> {
    const result = await this.runner.run(this.spec);
    return [{ name: this.name, value: result.ok ? 1 : 0, direction: "higher-better" }];
  }
}
