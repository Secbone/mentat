import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantPromptOptions,
  reflectMemories,
} from "@mentat/assistant";
import type { AgentEvent, HarnessAdapter, SessionHandle } from "@mentat/core";
import { buildTurnContext, type MemoryEntry } from "@mentat/memory";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { type ExperienceRecord, SessionRecorder } from "@mentat/observability";
import { createAcpAdapter } from "@mentat/transport-acp";
import { saveReflections, taskContext } from "./memory";
import { acpPermission, parentCheckpoint, sendTurn, taskInput } from "./runner";

interface Episode {
  id: string;
  phase: string;
  simulatedDay: number;
  input: { prompt: string; source: string };
  afterResponseFeedback: string | null;
}
interface Scenario {
  id: string;
  name: string;
  role: string;
  episodes: Episode[];
}
interface State {
  memory: MemoryEntry[];
  interactions: ExperienceRecord[];
}
interface Variant {
  id: string;
  scenario: string;
  checkpoint: string;
  day: number;
  prompt: string;
  source: string;
  criteria: string;
}

// Optional follow-up probes share the same approved bounded experiment entrypoint.
if (process.argv.includes("--diagnostics-only")) {
  await import("./expanded-diagnostics");
  process.exit(0);
}

const base = resolve(".mentat/experiments/personal-assistant");
const out = join(base, `expanded-${Date.now()}`);
mkdirSync(out);
const datasetText = readFileSync(resolve("experiments/personal-assistant/cases.json"), "utf8");
const dataset = JSON.parse(datasetText) as { scenarios: Scenario[] };
const scenarios = dataset.scenarios.filter((s) =>
  ["teacher", "finance", "retail", "designer"].includes(s.id),
);
const variantText = readFileSync(
  resolve("experiments/personal-assistant/expanded-cases.json"),
  "utf8",
);
const variants = (JSON.parse(variantText) as { cases: Variant[] }).cases;
const model = "opencode-go/deepseek-v4.1-flash";
const write = (path: string, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
write(join(out, "plan.json"), {
  model,
  promptVersion: ASSISTANT_PROMPT_VERSION,
  roles: scenarios.map((s) => s.id),
  datasetSha256: createHash("sha256").update(datasetText).digest("hex"),
  variantsSha256: createHash("sha256").update(variantText).digest("hex"),
  mainTasks: 40,
  feedbackTurns: 12,
  reflectionTurns: 12,
  coldTasks: 16,
  variantTasks: 32,
  pressureTasks: 6,
  plannedHostCalls: 118,
  maxHostCalls: 128,
  maxObservedCostUsd: 1,
  concurrency: 2,
  semantics:
    "optimized production prompt/context and reflection helpers; learning first 3 tasks with same-session feedback; reflect after03/07/09 using complete inherited training evidence; evaluations fork frozen ancestors and never feed back into training",
  controls:
    "same optimized policy and memory tool availability, empty memory and no training history; variants two repeats with learned vs cold memory",
  pressure:
    "artificial memory-growth diagnostic; tagged control manually changes metadata, not learned ability; offline also tests same-priority tag saturation",
  limitations:
    "one learning trajectory per role; variant repeats share the frozen training state; ACP task-context delivery only; no real sending/buying/scheduling; local evaluator criteria never supplied to agent",
});
let calls = 0;
let completed = 0;
let failures = 0;
let observedCost = 0;
let aborted = false;
const states = new Map<string, Map<string, State>>();
const paths: Record<string, string> = {};
function budget() {
  if (aborted || calls >= 128 || observedCost >= 1)
    throw new Error("experiment budget/stop reached");
  calls += 1;
}
function adapterFor(cwd: string, metrics: string, reflector = false): HarnessAdapter {
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
        permission: reflector ? { "*": "deny" } : acpPermission("C"),
        instructions: [],
        plugin: [],
      }),
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CONFIG_DIR: join(cwd, "opencode-config"),
    },
  });
}
const deps = {
  onPermission: {
    request: (request: { toolName: string }) =>
      /^(?:mcp__memory__|memory_)?memory_(?:search|add)$/.test(request.toolName)
        ? ("allow" as const)
        : ("deny" as const),
  },
};
function contextual(session: SessionHandle, memoryPath: string): SessionHandle {
  return {
    id: session.id,
    subscribe: (listener) => session.subscribe(listener),
    send: (input, options) =>
      session.send({ ...input, context: taskContext(memoryPath, input.text) }, options),
    interrupt: () => session.interrupt(),
    dispose: () => session.dispose(),
  };
}
async function invoke(session: SessionHandle, text: string, cwd: string) {
  budget();
  const turn = await sendTurn(session, text, 90000);
  const recorder = new SessionRecorder({ prompt: text, cwd, harness: "acp", model });
  for (const event of turn.events) recorder.handle(event);
  if (turn.reason !== "done") failures += 1;
  return { turn, record: recorder.snapshot() };
}
function persist(result: Record<string, unknown>, metrics: string) {
  const native = readFileSync(metrics, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const costBySession = new Map<string, number>();
  for (const row of native)
    if (row.type === "acpUsage" && row.cost?.currency === "USD")
      costBySession.set(row.wireSessionId, row.cost.amount);
  const cost = [...costBySession.values()].reduce((a, b) => a + b, 0);
  observedCost += cost;
  const data = {
    ...result,
    nativeModels: native.filter((r) => r.type === "model"),
    nativeAcpUsage: native.filter((r) => r.type === "acpUsage"),
    observedCostUsd: cost,
  };
  write(join(out, `${result.id}.json`), data);
  appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(data)}\n`);
  completed += 1;
  console.log(
    `${completed}/94 ${result.id} calls=${calls} observedCost=${observedCost.toFixed(4)}`,
  );
  if (failures >= 3 || observedCost >= 1) aborted = true;
}
async function runCase(
  id: string,
  scenario: Scenario,
  episode: Episode,
  inherited: State,
  options: { kind: string; arm: string; reflect?: boolean; repetition?: number },
) {
  const cwd = mkdtempSync(join(tmpdir(), "mentat-expanded-"));
  const memoryPath = join(cwd, "memory.json");
  write(memoryPath, inherited.memory);
  const metrics = join(out, `${id}.usage.jsonl`);
  const adapter = adapterFor(cwd, metrics);
  const input = taskInput(scenario, episode);
  const snapshot = buildTurnContext(new JsonFileMemoryStore(memoryPath), input);
  const original = await adapter.createSession(
    { cwd, model, ...assistantPromptOptions(adapter), mcpServers: [memoryMcpSpec(memoryPath)] },
    deps,
  );
  const session = contextual(original, memoryPath);
  const interactions = [...inherited.interactions];
  let first: Awaited<ReturnType<typeof sendTurn>>;
  let revision: Awaited<ReturnType<typeof sendTurn>> | null = null;
  try {
    const result = await invoke(session, input, cwd);
    first = result.turn;
    interactions.push(result.record);
    if (first.reason === "done" && episode.afterResponseFeedback) {
      const feedback = await invoke(session, episode.afterResponseFeedback, cwd);
      revision = feedback.turn;
      interactions.push(feedback.record);
    }
  } finally {
    await session.dispose();
  }
  const beforeReflection = new JsonFileMemoryStore(memoryPath).list();
  let reflection: {
    text: string;
    reason: string;
    wallTimeMs: number;
    events: AgentEvent[];
  } | null = null;
  let reflectionResult: Awaited<ReturnType<typeof reflectMemories>> | null = null;
  if (options.reflect && (revision ?? first).reason === "done") {
    budget();
    const events: AgentEvent[] = [];
    const reflector = adapterFor(cwd, metrics, true);
    const traced: HarnessAdapter = {
      ...reflector,
      createSession: async (...args) => {
        const created = await reflector.createSession(...args);
        created.subscribe((event) => events.push(event));
        return created;
      },
    };
    const start = Date.now();
    reflectionResult = await reflectMemories(traced, {
      cwd,
      model,
      task: interactions.map((r) => r.prompt).join("\n"),
      outcome: (revision ?? first).reason,
      tools: [...new Set(interactions.flatMap((r) => r.tools))],
      interactions,
    });
    await saveReflections(memoryPath, reflectionResult.candidates);
    const message = events.filter((event) => event.type === "message.completed").at(-1);
    const settled = events.filter((event) => event.type === "run.settled").at(-1);
    reflection = {
      text: message?.type === "message.completed" ? message.message.text : "",
      reason: settled?.type === "run.settled" ? settled.reason : "error",
      wallTimeMs: Date.now() - start,
      events,
    };
  }
  const after = new JsonFileMemoryStore(memoryPath).list();
  persist(
    {
      id,
      scenario: scenario.id,
      episode: episode.id,
      phase: episode.phase,
      simulatedDay: episode.simulatedDay,
      ...options,
      input,
      memoryBefore: inherited.memory,
      memoryAfterTask: beforeReflection,
      memoryAfter: after,
      context: snapshot,
      first,
      revision,
      reflection,
      reflectionResult,
      interactions,
    },
    metrics,
  );
  return { memory: after, interactions };
}

console.log(`Output: ${out}`);
// Two independent role chains; dependencies within each chain remain sequential.
let roleIndex = 0;
async function learnWorker() {
  while (!aborted && roleIndex < scenarios.length) {
    const scenario = scenarios[roleIndex++];
    if (!scenario) break;
    const checkpoints = new Map<string, State>();
    states.set(scenario.id, checkpoints);
    for (const episode of scenario.episodes) {
      if (aborted) break;
      const parent = parentCheckpoint(episode.id);
      const inherited = parent ? checkpoints.get(parent) : undefined;
      if (parent && !inherited) throw new Error(`missing frozen parent ${scenario.id}/${parent}`);
      const next = await runCase(
        `${scenario.id}-learned-${episode.id}`,
        scenario,
        episode,
        inherited ?? { memory: [], interactions: [] },
        { kind: "trajectory", arm: "learned", reflect: ["03", "07", "09"].includes(episode.id) },
      );
      checkpoints.set(episode.id, next);
    }
    for (const checkpoint of ["03", "04", "07", "09"]) {
      const path = join(out, `${scenario.id}-checkpoint-${checkpoint}.json`);
      write(path, checkpoints.get(checkpoint));
      paths[`${scenario.id}/${checkpoint}`] = path;
    }
  }
}

const jobs: Array<{ id: string; run: () => Promise<unknown> }> = [];
try {
  await Promise.all([learnWorker(), learnWorker()]);
  if (!aborted) {
    for (const scenario of scenarios)
      for (const id of ["05", "06", "08", "10"]) {
        const episode = scenario.episodes.find((e) => e.id === id);
        if (!episode) throw new Error("missing episode");
        jobs.push({
          id: `${scenario.id}-cold-${id}`,
          run: () =>
            runCase(
              `${scenario.id}-cold-${id}`,
              scenario,
              episode,
              { memory: [], interactions: [] },
              { kind: "cold-control", arm: "cold" },
            ),
        });
      }
    for (const variant of variants)
      for (const arm of ["learned", "cold"])
        for (let repetition = 1; repetition <= 2; repetition += 1) {
          const scenario = scenarios.find((s) => s.id === variant.scenario);
          if (!scenario) throw new Error("unknown scenario");
          const state =
            arm === "learned"
              ? states.get(scenario.id)?.get(variant.checkpoint)
              : { memory: [], interactions: [] };
          if (!state) throw new Error("missing checkpoint");
          const episode: Episode = {
            id: variant.id,
            phase: "novel-probe",
            simulatedDay: variant.day,
            input: { prompt: variant.prompt, source: variant.source },
            afterResponseFeedback: null,
          };
          const id = `${variant.id}-${arm}-${repetition}`;
          jobs.push({
            id,
            run: () =>
              runCase(id, scenario, episode, state, { kind: "novel-probe", arm, repetition }),
          });
        }
    // Pressure probes inherit only the prior household frozen checkpoint, not new answers.
    const seed: MemoryEntry[] = JSON.parse(
      readFileSync(join(base, "household-day07-memory.json"), "utf8"),
    );
    const target = seed.find((entry) => entry.text.includes("11:00") && entry.text.includes("48"));
    if (!target) throw new Error("missing household hard constraint");
    const noise: MemoryEntry[] = Array.from({ length: 80 }, (_, i) => ({
      id: `noise-${i}`,
      text: `其他项目历史阅读笔记${i}，与顾安出行规则无关。${"这是一段已结束的资料阅读记录，仅包含过去的笔记内容。".repeat(12)}`,
      tags: ["preference"],
      createdAt: Date.now() + i,
    }));
    const protectedSeed = seed.map((entry) =>
      entry.id === target.id ? { ...entry, tags: ["constraint"] } : entry,
    );
    const pressureScenarios = [
      { id: "small", memory: seed },
      { id: "grown", memory: [...seed, ...noise] },
      { id: "tagged", memory: [...protectedSeed, ...noise] },
    ];
    const household: Scenario = {
      id: "household-pressure",
      name: "顾安",
      role: "家庭事务管理者",
      episodes: [],
    };
    const pressureEpisode: Episode = {
      id: "pressure",
      phase: "pressure",
      simulatedDay: 23,
      input: {
        prompt: "安排这个周六取书和买菜，判断能否同一天完成。",
        source:
          "用户09:00才能出门（固定）；取书60分钟、买菜50分钟、全部路程合计25分钟；书店和菜场营业09:00–13:00；两个任务都可改期，用户本人时间规则未改变。",
      },
      afterResponseFeedback: null,
    };
    const input = taskInput(household, pressureEpisode);
    const offline = [];
    for (const variant of [
      ...pressureScenarios,
      {
        id: "same-priority-saturation",
        memory: [...noise.map((e) => ({ ...e, tags: ["constraint"] })), ...protectedSeed],
      },
    ]) {
      const storePath = join(out, `pressure-${variant.id}.memory.json`);
      write(storePath, variant.memory);
      const snapshot = buildTurnContext(new JsonFileMemoryStore(storePath), input);
      offline.push({
        id: variant.id,
        entries: variant.memory.length,
        selectedChars: snapshot.text.length,
        omittedCount: snapshot.omittedIds.length,
        targetId: target.id,
        targetPresent: snapshot.text
          .split("\n")
          .some((line) => line && JSON.parse(line).id === target.id),
        snapshot,
      });
    }
    write(join(out, "pressure-selection.json"), offline);
    for (const variant of pressureScenarios)
      for (let repetition = 1; repetition <= 2; repetition += 1) {
        const id = `pressure-${variant.id}-${repetition}`;
        jobs.push({
          id,
          run: () =>
            runCase(
              id,
              household,
              pressureEpisode,
              { memory: variant.memory, interactions: [] },
              { kind: "pressure", arm: variant.id, repetition },
            ),
        });
      }
    jobs.sort((a, b) =>
      createHash("sha256")
        .update(a.id)
        .digest("hex")
        .localeCompare(createHash("sha256").update(b.id).digest("hex")),
    );
    write(
      join(out, "probe-order.json"),
      jobs.map((j) => j.id),
    );
    let index = 0;
    async function probeWorker() {
      while (!aborted && index < jobs.length) {
        const job = jobs[index++];
        if (!job) break;
        await job.run();
      }
    }
    await Promise.all([probeWorker(), probeWorker()]);
  }
} catch (error) {
  aborted = true;
  write(join(out, "error.json"), { error: String(error) });
  console.error(error);
}
write(join(out, "summary.json"), {
  status: aborted ? "incomplete" : "completed-unscored",
  completed,
  calls,
  failures,
  observedCostUsd: observedCost,
  checkpoints: paths,
});
if (aborted) process.exitCode = 1;
