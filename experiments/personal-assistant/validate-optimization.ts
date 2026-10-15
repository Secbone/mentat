import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantPromptOptions,
  parseReflectedMemories,
  reflectMemories,
} from "@mentat/assistant";
import type { AgentEvent, HarnessAdapter, SessionHandle } from "@mentat/core";
import { saveReflections, taskContext } from "@mentat/host";
import { rememberFact } from "@mentat/memory";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { SessionRecorder } from "@mentat/observability";
import { createAcpAdapter } from "@mentat/transport-acp";
import { acpPermission } from "./runner";

const root = resolve(".mentat/experiments/personal-assistant");
const out = join(root, `optimization-validation-${Date.now()}`);
mkdirSync(out);
const model = "opencode-go/deepseek-v4.1-flash";
const legacyPolicy =
  "You can use the memory_search and memory_add tools to recall or store durable facts about this user and project.";
const dataset = JSON.parse(
  readFileSync(resolve("experiments/personal-assistant/cases.json"), "utf8"),
);
const load = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
type Arm = "legacy" | "optimized";
const cases = [
  {
    id: "product-format",
    scenario: "product",
    task: "05",
    checkpoint: "04",
    criterion: "先一句话建议，再依次证据、风险、下一步；先最小验证",
  },
  {
    id: "engineer-format",
    scenario: "engineer",
    task: "06",
    checkpoint: "04",
    criterion: "复现、原因、改动、验证四段；最小修复、不升级依赖",
  },
  {
    id: "engineer-cost",
    scenario: "engineer",
    task: "08",
    checkpoint: "07",
    criterion: "最小修复和长期方案两档，各明确迁移成本与回归风险",
  },
  {
    id: "engineer-verification",
    scenario: "engineer",
    task: "10",
    checkpoint: "09",
    criterion: "普通bug最小修复，明确未执行验证，不套架构两档",
  },
  {
    id: "household-inventory",
    scenario: "household",
    task: "10",
    checkpoint: "09",
    criterion: "优先现有库存，不建议重复买已有鸡蛋或土豆，不把代买例外长期化",
  },
  {
    id: "household-exception",
    scenario: "household",
    task: "09",
    checkpoint: "07",
    criterion: "按本次朋友要求买6鸡蛋4番茄，不抵扣用户库存",
  },
  {
    id: "household-deadline",
    scenario: "household",
    task: "challenge",
    checkpoint: "07",
    criterion: "明确11:15超过11:00，不能同日完成，引用第20–48天有效约束",
  },
  {
    id: "product-missing-update",
    scenario: "product",
    task: "challenge",
    checkpoint: "07",
    criterion: "诊断：原冻结记忆缺少临时作息，不能凭上下文管理声称已经恢复该规则",
  },
];
const trials = cases.map((item) => ({
  ...item,
  input:
    item.task === "challenge"
      ? load(`${item.scenario}-challenge-v5/${item.scenario}-challenge-C-08.json`).input
      : load(`${item.scenario}-C-v4/${item.scenario}-C-${item.task}.json`).input,
  seed: load(`${item.scenario}-C-v4/${item.scenario}-C-${item.checkpoint}.json`).memoryAfter,
}));
const write = (path: string, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
write(join(out, "plan.json"), {
  model,
  promptVersion: ASSISTANT_PROMPT_VERSION,
  repeats: 3,
  concurrency: 2,
  taskCalls: 48,
  reflectionCalls: 18,
  reflectionTransferCalls: 18,
  maxHostCalls: 84,
  maxObservedCostUsd: 1,
  timeoutMs: 90000,
  taskSemantics:
    "same model/tool permissions/frozen seeds; legacy uses original generic policy; optimized uses production prompt/context helpers",
  reflectionSemantics:
    "replay original first 3 task-answer-feedback-revision interactions; legacy generic /reflect vs new complete reflection; downstream tasks use optimized delivery for BOTH arms",
  limitations:
    "ACP cannot replace native system prompt. Replay measures evidence extraction, not end-to-end preference update. No evaluation output enters training. Semantic review is single-process, not human blind review.",
  cases: trials.map(({ seed, input, ...item }) => ({
    ...item,
    input,
    seedCount: seed.length,
    seedSha256: createHash("sha256").update(JSON.stringify(seed)).digest("hex"),
  })),
});
let calls = 0;
let completed = 0;
let failures = 0;
let observedCost = 0;
let abort = false;

async function send(session: SessionHandle, text: string, context?: string) {
  if (calls >= 84 || observedCost > 1 || abort) throw new Error("experiment budget/stop reached");
  calls += 1;
  const start = Date.now();
  const events: AgentEvent[] = [];
  let answer = "";
  let reason = "error";
  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  try {
    const settled = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("turn timeout")), 90000);
      unsubscribe = session.subscribe((event) => {
        events.push(event);
        if (event.type === "message.completed") answer = event.message.text;
        if (event.type === "run.settled") {
          reason = event.reason;
          error = event.error;
          resolve();
        }
      });
    });
    await Promise.all([
      session.send({ text, ...(context !== undefined ? { context } : {}) }),
      settled,
    ]);
    if (!answer.trim() && reason === "done") {
      reason = "error";
      error = "empty answer";
    }
  } catch (caught) {
    error = String(caught);
    reason = "error";
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
  return {
    text: answer,
    reason,
    ...(error ? { error } : {}),
    wallTimeMs: Date.now() - start,
    events,
  };
}

