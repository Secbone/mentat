import { type RememberInput, reflectionTrigger } from "@mentat/assistant";
import type { AgentEvent, PermissionMode } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import type { TurnResult } from "@mentat/session";
import { defaultExperienceDir, defaultMemoryPath } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { createDefaultRegistry } from "../lib/registry";

export async function runCommand(args: string[]): Promise<number> {
  let harnessId = "fake";
  let model: string | undefined;
  let cwd = process.cwd();
  let permission: PermissionMode = "auto";
  let memoryPath: string | undefined;
  let skillsPath: string | undefined;
  let experienceDir: string | undefined;
  let recallChars: number | undefined;
  const remember: RememberInput[] = [];
  let reflect = false;
  let reflectAuto = false;
  let logDir: string | undefined;
  let timeoutMs = 120_000;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--log-protocol") continue;
    if (arg === "--log-dir") {
      logDir = args[++i];
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number(args[++i]);
      continue;
    }
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
    if (arg === "--skills") {
      skillsPath = args[++i];
      if (!skillsPath || skillsPath.startsWith("--")) {
        process.stderr.write("--skills: missing repository path\n");
        return 1;
      }
      continue;
    }
    if (arg === "--memory") {
      memoryPath = args[++i] ?? memoryPath;
      continue;
    }
    if (arg === "--recall-chars") {
      recallChars = Number(args[++i]);
      if (!Number.isSafeInteger(recallChars) || recallChars < 0) {
        process.stderr.write("--recall-chars: expected a nonnegative integer\n");
        return 1;
      }
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
    if (
      arg &&
      [
        "--remember-constraint",
        "--remember-preference",
        "--remember-fact",
        "--remember-method",
      ].includes(arg)
    ) {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        process.stderr.write(`${arg}: missing rule text\n`);
        return 1;
      }
      const kind = arg.slice("--remember-".length) as
        | "constraint"
        | "preference"
        | "fact"
        | "method";
      remember.push({ text: value, kind });
      continue;
    }
    if (arg === "--reflect") {
      reflect = true;
      continue;
    }
    if (arg === "--reflect-auto") {
      reflect = true;
      reflectAuto = true;
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
  const host = createAssistantHost(
    {
      cwd,
      adapter,
      model,
      memoryPath,
      ...(skillsPath ? { skillsPath } : {}),
      experienceDir,
      ...(recallChars !== undefined ? { nativeHistory: { maxChars: recallChars } } : {}),
      logDir,
      timeoutMs,
      permissionMode: permission,
      protocolLog: args.includes("--log-protocol"),
      reflectionAdapter: createDefaultRegistry("ask").get(harnessId),
      permission: createPermissionHandler(permission),
    },
    { onDiagnostic: (d) => process.stderr.write(`[${d.code}] ${d.message}\n`) },
  );
  process.stderr.write(`trace: ${host.logDir ?? host.traceId}\n`);
  try {
    const session = await host.open();
    const { result, record } = await host.turn(session, prompt, { timeoutMs, onEvent: printEvent });
    printResult(result);
    if (result.error) process.stderr.write(`${result.error}\n`);
    let added = 0;
    for (const fact of remember) {
      const saved = await host.remember(fact);
      if (saved.op === "add" || saved.op === "update") added++;
    }
    if (remember.length)
      process.stderr.write(`memory: +${added} (${remember.length - added} duplicate)\n`);
    if (reflect) {
      // `--reflect-auto` reflects only when there is evidence worth learning
      // from (corrections or reusable tool failures); plain `--reflect` is an
      // explicit request and always runs.
      const trigger = reflectAuto ? reflectionTrigger({ interactions: [record] }) : undefined;
      if (trigger && !trigger.reflect) {
        process.stderr.write(`reflect: skipped (${trigger.reason})\n`);
      } else {
        if (trigger) process.stderr.write(`reflect: trigger=${trigger.reason}\n`);
        try {
          const reflected = await host.reflect(
            { task: prompt, outcome: result.reason, tools: record.tools, interactions: [record] },
            { timeoutMs },
          );
          process.stderr.write(`reflect: ${reflected.status} +${reflected.added}\n`);
          process.stderr.write(
            `reflect: merged ${reflected.merged}, skipped ${reflected.skipped}, rejected ${reflected.rejected}\n`,
          );
          for (const decision of reflected.decisions
            .filter((decision) => decision.op === "reject")
            .slice(0, 5))
            process.stderr.write(`reflect: rejected[${decision.index}]: ${decision.reason}\n`);
          for (const issue of reflected.issues.slice(0, 5))
            process.stderr.write(
              `reflect: ${issue.code}${issue.index !== undefined ? `[${issue.index}]` : ""}: ${issue.message}\n`,
            );
        } catch (error) {
          process.stderr.write(`reflect: ${String(error)}\n`);
        }
      }
    }
    return result.reason === "done" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 1;
  } finally {
    await host.close();
  }
}
export function printEvent(event: AgentEvent): void {
  // Raw deltas may contain an invalid tool block that only becomes detectable
  // after later chunks arrive. Keep them in the trajectory, not the final UI.
  if (event.type === "message.reasoning") process.stderr.write(event.text);
  else if (event.type === "tool.start") process.stdout.write(`\n[tool] ${event.name}\n`);
  else if (event.type === "run.settled") process.stdout.write("\n");
}
export function printResult(result: TurnResult): void {
  if (result.reason === "done") process.stdout.write(`${result.text}\n`);
}
