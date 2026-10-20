import { createInterface } from "node:readline/promises";
import type { PermissionMode } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import type { ExperienceRecord } from "@mentat/session";
import { defaultExperienceDir, defaultMemoryPath } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { createDefaultRegistry } from "../lib/registry";
import { printEvent, printResult } from "./run";

export async function chatCommand(args: string[]): Promise<number> {
  let harnessId = "pi";
  let model: string | undefined;
  let cwd = process.cwd();
  let permission: PermissionMode = "full";
  let memoryPath: string | undefined;
  let skillsPath: string | undefined;
  let experienceDir: string | undefined;
  let logDir: string | undefined;
  let timeoutMs = 120_000;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--log-dir") logDir = args[++i];
    else if (arg === "--timeout-ms") timeoutMs = Number(args[++i]);
    else if (arg === "--harness") harnessId = args[++i] ?? harnessId;
    else if (arg === "--model") model = args[++i];
    else if (arg === "--cwd") cwd = args[++i] ?? cwd;
    else if (arg === "--memory") memoryPath = args[++i];
    else if (arg === "--skills") {
      skillsPath = args[++i];
      if (!skillsPath || skillsPath.startsWith("--")) {
        process.stderr.write("--skills: missing repository path\n");
        return 1;
      }
    } else if (arg === "--experience") experienceDir = args[++i];
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

  const host = createAssistantHost(
    {
      cwd,
      adapter: registry.get(harnessId),
      model,
      memoryPath,
      ...(skillsPath ? { skillsPath } : {}),
      experienceDir,
      logDir,
      timeoutMs,
      permissionMode: permission,
      protocolLog: args.includes("--log-protocol"),
      reflectionAdapter: createDefaultRegistry("ask").get(harnessId),
      permission: createPermissionHandler(permission),
    },
    { onDiagnostic: (d) => process.stderr.write(`[${d.code}] ${d.message}\n`) },
  );
  const interactions: ExperienceRecord[] = [];
  let reflectedThrough = 0;
  let lastOutcome = "error";
  const session = await host.open();
  process.stderr.write(`trace: ${host.logDir ?? host.traceId}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Buffer lines so input that arrives while a turn runs (piped scripts) is not
  // lost; each turn is still awaited before the next prompt.
  const queue: string[] = [];
  let inputClosed = false;
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
    inputClosed = true;
    waiter?.(null);
    waiter = undefined;
  });
  const nextLine = async (): Promise<string | null> => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    if (inputClosed) return null;
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  };

  process.stdout.write(
    "mentat chat — /exit, /remember <text>, /remember-constraint|preference|fact|method <text>, /reflect\n",
  );

  try {
    for (;;) {
      process.stdout.write("> ");
      const line = await nextLine();
      if (line === null) break;
      const text = line.trim();
      if (text === "/exit" || text === "/quit") break;
      const remember = /^\/remember(?:-(constraint|preference|fact|method))?\s+(.+)$/.exec(text);
      if (remember) {
        const kind = remember[1] as "constraint" | "preference" | "fact" | "method" | undefined;
        const rule = remember[2] ?? "";
        const result = await host.remember(kind ? { text: rule, kind } : rule);
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
          const result = await host.reflect(
            {
              task: interactions.map((record) => record.prompt).join("\n"),
              outcome: lastOutcome,
              tools: [...new Set(interactions.flatMap((record) => record.tools))],
              interactions,
            },
            { timeoutMs },
          );
          if (result.status === "invalid") {
            process.stdout.write(
              `reflect: nothing saved; ${result.issues
                .slice(0, 5)
                .map(
                  (issue) =>
                    `${issue.code}${issue.index !== undefined ? `[${issue.index}]` : ""}${issue.ref ? ` ${issue.ref}` : ""}: ${issue.message}`,
                )
                .join("; ")}\n`,
            );
          } else {
            const added = result.added;
            reflectedThrough = interactions.length;
            process.stdout.write(
              `reflect: +${added}, merged ${result.merged}, skipped ${result.skipped}, rejected ${result.rejected}\n`,
            );
            for (const decision of result.decisions
              .filter((decision) => decision.op === "reject")
              .slice(0, 5))
              process.stdout.write(`reflect: rejected[${decision.index}]: ${decision.reason}\n`);
          }
        } catch (error) {
          process.stdout.write(
            `reflect: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        continue;
      }
      if (text.length === 0) continue;

      try {
        const { result, record } = await host.turn(session, text, {
          timeoutMs,
          onEvent: printEvent,
        });
        printResult(result);
        lastOutcome = result.reason;
        interactions.push(record);
        if (result.error) process.stdout.write(`${result.error}\n`);
        if (result.reason === "aborted" || result.error?.includes("timed out")) break;
      } catch (error) {
        lastOutcome = "error";
        process.stdout.write(`${String(error)}\n`);
      }
      process.stdout.write("\n");
    }
    return 0;
  } finally {
    rl.close();
    await host.close();
  }
}