function adapterFor(cwd: string, metrics: string, reflection = false) {
  return createAcpAdapter({
    binary: process.execPath,
    baseArgs: [fileURLToPath(new URL("./acp-observer.mjs", import.meta.url))],
    env: {
      MENTAT_OPENCODE_BIN: "/opt/homebrew/bin/opencode",
      MENTAT_EXPERIMENT_METRICS: metrics,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        small_model: model,
        autoupdate: false,
        share: "disabled",
        permission: reflection ? { "*": "deny" } : acpPermission("C"),
        instructions: [],
        plugin: [],
      }),
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CONFIG_DIR: join(cwd, "opencode-config"),
    },
  });
}
const memoryPermissions = {
  onPermission: {
    request: (request: { toolName: string }) =>
      /^(?:mcp__memory__|memory_)?memory_(?:search|add)$/.test(request.toolName)
        ? ("allow" as const)
        : ("deny" as const),
  },
};

function save(record: Record<string, unknown>, metrics: string) {
  const native = readFileSync(metrics, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const costBySession = new Map<string, number>();
  for (const entry of native)
    if (entry.type === "acpUsage" && entry.cost?.currency === "USD")
      costBySession.set(entry.wireSessionId, entry.cost.amount);
  const cost = [...costBySession.values()].reduce((a, b) => a + b, 0);
  observedCost += cost;
  const result = {
    ...record,
    nativeModels: native.filter((item) => item.type === "model"),
    nativeAcpUsage: native.filter((item) => item.type === "acpUsage"),
    observedCostUsd: cost,
  };
  write(join(out, `${record.id}.json`), result);
  appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
  completed += 1;
  console.log(
    `${completed}/66 ${record.id} observedCost=${observedCost.toFixed(4)} hostCalls=${calls}`,
  );
}

async function taskTrial(item: (typeof trials)[number], arm: Arm, repetition: number) {
  const id = `${item.id}-${arm}-${repetition}`;
  const cwd = mkdtempSync(join(tmpdir(), "mentat-validation-"));
  const memoryPath = join(cwd, "memory.json");
  write(memoryPath, item.seed);
  const metrics = join(out, `${id}.usage.jsonl`);
  const adapter = adapterFor(cwd, metrics);
  const session = await adapter.createSession(
    {
      cwd,
      model,
      ...(arm === "optimized" ? assistantPromptOptions(adapter) : { systemPrompt: legacyPolicy }),
      mcpServers: [memoryMcpSpec(memoryPath)],
    },
    memoryPermissions,
  );
  const context = arm === "optimized" ? taskContext(memoryPath, item.input) : undefined;
  let first: Awaited<ReturnType<typeof send>>;
  try {
    first = await send(session, item.input, context);
  } finally {
    await session.dispose();
  }
  if (first.reason !== "done") failures += 1;
  save(
    {
      id,
      kind: "task",
      case: item.id,
      scenario: item.scenario,
      arm,
      repetition,
      input: item.input,
      memoryBefore: item.seed,
      memoryAfter: new JsonFileMemoryStore(memoryPath).list(),
      context: context ?? null,
      first,
    },
    metrics,
  );
}

function replay(scenario: string, cwd: string) {
  const s = dataset.scenarios.find((item: { id: string }) => item.id === scenario);
  return ["01", "02", "03"].flatMap((episode, index) => {
    const old = load(`${scenario}-C-v4/${scenario}-C-${episode}.json`);
    return [
      { prompt: old.input, turn: old.first },
      { prompt: s.episodes[index].afterResponseFeedback, turn: old.revision },
    ].map(({ prompt, turn }) => {
      const recorder = new SessionRecorder({ prompt, cwd, harness: "acp", model });
      for (const event of turn.events as AgentEvent[]) recorder.handle(event);
      return recorder.snapshot();
    });
  });
}

async function reflectionTrial(scenario: string, arm: Arm, repetition: number) {
  const id = `${scenario}-reflection-${arm}-${repetition}`;
  const cwd = mkdtempSync(join(tmpdir(), "mentat-validation-"));
  const metrics = join(out, `${id}.usage.jsonl`);
  const memoryPath = join(cwd, "memory.json");
  write(memoryPath, []);
  const adapter = adapterFor(cwd, metrics, true);
  const interactions = replay(scenario, cwd);
  let reflection: Awaited<ReturnType<typeof send>>;
  let parsed: Awaited<ReturnType<typeof reflectMemories>> | { legacyTexts: string[] };
  const start = Date.now();
  if (arm === "legacy") {
    const session = await adapter.createSession(
      { cwd, model },
      { onPermission: { request: () => "deny" } },
    );
    try {
      reflection = await send(
        session,
        [
          "You just completed a task. Extract durable memory entries worth remembering",
          "for future tasks in this project: stable facts about the repository, user",
          "preferences, or key findings. Ignore transient details and anything task-specific.",
          "",
          "Task: (interactive chat)",
          "Outcome: done",
          "Tools used: (none)",
          "",
          'Return ONLY a JSON array of {"id":string,"text":string,"createdAt":number}.',
          "Return [] if nothing is worth remembering.",
        ].join("\n"),
      );
    } finally {
      await session.dispose();
    }
    const memory = new JsonFileMemoryStore(memoryPath);
    const facts = parseReflectedMemories(reflection.text);
    if (reflection.reason === "done") for (const fact of facts) rememberFact(memory, fact);
    parsed = { legacyTexts: facts };
  } else {
    calls += 1;
    const events: AgentEvent[] = [];
    const traced: HarnessAdapter = {
      ...adapter,
      createSession: async (...args) => {
        const session = await adapter.createSession(...args);
        session.subscribe((event) => events.push(event));
        return session;
      },
    };
    parsed = await reflectMemories(traced, {
      cwd,
      model,
      task: interactions.map((record) => record.prompt).join("\n"),
      outcome: "done",
      tools: [...new Set(interactions.flatMap((record) => record.tools))],
      interactions,
    });
    await saveReflections(memoryPath, parsed.candidates);
    const completed = events.filter((event) => event.type === "message.completed").at(-1);
    const settled = events.filter((event) => event.type === "run.settled").at(-1);
    reflection = {
      text: completed?.type === "message.completed" ? completed.message.text : "",
      reason: settled?.type === "run.settled" ? settled.reason : "error",
      events,
      wallTimeMs: Date.now() - start,
    };
  }
  if (reflection.reason !== "done") failures += 1;
  const learned = new JsonFileMemoryStore(memoryPath).list();
  const task = trials.find(
    (item) =>
      item.id ===
      (
        {
          product: "product-format",
          engineer: "engineer-format",
          household: "household-inventory",
        } as Record<string, string>
      )[scenario],
  );
  if (!task) throw new Error("unknown transfer");
  // Both downstream arms use the identical new prompt/context path and same tools.
  const follower = adapterFor(cwd, metrics);
  const session = await follower.createSession(
    { cwd, model, ...assistantPromptOptions(follower), mcpServers: [memoryMcpSpec(memoryPath)] },
    memoryPermissions,
  );
  const context = taskContext(memoryPath, task.input);
  let first: Awaited<ReturnType<typeof send>>;
  try {
    first = await send(session, task.input, context);
  } finally {
    await session.dispose();
  }
  save(
    {
      id,
      kind: "reflection-transfer",
      case: task.id,
      scenario,
      arm,
      repetition,
      input: task.input,
      replaySource: `${scenario}-C-v4/01-03`,
      interactions,
      parsed,
      learned,
      context,
      reflection,
      first,
    },
    metrics,
  );
}

const jobs: Array<{ id: string; run: () => Promise<void> }> = [];
for (let repetition = 1; repetition <= 3; repetition += 1) {
  for (const arm of ["legacy", "optimized"] as Arm[]) {
    for (const item of trials)
      jobs.push({
        id: `${item.id}-${arm}-${repetition}`,
        run: () => taskTrial(item, arm, repetition),
      });
    for (const scenario of ["product", "engineer", "household"])
      jobs.push({
        id: `${scenario}-reflection-${arm}-${repetition}`,
        run: () => reflectionTrial(scenario, arm, repetition),
      });
  }
}
// Deterministic shuffled order reduces a systematic time/cache advantage for either arm.
jobs.sort((a, b) =>
  createHash("sha256")
    .update(a.id)
    .digest("hex")
    .localeCompare(createHash("sha256").update(b.id).digest("hex")),
);
write(
  join(out, "order.json"),
  jobs.map((job) => job.id),
);
let next = 0;
async function worker() {
  while (!abort && next < jobs.length) {
    const job = jobs[next++];
    if (!job) break;
    try {
      await job.run();
    } catch (error) {
      abort = true;
      write(join(out, `${job.id}.error.json`), { error: String(error) });
      console.error(job.id, String(error));
    }
    if (failures >= 3 || observedCost > 1) abort = true;
  }
}
console.log(`Output: ${out}`);
await Promise.all([worker(), worker()]);
write(join(out, "summary.json"), {
  status: abort ? "incomplete" : "completed-unscored",
  completed,
  calls,
  failures,
  observedCostUsd: observedCost,
});
if (abort) process.exitCode = 1;
