import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_PROMPT_VERSION } from "@mentat/assistant";
import { createFakeAdapter } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import type { MemoryEntry } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { inspectTrajectory, readTrajectory, resolveEventData } from "@mentat/observability";
import type { ExperienceRecord, TaskInput } from "@mentat/session";
import { createAcpAdapter } from "@mentat/transport-acp";

export interface Check {
  name: string;
  patterns: string[];
  ordered?: boolean;
}
export interface ExperimentTurn {
  text: string;
  remember: boolean;
  checks: Check[];
}
export interface ExperimentTask {
  id: string;
  turns: ExperimentTurn[];
}
export interface ExperimentScenario {
  id: string;
  role: string;
  tasks: ExperimentTask[];
}
interface Cases {
  version: string;
  design: Record<string, unknown>;
  scenarios: ExperimentScenario[];
}
export type Arm = "persistent" | "reset";
export function modelInput(role: string, turn: ExperimentTurn): TaskInput {
  return {
    text: turn.text,
    memoryScope: turn.remember ? "reusable" : "task",
    hostPolicy: `这是合成任务模拟，用户身份：${role}。\n澄清问题直接写在文本答复中，不使用question交互工具。答复尽量控制在220字以内，必要表格可稍长；仅输出答复或草稿，不进行真实发送、排会、购买或文件修改。`,
  };
}
export function scoreAnswer(text: string, checks: Check[]) {
  return checks.map((check) => {
    let cursor = 0;
    const passed =
      text.trim().length > 0 &&
      check.patterns.every((pattern) => {
        const match = new RegExp(pattern, "isu").exec(check.ordered ? text.slice(cursor) : text);
        if (!match) return false;
        if (check.ordered) cursor += match.index + match[0].length;
        return true;
      });
    return { name: check.name, passed };
  });
}
export function memoryLocation(root: string, role: string, arm: Arm, taskId: string) {
  return join(root, "state", role, arm, arm === "persistent" ? "memory.json" : `${taskId}.json`);
}
interface Accounting {
  status: string;
  sessions: Array<{
    id: string;
    cost: number;
    tokens_input: number;
    tokens_output: number;
    tokens_reasoning: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
    model: unknown;
    version: string;
  }>;
  missing: string[];
  error?: string;
}
interface TurnRow {
  index: number;
  text: string;
  turnId?: string;
  answer: string;
  reason: string;
  error?: string;
  durationMs: number;
  checks: ReturnType<typeof scoreAnswer>;
  record?: ExperienceRecord;
}
interface TaskRow {
  id: string;
  scenario: string;
  arm: Arm;
  task: string;
  traceId: string;
  logDir?: string;
  turns: TurnRow[];
  reflection: unknown;
  memoryBefore: MemoryEntry[];
  memoryAfter: MemoryEntry[];
  trajectory: ReturnType<typeof inspectTrajectory> | null;
  accounting: Accounting;
  nativeModels: unknown[];
  startedAt: string;
  endedAt: string;
  error?: string;
}
const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
function write(path: string, value: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function nativeInfo(dir: string) {
  const sessions = new Set<string>();
  const models: unknown[] = [];
  for (const event of readTrajectory(dir)) {
    const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
    if (event.type === "adapter.diagnostic" && data?.code === "ACP_MODEL_CONFIRMED")
      models.push(JSON.parse(String(data.message)));
    if (event.type === "adapter.protocol") {
      const wire = data?.data as { result?: { sessionId?: string } } | undefined;
      if (wire?.result?.sessionId) sessions.add(wire.result.sessionId);
    }
  }
  return { ids: [...sessions], models };
}
function accounting(ids: string[]): Accounting {
  if (!ids.length) return { status: "unavailable", sessions: [], missing: [] };
  try {
    return JSON.parse(
      execFileSync(
        "python3",
        [fileURLToPath(new URL("./multiturn-accounting.py", import.meta.url))],
        { input: JSON.stringify(ids), encoding: "utf8", timeout: 10_000 },
      ),
    ) as Accounting;
  } catch (error) {
    return { status: "unavailable", sessions: [], missing: ids, error: String(error) };
  }
}

export async function runMultiturn() {
  const cases = JSON.parse(
    readFileSync(fileURLToPath(new URL("./multiturn-cases.json", import.meta.url)), "utf8"),
  ) as Cases;
  const fake = process.argv.includes("--fake");
  const out = resolve(arg("--out") ?? `.mentat/experiments/multiturn-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const model = process.env.MENTAT_SMOKE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
  const rows: TaskRow[] = existsSync(join(out, "results.jsonl"))
    ? readFileSync(join(out, "results.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskRow)
    : [];
  let calls = rows.reduce((sum, row) => sum + row.turns.length + (row.reflection ? 1 : 0), 0);
  let failures = rows.flatMap((row) => row.turns).filter((turn) => turn.reason !== "done").length;
  const done = new Set(
    rows.filter((row) => !row.error && row.turns.length === 4).map((row) => row.id),
  );
  let stopped = false;
  const knownCost = () =>
    rows.reduce(
      (sum, row) =>
        sum + row.accounting.sessions.reduce((value, session) => value + (session.cost ?? 0), 0),
      0,
    );
  const reserve = () => {
    if (stopped || calls >= 120 || failures >= 3 || knownCost() >= 1)
      throw new Error("experiment budget/stop reached");
    calls++;
  };
  let revision = "unknown";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  const datasetSha256 = createHash("sha256")
    .update(readFileSync(new URL("./multiturn-cases.json", import.meta.url)))
    .digest("hex");
  const runnerSha256 = createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex");
  const configuration = {
    datasetSha256,
    runnerSha256,
    datasetVersion: cases.version,
    inputSchemaVersion: "source-scope-v2",
    reflectionSchemaVersion: "evidence-operations-v3",
    promptVersion: ASSISTANT_PROMPT_VERSION,
    model,
    revision,
    fake,
    design: cases.design,
    caps: { calls: 120, observedCostUsd: 1, turnTimeoutMs: 90_000 },
    startedAt: new Date().toISOString(),
  };
  if (existsSync(join(out, "manifest.json"))) {
    const prior = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    if (
      prior.datasetSha256 !== datasetSha256 ||
      prior.fake !== fake ||
      prior.model !== model ||
      prior.runnerSha256 !== runnerSha256 ||
      prior.inputSchemaVersion !== configuration.inputSchemaVersion ||
      prior.reflectionSchemaVersion !== configuration.reflectionSchemaVersion ||
      prior.promptVersion !== configuration.promptVersion
    )
      throw new Error("resume configuration mismatch");
  } else write(join(out, "manifest.json"), configuration);
  console.log(JSON.stringify({ type: "experiment.start", out, ...configuration }));
  const selected = arg("--roles")?.split(",");
  const jobs = cases.scenarios
    .map((scenario, index) => ({ scenario, index }))
    .filter(({ scenario }) => !selected || selected.includes(scenario.id));
  async function roleJob(scenario: ExperimentScenario, index: number) {
    const arms: Arm[] = index % 2 === 0 ? ["persistent", "reset"] : ["reset", "persistent"];
    for (const arm of arms) {
      const history: ExperienceRecord[] = [];
      for (const [taskIndex, task] of scenario.tasks.entries()) {
        const id = `${scenario.id}-${arm}-${task.id}`;
        if (done.has(id)) {
          history.push(
            ...(rows
              .find((row) => row.id === id)
              ?.turns.flatMap((turn) => (turn.record ? [turn.record] : [])) ?? []),
          );
          continue;
        }
        if (stopped) return;
        const cwd = join(out, "work", id);
        mkdirSync(cwd, { recursive: true });
        const memoryPath = memoryLocation(out, scenario.id, arm, task.id);
        mkdirSync(resolve(memoryPath, ".."), { recursive: true });
        const previousTask = scenario.tasks[taskIndex - 1];
        const previous = previousTask
          ? rows.find((row) => row.id === `${scenario.id}-${arm}-${previousTask.id}` && !row.error)
          : undefined;
        write(memoryPath, arm === "persistent" ? (previous?.memoryAfter ?? []) : []);
        const memoryBefore = (await new FileMemoryRepository(memoryPath).snapshot()).entries;
        const adapter = fake
          ? createFakeAdapter()
          : createAcpAdapter({
              binary: "opencode",
              baseArgs: ["acp"],
              env: {
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                  model,
                  small_model: model,
                  autoupdate: false,
                  share: "disabled",
                  instructions: [],
                  plugin: [],
                  permission: {
                    "*": "ask",
                    bash: "deny",
                    read: "deny",
                    edit: "deny",
                    write: "deny",
                    glob: "deny",
                    grep: "deny",
                    webfetch: "deny",
                    websearch: "deny",
                    task: "deny",
                    question: "deny",
                    skill: "deny",
                    memory_search: "allow",
                    memory_add: "allow",
                    "mcp__memory__*": "allow",
                  },
                }),
                OPENCODE_DISABLE_AUTOUPDATE: "true",
              },
            });
        const host = createAssistantHost(
          {
            cwd,
            adapter,
            model: fake ? undefined : model,
            memoryPath,
            logDir: join(out, "traces"),
            experienceDir: join(out, "experience", scenario.id, arm),
            protocolLog: !fake,
            timeoutMs: 30_000,
            permissionMode: "experiment-memory-only",
            permission: {
              request: (request) =>
                /^(?:mcp__memory__)?memory_(?:search|add)$/.test(request.toolName)
                  ? "allow"
                  : "deny",
            },
          },
          {
            onDiagnostic: (d) =>
              appendFileSync(join(out, "diagnostics.jsonl"), `${JSON.stringify({ id, ...d })}\n`),
          },
        );
        const row: TaskRow = {
          id,
          scenario: scenario.id,
          arm,
          task: task.id,
          traceId: host.traceId,
          logDir: host.logDir,
          turns: [],
          reflection: null,
          memoryBefore,
          memoryAfter: [],
          trajectory: null,
          accounting: { status: "unavailable", sessions: [], missing: [] },
          nativeModels: [],
          startedAt: new Date().toISOString(),
          endedAt: "",
        };
        try {
          const session = await host.open();
          for (const [turnIndex, turn] of task.turns.entries()) {
            reserve();
            const { result, record } = await host.turn(session, modelInput(scenario.role, turn), {
              timeoutMs: 90_000,
            });
            const checks = scoreAnswer(result.text, turn.checks);
            row.turns.push({
              index: turnIndex,
              text: turn.text,
              turnId: result.turnId,
              answer: result.text,
              reason: result.reason,
              error: result.error,
              durationMs: result.durationMs,
              checks,
              record,
            });
            history.push(record);
            appendFileSync(
              join(out, "progress.jsonl"),
              `${JSON.stringify({ id, turn: turnIndex, reason: result.reason, calls, checks })}\n`,
            );
            console.log(
              JSON.stringify({
                type: "turn",
                id,
                turn: turnIndex + 1,
                calls,
                reason: result.reason,
                passed: checks.filter((check) => check.passed).length,
                checks: checks.length,
              }),
            );
            if (result.reason !== "done") {
              failures++;
              throw new Error(result.error ?? `turn ended ${result.reason}`);
            }
            // Exact explicit user directive, never a hidden profile or model inference.
            if (turn.remember) await host.remember(turn.text);
          }
          if (arm === "persistent") {
            reserve();
            row.reflection = await host.reflect(
              {
                task: task.turns.map((turn) => turn.text).join("\n"),
                outcome: "done",
                tools: [...new Set(history.flatMap((record) => record.tools))],
                interactions: history,
              },
              { timeoutMs: 90_000 },
            );
          }
        } catch (error) {
          row.error = String(error);
          stopped = true;
          if (failures >= 3 || row.error.includes("budget/stop")) stopped = true;
          console.log(JSON.stringify({ type: "task.error", id, error: String(error) }));
        } finally {
          await host.close();
        }
        row.memoryAfter = (await new FileMemoryRepository(memoryPath).snapshot()).entries;
        if (row.logDir) {
          row.trajectory = inspectTrajectory(row.logDir);
          const native = nativeInfo(row.logDir);
          row.nativeModels = native.models;
          row.accounting = accounting(native.ids);
        }
        row.endedAt = new Date().toISOString();
        rows.push(row);
        write(join(out, `${id}.json`), row);
        appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(row)}\n`);
        write(join(out, "summary.json"), {
          out,
          completed: rows.length,
          calls,
          failures,
          knownCostUsd: knownCost(),
          stopped,
          taskIds: rows.map((row) => row.id),
        });
        console.log(
          JSON.stringify({
            type: "task.end",
            id,
            completed: rows.length,
            calls,
            knownCostUsd: knownCost(),
            memory: row.memoryAfter.length,
            trajectory: row.trajectory,
          }),
        );
      }
    }
  }
  // Independent roles run in two lanes; task ordering within each role/arm is fixed.
  const queue = [...jobs];
  await Promise.all(
    [0, 1].map(async () => {
      for (;;) {
        const job = queue.shift();
        if (!job || stopped) return;
        await roleJob(job.scenario, job.index);
      }
    }),
  );
  write(join(out, "summary.json"), {
    out,
    completed: rows.length,
    calls,
    failures,
    knownCostUsd: knownCost(),
    stopped,
    finishedAt: new Date().toISOString(),
    taskIds: rows.map((row) => row.id),
  });
  console.log(
    JSON.stringify({
      type: "experiment.end",
      out,
      completed: rows.length,
      calls,
      failures,
      knownCostUsd: knownCost(),
      stopped,
    }),
  );
  if (stopped || failures) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMultiturn().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
