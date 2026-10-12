import { createInterface } from "node:readline/promises";
import {
  AdapterRegistry,
  type AgentEvent,
  createFakeAdapter,
  type Gate,
  GateChain,
  type PermissionHandler,
  pathGuardGate,
  runDemoLoop,
  SelfIterationLoop,
} from "@mentat/core";
import {
  AgentProposer,
  CheckEvaluator,
  commandGate,
  GitWorkspace,
  JsonCommandEvaluator,
  type SessionRunner,
} from "@mentat/iterate";
import { createPiAdapter, type PermissionMode } from "@mentat/transport-pi";

const USAGE = `mentat — a self-iterating agent framework

Usage:
  mentat harness list
  mentat run "<prompt>" [--harness <id>] [--model <id>] [--cwd <path>] [--permission <ask|auto|full>]
  mentat loop demo
  mentat iterate --target <dir> --task "<goal>" --check "<cmd>" [--eval "<cmd>"]
  mentat help

Options:
  --harness <id>       harness adapter to use (default: fake)
  --model <id>         model id passed to the harness
  --cwd <path>         working directory (default: process.cwd())
  --permission <mode>  ask | auto | full (default: auto)
  --yes                shorthand for --permission full

iterate options:
  --target <dir>       git repo the agent edits (default: process.cwd())
  --task "<goal>"      what the agent should achieve (required)
  --check "<cmd>"      gate + default evaluator: pass=1, fail=0 (required unless --eval)
  --eval "<cmd>"       evaluator command printing a Signal[] JSON array on stdout
  --iterations <n>     how many iterations to attempt (default: 1)
  --protect <glob>     被保护的路径，禁止 agent 修改（可重复；默认 packages/core/src/loop/**）
`;

export function createDefaultRegistry(permissionMode: PermissionMode = "auto"): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createFakeAdapter());
  registry.register(createPiAdapter({ permissionMode }));
  return registry;
}

