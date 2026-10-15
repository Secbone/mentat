import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReflectedMemories, reflectionPrompt } from "@mentat/assistant";
import type { AgentEvent, SessionHandle } from "@mentat/core";
import { buildMemoryContext, InMemoryMemoryStore, rememberFact } from "@mentat/memory";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { SessionRecorder } from "@mentat/observability";
import { createAcpAdapter } from "@mentat/transport-acp";

export type Arm = "A" | "B" | "C" | "C0";
export function acpPermission(arm: Arm): Record<string, string> {
  if (arm !== "C" && arm !== "C0") return { "*": "deny" };
  // OpenCode 2.0 exposes MCP discovery/calls through its execute gateway.
  // Keep the gateway discoverable, while the host rejects unrelated requests.
  return {
    "*": "ask",
    ...Object.fromEntries(
      [
        "bash",
        "read",
        "edit",
        "write",
        "glob",
        "grep",
        "list",
        "webfetch",
        "websearch",
        "task",
        "skill",
        "todowrite",
        "todoread",
      ].map((name) => [name, "deny"]),
    ),
    "memory_*": "allow",
    "mcp__memory__*": "allow",
  };
}
interface Episode {
  id: string;
  phase: string;
  simulatedDay: number;
  input: { prompt: string; source: string };
  afterResponseFeedback: string | null;
}
interface Scenario {
  id: string;
  role: string;
  name: string;
  episodes: Episode[];
}
interface TurnResult {
  text: string;
  reason: string;
  error?: string;
  wallTimeMs: number;
  events: AgentEvent[];
}

/** Test probes are forked and never feed their own answers back into training. */
export function parentCheckpoint(id: string): string | undefined {
  const n = Number(id);
  if (n === 1) return undefined;
  if (n === 5 || n === 6 || n === 7) return "04";
  if (n === 8 || n === 9) return "07";
  return String(n - 1).padStart(2, "0");
}

export function taskInput(scenario: Pick<Scenario, "name" | "role">, episode: Episode): string {
  // Deliberately select fields: never serialize the dataset's evaluator profile/rubric.
  return [
    `用户：${scenario.name}，${scenario.role}。模拟日期：第 ${episode.simulatedDay} 天。`,
    `任务：${episode.input.prompt}`,
    `材料：${episode.input.source}`,
    "根据给定材料输出答复或草稿，不执行真实发送、购买或排会。",
  ].join("\n");
}

