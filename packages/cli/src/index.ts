import { AdapterRegistry, type AgentEvent, createFakeAdapter } from "@mentat/core";

const USAGE = `mentat — a self-iterating agent framework

Usage:
  mentat harness list
  mentat run "<prompt>" [--harness <id>] [--model <id>] [--cwd <path>]
  mentat help

Options:
  --harness <id>   harness adapter to use (default: fake)
  --model <id>     model id passed to the harness
  --cwd <path>     working directory (default: process.cwd())
`;

export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createFakeAdapter());
  return registry;
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

async function runCommand(args: string[]): Promise<number> {
  const registry = createDefaultRegistry();
  let harnessId = "fake";
  let model: string | undefined;
  let cwd = process.cwd();
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
    if (arg !== undefined) promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    process.stderr.write("run: missing prompt\n");
    return 1;
  }
  if (!registry.has(harnessId)) {
    process.stderr.write(`run: unknown harness "${harnessId}"\n`);
    return 1;
  }

  const adapter = registry.get(harnessId);
  const session = await adapter.createSession({
    cwd,
    ...(model ? { model } : {}),
  });

  let reason = "error";
  const settled = new Promise<void>((resolve) => {
    session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message.delta":
          process.stdout.write(event.text);
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

  await session.send({ text: prompt });
  await settled;
  await session.dispose();
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
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}