function createPermissionHandler(mode: PermissionMode): PermissionHandler {
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

function harnessCommand(args: string[]): number {
  if (args[0] !== "list") {
    process.stderr.write("usage: mentat harness list\n");
    return 1;
  }
  for (const adapter of createDefaultRegistry().list()) {
    const capabilities = adapter.capabilities();
    const flags = Object.entries(capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(",");
    process.stdout.write(`${adapter.id}\t${adapter.label ?? ""}\t${flags}\n`);
  }
  return 0;
}

async function loopCommand(args: string[]): Promise<number> {
  if (args[0] !== "demo") {
    process.stderr.write("usage: mentat loop demo\n");
    return 1;
  }
  const result = await runDemoLoop();
  process.stdout.write("iter  parent    child     gate   knob  accepted\n");
  for (const record of result.records) {
    const knob = record.after?.find((signal) => signal.name === "knob")?.value;
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    const verdict = record.accepted ? "yes" : `no (${record.reason ?? "rejected"})`;
    process.stdout.write(
      `${String(record.iteration).padEnd(5)} ${record.parentId.padEnd(8)} ${record.childId.padEnd(9)} ${gate.padEnd(6)} ${String(knob ?? "-").padEnd(5)} ${verdict}\n`,
    );
  }
  const bestKnob = result.best.artifacts[0]?.snapshot();
  process.stdout.write(
    `\narchive: ${result.archive.size()} candidates, best=${result.best.id} knob=${String(bestKnob)}\n`,
  );
  return 0;
}

async function iterateCommand(args: string[]): Promise<number> {
  let target = process.cwd();
  let task = "";
  let harnessId = "pi";
  let model: string | undefined;
  let permission: PermissionMode = "full";
  let check: string | undefined;
  let evalCmd: string | undefined;
  let iterations = 1;
  const protect: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      target = args[++i] ?? target;
    } else if (arg === "--task") {
      task = args[++i] ?? "";
    } else if (arg === "--harness") {
      harnessId = args[++i] ?? "";
    } else if (arg === "--model") {
      model = args[++i];
    } else if (arg === "--permission") {
      permission = parsePermissionMode(args[++i]);
    } else if (arg === "--yes" || arg === "-y") {
      permission = "full";
    } else if (arg === "--check") {
      check = args[++i];
    } else if (arg === "--eval") {
      evalCmd = args[++i];
    } else if (arg === "--iterations") {
      iterations = Number(args[++i] ?? "1") || 1;
    } else if (arg === "--protect") {
      const value = args[++i];
      if (value) protect.push(value);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  if (!task) task = positional.join(" ").trim();
  if (!task) {
    process.stderr.write("iterate: missing --task\n");
    return 1;
  }
  if (!check && !evalCmd) {
    process.stderr.write("iterate: provide --check or --eval\n");
    return 1;
  }
  if (protect.length === 0) protect.push("packages/core/src/loop/**");

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`iterate: unknown harness "${harnessId}"\n`);
    return 1;
  }

  let workspace: GitWorkspace;
  try {
    workspace = new GitWorkspace(target);
  } catch {
    process.stderr.write(`iterate: "${target}" is not a git repository with a commit\n`);
    return 1;
  }

  const adapter = registry.get(harnessId);
  const runner: SessionRunner = async (prompt) => {
    const session = await adapter.createSession(
      { cwd: target, ...(model ? { model } : {}) },
      { onPermission: createPermissionHandler(permission) },
    );
    try {
      const settled = new Promise<void>((resolve) => {
        session.subscribe((event: AgentEvent) => {
          if (event.type === "run.settled") resolve();
          else if (event.type === "message.delta") process.stdout.write(event.text);
          else if (event.type === "tool.start") process.stdout.write(`\n[tool] ${event.name}\n`);
        });
      });
      await session.send({ text: prompt });
      await settled;
    } finally {
      await session.dispose();
    }
  };

  const gates: Gate[] = [
    pathGuardGate("protected", protect, (candidate) => workspace.changedFiles(candidate)),
  ];
  if (check) gates.push(commandGate("check", { cwd: target, shell: check }));

  const evaluator = evalCmd
    ? new JsonCommandEvaluator({ cwd: target, shell: evalCmd })
    : new CheckEvaluator({ cwd: target, shell: check ?? "" }, "check");

  const loop = new SelfIterationLoop({
    workspace,
    proposer: new AgentProposer({ task, cwd: target, runner }),
    evaluator,
    gates: new GateChain(gates),
    config: { maxIterations: iterations },
  });

  const result = await loop.run();
  process.stdout.write("\niteration  gate   accepted  reason\n");
  for (const record of result.records) {
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    process.stdout.write(
      `${String(record.iteration).padEnd(10)} ${gate.padEnd(6)} ${
        record.accepted ? "yes" : "no"
      }       ${record.reason ?? ""}\n`,
    );
  }
  process.stdout.write(`\narchive: ${result.archive.size()} candidates, best=${result.best.id}\n`);
  return 0;
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  if (value === "ask" || value === "auto" || value === "full") return value;
  process.stderr.write(`run: invalid permission mode "${value ?? ""}"\n`);
  return "auto";
}

async function runCommand(args: string[]): Promise<number> {
  let harnessId = "fake";
  let model: string | undefined;
  let cwd = process.cwd();
  let permission: PermissionMode = "auto";
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--harness") {
      harnessId = args[++i] ?? "";
      continue;
    }
    if (arg === "--model") {
      model = args[++i];
      continue;
    }
    if (arg === "--cwd") {
      cwd = args[++i] ?? cwd;
      continue;
    }
    if (arg === "--permission") {
      permission = parsePermissionMode(args[++i]);
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      permission = "full";
      continue;
    }
    if (arg !== undefined) promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write("run: missing prompt\n");
    return 1;
  }

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`run: unknown harness "${harnessId}"\n`);
    return 1;
  }

  const adapter = registry.get(harnessId);
  const session = await adapter.createSession(
    { cwd, ...(model ? { model } : {}) },
    { onPermission: createPermissionHandler(permission) },
  );

  let reason = "error";
  const settled = new Promise<void>((resolve) => {
    session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message.delta":
          process.stdout.write(event.text);
          break;
        case "message.reasoning":
          process.stderr.write(event.text);
          break;
        case "tool.start":
          process.stdout.write(`\n[tool] ${event.name}\n`);
          break;
        case "run.settled":
          reason = event.reason;
          process.stdout.write("\n");
          resolve();
          break;
        default:
          break;
      }
    });
  });

  try {
    await session.send({ text: prompt });
    await settled;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    reason = "error";
  } finally {
    await session.dispose();
  }
  return reason === "done" ? 0 : 1;
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case "harness":
      return harnessCommand(rest);
    case "run":
      return runCommand(rest);
    case "loop":
      return loopCommand(rest);
    case "iterate":
      return iterateCommand(rest);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}