export async function sendTurn(
  session: SessionHandle,
  text: string,
  timeoutMs: number,
): Promise<TurnResult> {
  const start = Date.now();
  const events: AgentEvent[] = [];
  let completed = "";
  let delta = "";
  let reason = "error";
  let error: string | undefined;
  let settled: (() => void) | undefined;
  const finished = new Promise<void>((resolveFinished) => {
    settled = resolveFinished;
  });
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    if (event.type === "message.delta") delta += event.text;
    if (event.type === "message.completed") completed = event.message.text;
    if (event.type === "run.settled") {
      reason = event.reason;
      error = event.error;
      settled?.();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await session.send({ text });
        await finished;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`turn timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (caught) {
    reason = "error";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
  if (!(completed || delta).trim() && reason === "done") {
    reason = "error";
    error = "engine settled without an assistant answer";
  }
  return {
    text: completed || delta,
    reason,
    ...(error ? { error } : {}),
    wallTimeMs: Date.now() - start,
    events,
  };
}

export function lexicalDiagnostic(
  entries: Array<{ id: string; text: string; createdAt: number }>,
  query: string,
) {
  // Used by the offline diagnostic command without modifying the memory implementation.
  const store = new InMemoryMemoryStore();
  for (const entry of entries) store.add(entry);
  return { retrieved: store.search({ text: query }), context: buildMemoryContext(store, query) };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const model = arg("--model", "opencode-go/deepseek-v4.1-flash");
  const binary = arg("--opencode", "/opt/homebrew/bin/opencode");
  const harness = arg("--harness", "acp");
  if (harness !== "acp") throw new Error("this experiment runner supports ACP only");
  const timeoutMs = Number(arg("--timeout-ms", "90000"));
  const maxCalls = Number(arg("--max-calls", "150"));
  const maxCostUsd = Number(arg("--max-cost-usd", "5"));
  const requested = arg("--scenarios", "product,engineer,household").split(",");
  const arms = arg("--arms", "A,B,C").split(",") as Arm[];
  if (arms.some((arm) => !["A", "B", "C", "C0"].includes(arm))) throw new Error("unknown arm");
  const episodeSelection = arg("--episodes", "").split(",").filter(Boolean);
  if (episodeSelection.length && arms.some((arm) => !["A", "C0"].includes(arm))) {
    throw new Error("episode subsets only supported for cold controls");
  }
  for (const value of [timeoutMs, maxCalls, maxCostUsd]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("invalid budget or timeout");
  }
  const datasetPath = resolve(
    arg("--dataset", fileURLToPath(new URL("./cases.json", import.meta.url))),
  );
  const datasetText = readFileSync(datasetPath, "utf8");
  const raw = JSON.parse(datasetText);
  const seedPath = arg("--seed-memory", "");
  const seedMemory = seedPath ? JSON.parse(readFileSync(resolve(seedPath), "utf8")) : [];
  if (!Array.isArray(seedMemory)) throw new Error("seed memory must be an entry array");
  const injectMemory = args.includes("--inject-memory");
  const scenarios = (raw.scenarios as Scenario[]).filter((scenario) =>
    requested.includes(scenario.id),
  );
  if (scenarios.length !== requested.length) throw new Error("unknown or duplicate scenario");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(arg("--out", `.mentat/experiments/personal-assistant/${stamp}`));
  mkdirSync(resolve(out, ".."), { recursive: true });
  mkdirSync(out); // Never overwrite or combine trials.
  const runtimeRoot = mkdtempSync(join(tmpdir(), "mentat-assistant-runtime-"));
  const journal = join(out, "results.jsonl");
  const write = (file: string, value: unknown) =>
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  write(join(out, "config.json"), {
    model,
    datasetPath,
    datasetSha256: createHash("sha256").update(datasetText).digest("hex"),
    seedPath: seedPath || null,
    injectMemory,
    binary,
    harness,
    scenarios: requested,
    arms,
    episodeSelection,
    repetitions: 1,
    timeoutMs,
    maxCalls,
    maxCostUsd,
    semantics: {
      A: "new sessions, no MCP, no inherited memory",
      B: "human-confirmed prior feedback injected in full; retrieval-independent upper bound",
      C: "current chat MCP prompt and exact generic /reflect prompt; no manual memory writes",
      C0: "same tools/prompt as C, but a fresh empty memory for every task; controls tool availability",
    },
    instrumentation: "transparent ACP relay records native model/usage metadata",
    isolation: "tools denied except memory search/add; tasks given inline; empty per-episode cwd",
  });
  let calls = 0;
  let observedCost = 0;
  let errors = 0;

  const adapterFor = (cwd: string, metrics: string, arm: Arm) => {
    return createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fileURLToPath(new URL("./acp-observer.mjs", import.meta.url))],
      env: {
        MENTAT_OPENCODE_BIN: binary,
        MENTAT_EXPERIMENT_METRICS: metrics,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model,
          small_model: model,
          autoupdate: false,
          share: "disabled",
          permission: acpPermission(arm),
          instructions: [],
          plugin: [],
        }),
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_DIR: join(cwd, "opencode-config"),
      },
    });
  };
  const deps = {
    onPermission: {
      request: (request: { toolName: string }) =>
        /^(?:mcp__memory__|memory_)?memory_(?:search|add)$/.test(request.toolName)
          ? ("allow" as const)
          : ("deny" as const),
    },
  };
  const invoke = async (session: SessionHandle, prompt: string) => {
    if (calls >= maxCalls || observedCost >= maxCostUsd)
      throw new Error("experiment budget reached");
    calls += 1;
    return sendTurn(session, prompt, timeoutMs);
  };

  for (const scenario of scenarios) {
    for (const arm of arms) {
      const checkpoints = new Map<string, unknown[]>();
      if (seedPath) checkpoints.set("07", seedMemory);
      for (const episode of scenario.episodes) {
        if (episodeSelection.length && !episodeSelection.includes(episode.id)) continue;
        const id = `${scenario.id}-${arm}-${episode.id}`;
        const cwd = join(runtimeRoot, id);
        mkdirSync(cwd);
        const memoryPath = join(cwd, "memory.json");
        const parent = parentCheckpoint(episode.id);
        const cold = arm === "A" || arm === "C0";
        const inherited = cold ? [] : parent ? (checkpoints.get(parent) ?? []) : [];
        write(memoryPath, inherited);
        const memory = new JsonFileMemoryStore(memoryPath);
        const input = taskInput(scenario, episode);
        let context =
          arm === "B"
            ? [
                "已由用户确认且仅来自之前任务的记忆：",
                ...memory.list().map((entry) => `- ${entry.text}`),
              ].join("\n")
            : arm === "C" || arm === "C0"
              ? "You can use the memory_search and memory_add tools to recall or store durable facts about this user and project."
              : "";
        if (injectMemory && !cold) {
          context += `\n已保存的历史记忆（仅在相关且未被当前明确指令更新时采用）：\n${memory
            .list()
            .map((entry) => `- ${entry.text}`)
            .join("\n")}`;
        }
        const metrics = join(out, `${id}.usage.jsonl`);
        const adapter = adapterFor(cwd, metrics, arm);
        const session = await adapter.createSession(
          {
            cwd,
            model,
            ...(context ? { systemPrompt: context } : {}),
            ...(arm === "C" || arm === "C0" ? { mcpServers: [memoryMcpSpec(memoryPath)] } : {}),
          },
          deps,
        );
        let first: TurnResult;
        let revision: TurnResult | undefined;
        try {
          first = await invoke(session, input);
          if (first.reason === "done" && episode.afterResponseFeedback) {
            revision = await invoke(session, episode.afterResponseFeedback);
          }
        } finally {
          await session.dispose();
        }
        const finalTurn = revision ?? first;
        let reflection: TurnResult | undefined;
        if (arm === "B" && finalTurn.reason === "done") {
          if (episode.afterResponseFeedback) rememberFact(memory, episode.afterResponseFeedback);
          if (episode.phase === "change") rememberFact(memory, episode.input.prompt);
        }
        if (
          arm === "C" &&
          finalTurn.reason === "done" &&
          ["learn", "noise", "change", "exception"].includes(episode.phase)
        ) {
          // Exactly the current chat /reflect payload: deliberately no full conversation.
          const reflector = await adapter.createSession({ cwd, model }, deps);
          try {
            reflection = await invoke(
              reflector,
              reflectionPrompt({
                task: "(interactive chat)",
                outcome: finalTurn.reason,
                tools: [],
              }),
            );
          } finally {
            await reflector.dispose();
          }
          if (reflection.reason === "done") {
            const latest = new JsonFileMemoryStore(memoryPath);
            for (const fact of parseReflectedMemories(reflection.text)) rememberFact(latest, fact);
          }
        }
        const after = new JsonFileMemoryStore(memoryPath).list();
        checkpoints.set(episode.id, after);
        const native = existsSync(metrics)
          ? readFileSync(metrics, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
        const usages = native.filter((entry) => entry.type === "usage");
        const acpCostBySession = new Map<string, number>();
        for (const entry of native) {
          if (entry.type === "acpUsage" && entry.cost?.currency === "USD") {
            // ACP usage updates are cumulative for a session, not per-message deltas.
            acpCostBySession.set(entry.wireSessionId, entry.cost.amount);
          }
        }
        const cost = [...acpCostBySession.values()].reduce((sum, value) => sum + value, 0);
        observedCost += cost;
        const recorder = new SessionRecorder({ prompt: input, cwd, harness, model });
        for (const turn of [first, revision].filter(Boolean) as TurnResult[]) {
          for (const event of turn.events) recorder.handle(event);
        }
        const result = {
          id,
          scenario: scenario.id,
          arm,
          episode: episode.id,
          phase: episode.phase,
          parentCheckpoint: cold ? null : (parent ?? null),
          input,
          first,
          revision: revision ?? null,
          reflection: reflection ?? null,
          memoryBefore: inherited,
          memoryAfter: after,
          injection: context,
          retrievalDiagnostic: buildMemoryContext(new JsonFileMemoryStore(memoryPath), input),
          nativeModels: native.filter((entry) => entry.type === "model"),
          nativeAcpUsage: native.filter((entry) => entry.type === "acpUsage"),
          usage: {
            inputTokens: usages.length
              ? usages.reduce((sum, entry) => sum + (entry.usage?.input ?? 0), 0)
              : null,
            outputTokens: usages.length
              ? usages.reduce((sum, entry) => sum + (entry.usage?.output ?? 0), 0)
              : null,
            cacheReadTokens: usages.length
              ? usages.reduce((sum, entry) => sum + (entry.usage?.cacheRead ?? 0), 0)
              : null,
            costUsd:
              acpCostBySession.size ||
              usages.some((entry) => typeof entry.usage?.cost?.total === "number")
                ? cost
                : null,
            observed: usages.length > 0 || acpCostBySession.size > 0,
            scope: "first answer plus training revision and reflection",
          },
          experience: recorder.snapshot(),
          score: null,
        };
        appendFileSync(journal, `${JSON.stringify(result)}\n`);
        write(join(out, `${id}.json`), result);
        console.log(
          `${id} ${first.reason} memory=${inherited.length}->${after.length} calls=${calls} cost=${observedCost.toFixed(4)}`,
        );
        if (first.reason !== "done") errors += 1;
        if (errors >= 3)
          throw new Error("three failed task calls; stop instead of fabricating results");
      }
    }
  }
  write(join(out, "summary.json"), {
    status: "completed-unscored",
    calls,
    observedCostUsd: observedCost,
    errors,
  });
  console.log(`Results: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
