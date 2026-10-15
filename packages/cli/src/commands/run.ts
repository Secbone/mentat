import type { AgentEvent } from "@mentat/core";
import { ExperienceStore, SessionRecorder } from "@mentat/memory";
import type { PermissionMode } from "@mentat/transport-pi";
import { memoryMcpSpec } from "../lib/memory-mcp";
import { defaultExperienceDir, defaultMemoryPath } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { assistantPromptOptions, taskContext } from "../lib/prompt";
import { reflectMemories, saveReflections } from "../lib/reflection";
import { createDefaultRegistry } from "../lib/registry";
import { rememberUserFact } from "../lib/remember";

export async function runCommand(args: string[]): Promise<number> {
  let harnessId = "fake";
  let model: string | undefined;
  let cwd = process.cwd();
  let permission: PermissionMode = "auto";
  let memoryPath: string | undefined;
  let experienceDir: string | undefined;
  const remember: string[] = [];
  let reflect = false;
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
    if (arg === "--memory") {
      memoryPath = args[++i] ?? memoryPath;
      continue;
    }
    if (arg === "--experience") {
      experienceDir = args[++i] ?? experienceDir;
      continue;
    }
    if (arg === "--remember") {
      const value = args[++i];
      if (value) remember.push(value);
      continue;
    }
    if (arg === "--reflect") {
      reflect = true;
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

  memoryPath ??= defaultMemoryPath(cwd);
  experienceDir ??= defaultExperienceDir(cwd);

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
    {
      cwd,
      ...(model ? { model } : {}),
      ...assistantPromptOptions(adapter),
      mcpServers: [memoryMcpSpec(memoryPath)],
    },
    { onPermission: createPermissionHandler(permission) },
  );

  let reason = "error";
  const recorder = new SessionRecorder({
    prompt,
    cwd,
    harness: harnessId,
    ...(model ? { model } : {}),
  });
  const settled = new Promise<void>((resolve) => {
    session.subscribe((event: AgentEvent) => {
      recorder.handle(event);
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
    await session.send({ text: prompt, context: taskContext(memoryPath, prompt) });
    await settled;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    reason = "error";
    recorder.handle({
      type: "run.settled",
      sessionId: session.id,
      reason: "error",
      error: String(error),
    });
  } finally {
    await session.dispose();
  }
  new ExperienceStore(experienceDir).append(recorder.snapshot());

  let added = 0;
  for (const fact of remember) {
    const result = rememberUserFact(memoryPath, experienceDir, fact, cwd);
    if (result.op === "add" || result.op === "update") added += 1;
  }
  if (remember.length > 0) {
    process.stderr.write(`memory: +${added} (${remember.length - added} duplicate)\n`);
  }

  if (reflect) {
    try {
      const result = await reflectMemories(createDefaultRegistry("ask").get(harnessId), {
        cwd,
        ...(model ? { model } : {}),
        task: prompt,
        outcome: reason,
        tools: recorder.snapshot().tools,
        interactions: [recorder.snapshot()],
      });
      if (result.status === "invalid") {
        process.stderr.write("reflect: invalid output or missing evidence; nothing saved\n");
      } else {
        const reflected = saveReflections(memoryPath, result.candidates);
        process.stderr.write(
          `reflect: +${reflected} (${result.candidates.length - reflected} duplicate)\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`reflect: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return reason === "done" ? 0 : 1;
}
