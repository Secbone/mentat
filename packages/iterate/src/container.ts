import type { Candidate, Evaluator, Gate, GateResult, Signal } from "@mentat/core";
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
}

/** Pure builder so the container invocation is testable without Docker. */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const workdir = spec.workdir ?? "/workspace";
  const args = ["run", "--rm", "-v", `${spec.cwd}:${workdir}`, "-w", workdir];
  args.push("--network", spec.network ?? "none");
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
    return runCommand({
      cwd: spec.cwd,
      command: spec.docker ?? this.docker,
      args: dockerRunArgs(spec),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    });
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
