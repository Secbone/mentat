import { type RememberInput, reflectionTrigger } from "@mentat/assistant";
import type { AgentEvent, PermissionMode } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import type { TurnResult } from "@mentat/session";
import { defaultExperienceDir, defaultMemoryPath } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { createDefaultRegistry } from "../lib/registry";
import { prepareRunContract } from "../lib/run-contract";

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
  let policyFile: string | undefined;
  let outputContractFile: string | undefined;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execution-policy" || arg === "--output-contract") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        process.stderr.write(`${arg}: missing file\n`);
        return 1;
      }
      if (arg === "--execution-policy") policyFile = value;
      else outputContractFile = value;
      continue;
    }
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
  let contract: ReturnType<typeof prepareRunContract> | undefined;
  try {
    if (policyFile && adapter.capabilities().executionPolicy !== "file-allowlist")
      throw new Error("harness cannot enforce execution policy");
    if (policyFile && (skillsPath || reflect || remember.length || (recallChars ?? 0) > 0))
      throw new Error("restricted run forbids skills, reflection, remember and history recall");
    if (policyFile || outputContractFile) {
      contract = prepareRunContract(cwd, policyFile, outputContractFile);
      cwd = contract.root;
      if (policyFile) {
        // Keep all host-owned state outside the worker; ignore no caller path silently.
        if (args.some((arg) => ["--memory", "--experience", "--log-dir"].includes(arg)))
          throw new Error(
            "restricted run owns memory/experience/log paths; see printed control directory",
          );
        memoryPath = `${contract.control}/memory.json`;
        experienceDir = `${contract.control}/experience`;
        logDir = `${contract.control}/trace`;
      }
      process.stderr.write(`control: ${contract.control}\n`);
    }
  } catch (error) {
    process.stderr.write(`run: ${String(error)}\n`);
    return 1;
  }
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
      ...(contract?.policy
        ? { executionPolicy: contract.policy, memoryTools: { memory: "disabled" as const } }
        : {}),
      protocolLog: args.includes("--log-protocol"),
      reflectionAdapter: createDefaultRegistry("ask").get(harnessId),
      permission: createPermissionHandler(permission),
    },
    {
      onDiagnostic: (d) => process.stderr.write(`[${d.code}] ${d.message}\n`),
      ...(contract ? { resultEvaluator: contract.resultEvaluator } : {}),
    },
  );
  process.stderr.write(`trace: ${host.logDir ?? host.traceId}\n`);
  try {
    const session = await host.open();
    const taskInput = contract?.policy
      ? {
          text: prompt,
          hostPolicy: `Restricted file task. Readable files: ${JSON.stringify(contract.policy.readFiles)}. Writable files: ${JSON.stringify(contract.policy.writeFiles)}. Other native tools are denied. Do not modify inputs or seek bypasses after denial. The host checks output files independently; do not read back a writable-only result.`,
        }
      : prompt;
    const { result, record, acceptance } = await host.turn(session, taskInput, {
      timeoutMs,
      onEvent: printEvent,
    });
    printResult(result);
    if (result.error) process.stderr.write(`${result.error}\n`);
    if (acceptance)
      process.stderr.write(
        `acceptance: ${acceptance.status}${acceptance.evidence && typeof acceptance.evidence === "object" && !Array.isArray(acceptance.evidence) && typeof acceptance.evidence.coverage === "string" ? ` [${acceptance.evidence.coverage}]` : ""}${acceptance.issues.length ? ` (${acceptance.issues.join("; ")})` : ""}\n`,
      );
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
    if (acceptance && acceptance.status !== "not-evaluated")
      return acceptance.status === "accepted" ? 0 : 2;
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
  // Interrupted runs may still contain useful partial output.
  if (result.text && result.reason !== "error") process.stdout.write(`${result.text}\n`);
  if (result.reason !== "done")
    process.stderr.write(`[execution stopped: ${result.termination?.cause ?? result.reason}]\n`);
  if (
    result.completion?.warnings.some((warning) => warning.code === "assistant-reported-step-limit")
  )
    process.stderr.write("[assistant reports a step limit; task completion is unverified]\n");
}
