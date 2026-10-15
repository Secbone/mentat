import { createInterface } from "node:readline/promises";
import type { AgentEvent } from "@mentat/core";
import { type ExperienceRecord, ExperienceStore, SessionRecorder } from "@mentat/memory";
import type { PermissionMode } from "@mentat/transport-pi";
import { memoryMcpSpec } from "../lib/memory-mcp";
import { defaultExperienceDir, defaultMemoryPath } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { assistantPromptOptions, taskContext } from "../lib/prompt";
import { reflectMemories, saveReflections } from "../lib/reflection";
import { createDefaultRegistry } from "../lib/registry";
import { rememberUserFact } from "../lib/remember";

export async function chatCommand(args: string[]): Promise<number> {
  let harnessId = "pi";
  let model: string | undefined;
  let cwd = process.cwd();
  let permission: PermissionMode = "full";
  let memoryPath: string | undefined;
  let experienceDir: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--harness") harnessId = args[++i] ?? harnessId;
    else if (arg === "--model") model = args[++i];
    else if (arg === "--cwd") cwd = args[++i] ?? cwd;
    else if (arg === "--memory") memoryPath = args[++i];
    else if (arg === "--experience") experienceDir = args[++i];
    else if (arg === "--permission") permission = parsePermissionMode(args[++i]);
    else if (arg === "--yes" || arg === "-y") permission = "full";
  }

  memoryPath ??= defaultMemoryPath(cwd);
  experienceDir ??= defaultExperienceDir(cwd);

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`chat: unknown harness "${harnessId}"\n`);
    return 1;
  }

  const adapter = registry.get(harnessId);
  const session = await adapter.createSession(
    {
      cwd,
      ...(model ? { model } : {}),
      ...assistantPromptOptions(adapter),
      mcpServers: [memoryMcpSpec(memoryPath)],
    },
    { onPermission: createPermissionHandler(permission) },
  );
  const experience = new ExperienceStore(experienceDir);

  let resolveSettled: (() => void) | undefined;
  let lastOutcome = "error";
  let recorder: SessionRecorder | undefined;
  const interactions: ExperienceRecord[] = [];
  let reflectedThrough = 0;

  session.subscribe((event: AgentEvent) => {
    recorder?.handle(event);
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
        lastOutcome = event.reason;
        resolveSettled?.();
        break;
      default:
        break;
    }
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Buffer lines so input that arrives while a turn runs (piped scripts) is not
  // lost; each turn is still awaited before the next prompt.
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on("close", () => {
    waiter?.(null);
    waiter = undefined;
  });
  const nextLine = async (): Promise<string | null> => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  };

  process.stdout.write("mentat chat — /exit, /remember <fact>, /reflect\n");

  for (;;) {
    process.stdout.write("> ");
    const line = await nextLine();
    if (line === null) break;
    const text = line.trim();
    if (text === "/exit" || text === "/quit") break;
    if (text.startsWith("/remember ")) {
      const result = rememberUserFact(
        memoryPath,
        experienceDir,
        text.slice("/remember ".length),
        cwd,
      );
      process.stdout.write(
        result.op === "add" || result.op === "update"
          ? `stored ${result.entry?.id}\n`
          : `${result.op}${result.reason ? `: ${result.reason}` : ""}\n`,
      );
      continue;
    }
    if (text === "/reflect") {
      const pending = interactions.slice(reflectedThrough);
      if (!pending.length) {
        process.stdout.write("reflect: no new interactions\n");
        continue;
      }
      try {
        const result = await reflectMemories(createDefaultRegistry("ask").get(harnessId), {
          cwd,
          ...(model ? { model } : {}),
          task: interactions.map((record) => record.prompt).join("\n"),
          outcome: lastOutcome,
          tools: [...new Set(interactions.flatMap((record) => record.tools))],
          interactions,
        });
        if (result.status === "invalid") {
          process.stdout.write("reflect: invalid output or missing evidence; nothing saved\n");
        } else {
          const added = saveReflections(memoryPath, result.candidates);
          reflectedThrough = interactions.length;
          process.stdout.write(`reflect: +${added}\n`);
        }
      } catch (error) {
        process.stdout.write(
          `reflect: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (text.length === 0) continue;

    recorder = new SessionRecorder({
      prompt: text,
      cwd,
      harness: harnessId,
      ...(model ? { model } : {}),
    });
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    process.stdout.write("\n");
    try {
      await session.send({ text, context: taskContext(memoryPath, text) });
      await settled;
    } catch (error) {
      lastOutcome = "error";
      recorder.handle({
        type: "run.settled",
        sessionId: session.id,
        reason: "error",
        error: String(error),
      });
      process.stdout.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resolveSettled = undefined;
      if (recorder) {
        const record = recorder.snapshot();
        interactions.push(record);
        experience.append(record);
      }
      recorder = undefined;
    }
    process.stdout.write("\n");
  }

  rl.close();
  await session.dispose();
  return 0;
}
