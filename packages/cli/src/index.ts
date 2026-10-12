import { createInterface } from "node:readline/promises";
import {
  AdapterRegistry,
  type AgentEvent,
  createFakeAdapter,
  type PermissionHandler,
  runDemoLoop,
} from "@mentat/core";
import { createPiAdapter, type PermissionMode } from "@mentat/transport-pi";

const USAGE = `mentat — a self-iterating agent framework

Usage:
  mentat harness list
  mentat run "<prompt>" [--harness <id>] [--model <id>] [--cwd <path>] [--permission <ask|auto|full>]
  mentat loop demo
  mentat help

Options:
  --harness <id>       harness adapter to use (default: fake)
  --model <id>         model id passed to the harness
  --cwd <path>         working directory (default: process.cwd())
  --permission <mode>  ask | auto | full (default: auto)
  --yes                shorthand for --permission full
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
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}
