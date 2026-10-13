import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  type AgentEvent,
  buildMemoryContext,
  type Candidate,
  createFakeAdapter,
  FunctionEvaluator,
  type Gate,
  GateChain,
  type HarnessAdapter,
  type JsonValue,
  type McpServerSpec,
  type MemoryEntry,
  memoryArtifact,
  memoryGate,
  type PermissionHandler,
  type Proposer,
  pathGuardGate,
  type RecallQuery,
  RuleMemoryProposer,
  recallTask,
  rememberFact,
  runDemoLoop,
  runMemoryEvolutionDemo,
  SelfIterationLoop,
} from "@mentat/core";
import {
  AgentDataProposer,
  AgentProposer,
  type ArtifactSnapshot,
  buildExperienceDigest,
  CheckEvaluator,
  commandGate,
  ExperienceStore,
  extractJson,
  GitWorkspace,
  JsonCommandEvaluator,
  JsonFileMemoryStore,
  JsonlTracer,
  JsonStoreWorkspace,
  parseReflectedMemories,
  reflectionPrompt,
  SessionRecorder,
  type SessionRunner,
} from "@mentat/iterate";
import { createPiAdapter, type PermissionMode } from "@mentat/transport-pi";

const USAGE = `mentat — a self-iterating agent framework

Usage:
  mentat harness list
  mentat run "<prompt>" [--harness <id>] [--model <id>] [--cwd <path>] [--memory <file>] [--remember "<fact>"]... [--reflect] [--experience <dir>] [--permission <ask|auto|full>]
  mentat chat [--harness <id>] [--model <id>] [--cwd <path>] [--memory <file>] [--experience <dir>] [--permission <ask|auto|full>]
  mentat loop demo|memory
  mentat evolve memory --queries <file> (--facts <file> | --agent [--from-experience] [--experience <dir>] [--recent <n>]) [--model <id>] [--store <dir>] [--iterations <n>]
  mentat iterate --target <dir> --task "<goal>" --check "<cmd>" [--eval "<cmd>"]
  mentat trace [<run-dir>] [--raw]
  mentat help

Options:
  --harness <id>       harness adapter to use (default: fake)
  --model <id>         model id passed to the harness
  --cwd <path>         working directory (default: process.cwd())
  --permission <mode>  ask | auto | full (default: auto)
  --yes                shorthand for --permission full

iterate options:
  --target <dir>       git repo the agent edits (default: process.cwd())
  --task "<goal>"      what the agent should achieve (required)
  --check "<cmd>"      gate + default evaluator: pass=1, fail=0 (required unless --eval)
  --eval "<cmd>"       evaluator command printing a Signal[] JSON array on stdout
  --iterations <n>     how many iterations to attempt (default: 1)
  --protect <glob>     被保护的路径，禁止 agent 修改（可重复；默认 packages/core/src/loop/**）
  --from-experience    feed a digest of recent experiences into the proposer

  --experience <dir>   experience store directory (default: .mentat/experience)
  --recent <n>         how many recent experiences to feed (default: 20)
`;

export function createDefaultRegistry(permissionMode: PermissionMode = "auto"): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createFakeAdapter());
  registry.register(createPiAdapter({ permissionMode }));
  return registry;
}

function createPermissionHandler(mode: PermissionMode): PermissionHandler {
  if (mode === "ask") {
    return {
      request: async (request) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = await rl.question(
            `\n[permission] allow ${request.toolName} ${JSON.stringify(request.input)}? (y/N) `,
          );
          return answer.trim().toLowerCase().startsWith("y") ? "allow" : "deny";
        } finally {
          rl.close();
        }
      },
    };
  }
  return { request: () => "allow" };
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

async function loopCommand(args: string[]): Promise<number> {
  const kind = args[0];
  if (kind !== "demo" && kind !== "memory") {
    process.stderr.write("usage: mentat loop demo|memory\n");
    return 1;
  }
  const result = kind === "memory" ? await runMemoryEvolutionDemo() : await runDemoLoop();

  const metrics = new Set<string>();
  for (const record of result.records) {
    for (const signal of record.after ?? []) metrics.add(signal.name);
  }
  const metricNames = [...metrics];

  process.stdout.write(`iter  child      gate   accepted  ${metricNames.join("  ")}\n`);
  for (const record of result.records) {
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    const values = metricNames.map((name) =>
      String(record.after?.find((signal) => signal.name === name)?.value ?? "-"),
    );
    const verdict = record.accepted ? "yes" : `no (${record.reason ?? "rejected"})`;
    process.stdout.write(
      `${String(record.iteration).padEnd(5)} ${record.childId.padEnd(10)} ${gate.padEnd(6)} ${(record.accepted ? "yes" : "no").padEnd(9)} ${values.join("  ").padEnd(14)} ${record.accepted ? "" : verdict}\n`,
    );
  }
  process.stdout.write(`\narchive: ${result.archive.size()} candidates, best=${result.best.id}\n`);
  return 0;
}

function createAgentMemoryProposer(
  queries: RecallQuery[],
  model: string | undefined,
  digest = "",
): Proposer {
  const adapter = createDefaultRegistry("full").get("pi");
  const runner = async (prompt: string): Promise<string> => {
    const session = await adapter.createSession(
      { cwd: process.cwd(), ...(model ? { model } : {}) },
      { onPermission: createPermissionHandler("full") },
    );
    let text = "";
    try {
      const settled = new Promise<void>((resolve) => {
        session.subscribe((event: AgentEvent) => {
          if (event.type === "message.completed") text = event.message.text;
          else if (event.type === "run.settled") resolve();
        });
      });
      await session.send({ text: prompt });
      await settled;
    } finally {
      await session.dispose();
    }
    return text;
  };

  return new AgentDataProposer({
    task: "evolve memory",
    cwd: process.cwd(),
    runner,
    buildPrompt: ({ parent, signals }) =>
      [
        "You maintain the memory store of a coding agent. Improve recall without adding noise.",
        `Queries that must be answerable (query -> expected memory id): ${JSON.stringify(queries)}`,
        `Current memory entries: ${JSON.stringify(parent.artifacts[0]?.snapshot() ?? [])}`,
        `Current signals: ${JSON.stringify(signals)}`,
        ...(digest
          ? ["", "What actually happened recently (use it to decide what memory to add):", digest]
          : []),
        'Return ONLY a JSON array of entries {"id":string,"text":string,"createdAt":number(epoch ms)}. Keep useful existing entries.',
      ].join("\n"),
    parse: (output) => {
      const parsed = extractJson(output);
      const entries = Array.isArray(parsed) ? (parsed as unknown as MemoryEntry[]) : [];
      return [memoryArtifact("memory", entries)];
    },
  });
}

async function evolveCommand(args: string[]): Promise<number> {
  if (args[0] !== "memory") {
    process.stderr.write(
      "usage: mentat evolve memory --queries <file> [--facts <file> | --agent [--from-experience]] [--model <id>] [--store <dir>] [--iterations <n>]\n",
    );
    return 1;
  }

  let store = join(process.cwd(), ".mentat", "memory");
  let factsPath: string | undefined;
  let queriesPath: string | undefined;
  let iterations = 0;
  let useAgent = false;
  let model: string | undefined;
  let fromExperience = false;
  let experienceDir = join(process.cwd(), ".mentat", "experience");
  let recent = 20;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--store") store = args[++i] ?? store;
    else if (arg === "--facts") factsPath = args[++i];
    else if (arg === "--queries") queriesPath = args[++i];
    else if (arg === "--iterations") iterations = Number(args[++i] ?? "0") || 0;
    else if (arg === "--agent") useAgent = true;
    else if (arg === "--model") model = args[++i];
    else if (arg === "--from-experience") fromExperience = true;
    else if (arg === "--experience") experienceDir = args[++i] ?? experienceDir;
    else if (arg === "--recent") recent = Number(args[++i] ?? "20") || 20;
  }
  if (!queriesPath || (!factsPath && !useAgent)) {
    process.stderr.write("evolve memory: --queries is required (and --facts unless --agent)\n");
    return 1;
  }
  if (fromExperience && !useAgent) {
    process.stderr.write("evolve memory: --from-experience requires --agent\n");
    return 1;
  }

  const facts = factsPath ? (JSON.parse(readFileSync(factsPath, "utf8")) as MemoryEntry[]) : [];
  const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as RecallQuery[];
  const rebuild = (snapshot: ArtifactSnapshot) =>
    memoryArtifact(snapshot.id, snapshot.snapshot as unknown as MemoryEntry[]);

  const root: Candidate = JsonStoreWorkspace.load(store, rebuild) ?? {
    id: "root",
    version: "root",
    artifacts: [memoryArtifact("memory", [])],
  };

  const digest = fromExperience
    ? buildExperienceDigest(new ExperienceStore(experienceDir).recent(recent))
    : "";
  const proposer = useAgent
    ? createAgentMemoryProposer(queries, model, digest)
    : new RuleMemoryProposer(facts);

  const loop = new SelfIterationLoop({
    workspace: new JsonStoreWorkspace(store, root),
    proposer,
    evaluator: new FunctionEvaluator([recallTask(queries)]),
    gates: new GateChain([memoryGate()]),
    config: { maxIterations: iterations > 0 ? iterations : useAgent ? 1 : facts.length },
  });
  const result = await loop.run();

  process.stdout.write("iter  child        gate   accepted  recall  noise\n");
  for (const record of result.records) {
    const recall = record.after?.find((signal) => signal.name === "recall")?.value ?? "-";
    const noise = record.after?.find((signal) => signal.name === "noise")?.value ?? "-";
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    process.stdout.write(
      `${String(record.iteration).padEnd(5)} ${record.childId.padEnd(12)} ${gate.padEnd(6)} ${(record.accepted ? "yes" : "no").padEnd(9)} ${String(recall).padEnd(7)} ${noise}\n`,
    );
  }
  process.stdout.write(`\nstore: ${store}\nbest: ${result.best.id}\n`);
  return 0;
}

async function iterateCommand(args: string[]): Promise<number> {
  let target = process.cwd();
  let task = "";
  let harnessId = "pi";
  let model: string | undefined;
  let permission: PermissionMode = "full";
  let check: string | undefined;
  let evalCmd: string | undefined;
  let iterations = 1;
  let logDir: string | undefined;
  let fromExperience = false;
  let experienceDir = join(process.cwd(), ".mentat", "experience");
  let recent = 20;
  const protect: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target") {
      target = args[++i] ?? target;
    } else if (arg === "--task") {
      task = args[++i] ?? "";
    } else if (arg === "--harness") {
      harnessId = args[++i] ?? "";
    } else if (arg === "--model") {
      model = args[++i];
    } else if (arg === "--permission") {
      permission = parsePermissionMode(args[++i]);
    } else if (arg === "--yes" || arg === "-y") {
      permission = "full";
    } else if (arg === "--check") {
      check = args[++i];
    } else if (arg === "--eval") {
      evalCmd = args[++i];
    } else if (arg === "--iterations") {
      iterations = Number(args[++i] ?? "1") || 1;
    } else if (arg === "--protect") {
      const value = args[++i];
      if (value) protect.push(value);
    } else if (arg === "--log-dir") {
      logDir = args[++i];
    } else if (arg === "--from-experience") {
      fromExperience = true;
    } else if (arg === "--experience") {
      experienceDir = args[++i] ?? experienceDir;
    } else if (arg === "--recent") {
      recent = Number(args[++i] ?? "20") || 20;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  if (!task) task = positional.join(" ").trim();
  if (!task) {
    process.stderr.write("iterate: missing --task\n");
    return 1;
  }
  if (!check && !evalCmd) {
    process.stderr.write("iterate: provide --check or --eval\n");
    return 1;
  }
  if (protect.length === 0) protect.push("packages/core/src/loop/**");

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`iterate: unknown harness "${harnessId}"\n`);
    return 1;
  }

  let workspace: GitWorkspace;
  try {
    workspace = new GitWorkspace(target);
  } catch {
    process.stderr.write(`iterate: "${target}" is not a git repository with a commit\n`);
    return 1;
  }

  const adapter = registry.get(harnessId);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const runDir = logDir ? join(logDir, runId) : join(process.cwd(), ".mentat", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const tracer = new JsonlTracer(join(runDir, "trace.jsonl"), { runId });

  const summarize = (event: AgentEvent): JsonValue => {
    switch (event.type) {
      case "tool.start":
        return { type: event.type, name: event.name, input: event.input };
      case "tool.result":
        return {
          type: event.type,
          id: event.id,
          isError: event.isError,
          output: event.output.slice(0, 4000),
        };
      case "message.completed":
        return { type: event.type, text: event.message.text };
      case "message.delta":
      case "message.reasoning":
        return { type: event.type, text: event.text.slice(0, 2000) };
      case "run.settled":
        return { type: event.type, reason: event.reason };
      case "permission.request":
        return { type: event.type, toolName: event.request.toolName };
      case "permission.resolved":
        return { type: event.type, decision: event.decision };
      case "usage":
        return {
          type: event.type,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.usage.costUsd ?? 0,
        };
      default:
        return { type: event.type };
    }
  };

  tracer.emit("run.start", {
    target,
    task,
    harness: harnessId,
    model: model ?? null,
    check: check ?? null,
    eval: evalCmd ?? null,
    protect,
    permission,
  });

  const runner: SessionRunner = async (prompt) => {
    tracer.emit("agent.prompt", { prompt });
    const session = await adapter.createSession(
      { cwd: target, ...(model ? { model } : {}) },
      { onPermission: createPermissionHandler(permission) },
    );
    try {
      const settled = new Promise<void>((resolve) => {
        session.subscribe((event: AgentEvent) => {
          tracer.emit("agent.event", summarize(event));
          if (event.type === "run.settled") resolve();
          else if (event.type === "message.delta") process.stdout.write(event.text);
          else if (event.type === "tool.start") process.stdout.write(`\n[tool] ${event.name}\n`);
        });
      });
      await session.send({ text: prompt });
      await settled;
    } finally {
      await session.dispose();
    }
  };

  const gates: Gate[] = [
    pathGuardGate("protected", protect, (candidate) => workspace.changedFiles(candidate)),
  ];
  if (check) gates.push(commandGate("check", { cwd: target, shell: check }));

  const evaluator = evalCmd
    ? new JsonCommandEvaluator({ cwd: target, shell: evalCmd })
    : new CheckEvaluator({ cwd: target, shell: check ?? "" }, "check");

  const extraContext = fromExperience
    ? buildExperienceDigest(new ExperienceStore(experienceDir).recent(recent))
    : "";

  const loop = new SelfIterationLoop({
    workspace,
    proposer: new AgentProposer({
      task,
      cwd: target,
      runner,
      logDir: runDir,
      ...(extraContext ? { extraContext } : {}),
    }),
    evaluator,
    gates: new GateChain(gates),
    config: { maxIterations: iterations },
    tracer,
  });

  const result = await loop.run();

  const recordsJson: JsonValue[] = result.records.map((record) => {
    // only records that materialized a real candidate (evaluated) have a commit to diff
    if (record.after !== undefined && record.childId !== record.parentId) {
      try {
        const diff = workspace.diffShas(record.parentId, record.childId);
        if (diff.length > 0) writeFileSync(join(runDir, `iter-${record.iteration}.diff`), diff);
      } catch {
        /* root or missing commit */
      }
    }
    return {
      iteration: record.iteration,
      parentId: record.parentId,
      childId: record.childId,
      description: record.proposal.description,
      gate: record.gate?.gate ?? "none",
      gatePassed: record.gate?.passed ?? true,
      accepted: record.accepted,
      reason: record.reason ?? null,
      before: record.before as unknown as JsonValue,
      after: (record.after as unknown as JsonValue) ?? null,
    };
  });
  const summary: JsonValue = {
    runId,
    target,
    task,
    harness: harnessId,
    model: model ?? null,
    check: check ?? null,
    eval: evalCmd ?? null,
    protect,
    best: result.best.id,
    archiveSize: result.archive.size(),
    records: recordsJson,
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
  tracer.emit("run.end", { best: result.best.id, records: result.records.length });

  process.stdout.write("\niteration  gate   accepted  reason\n");
  for (const record of result.records) {
    const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
    process.stdout.write(
      `${String(record.iteration).padEnd(10)} ${gate.padEnd(6)} ${
        record.accepted ? "yes" : "no"
      }       ${record.reason ?? ""}\n`,
    );
  }
  process.stdout.write(`\narchive: ${result.archive.size()} candidates, best=${result.best.id}\n`);
  process.stdout.write(`log: ${runDir}\n`);
  return 0;
}

function latestRunDir(): string | undefined {
  const base = join(process.cwd(), ".mentat", "runs");
  if (!existsSync(base)) return undefined;
  const entries = readdirSync(base).sort();
  const last = entries[entries.length - 1];
  return last ? join(base, last) : undefined;
}

function traceCommand(args: string[]): number {
  const dirArg = args.find((arg) => !arg.startsWith("-"));
  const raw = args.includes("--raw");
  const dir = dirArg ?? latestRunDir();
  if (!dir) {
    process.stderr.write("trace: no run directory found (run `mentat iterate` first)\n");
    return 1;
  }
  const tracePath = join(dir, "trace.jsonl");
  if (!existsSync(tracePath)) {
    process.stderr.write(`trace: no trace.jsonl in ${dir}\n`);
    return 1;
  }
  const all = args.includes("--all");
  process.stdout.write(`run: ${dir}${raw ? " (raw)" : ""}\n`);
  const lines = readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (raw) {
      process.stdout.write(`${line}\n`);
      continue;
    }
    let event: { ts?: number; type?: string; data?: { type?: string } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      process.stdout.write(`${line}\n`);
      continue;
    }
    // Collapse token-level deltas and per-event usage unless --all is passed.
    if (
      !all &&
      event.type === "agent.event" &&
      (event.data?.type === "message.delta" ||
        event.data?.type === "message.reasoning" ||
        event.data?.type === "usage")
    ) {
      continue;
    }
    const time = event.ts ? new Date(event.ts).toISOString().slice(11, 19) : "--:--:--";
    const data = event.data === undefined ? "" : ` ${JSON.stringify(event.data)}`;
    process.stdout.write(`${time}  ${event.type ?? "?"}${data}\n`);
  }
  return 0;
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  if (value === "ask" || value === "auto" || value === "full") return value;
  process.stderr.write(`run: invalid permission mode "${value ?? ""}"\n`);
  return "auto";
}

async function reflectMemories(
  adapter: HarnessAdapter,
  options: { cwd: string; model?: string; task: string; outcome: string; tools: string[] },
): Promise<string[]> {
  const session = await adapter.createSession(
    { cwd: options.cwd, ...(options.model ? { model: options.model } : {}) },
    { onPermission: createPermissionHandler("full") },
  );
  let text = "";
  try {
    const settled = new Promise<void>((resolve) => {
      session.subscribe((event: AgentEvent) => {
        if (event.type === "message.completed") text = event.message.text;
        else if (event.type === "run.settled") resolve();
      });
    });
    await session.send({ text: reflectionPrompt(options) });
    await settled;
  } finally {
    await session.dispose();
  }
  return parseReflectedMemories(text);
}

async function chatCommand(args: string[]): Promise<number> {
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

  memoryPath ??= join(cwd, ".mentat", "memory.json");
  experienceDir ??= join(cwd, ".mentat", "experience");

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`chat: unknown harness "${harnessId}"\n`);
    return 1;
  }

  const memory = new JsonFileMemoryStore(memoryPath);
  const memoryMcp: McpServerSpec = {
    name: "memory",
    command: process.execPath,
    args: [fileURLToPath(new URL("../../memory-mcp/src/server.mjs", import.meta.url))],
    env: { MENTAT_MEMORY_FILE: memoryPath },
  };
  const session = await registry.get(harnessId).createSession(
    {
      cwd,
      ...(model ? { model } : {}),
      systemPrompt:
        "You can use the memory_search and memory_add tools to recall or store durable facts about this user and project.",
      mcpServers: [memoryMcp],
    },
    { onPermission: createPermissionHandler(permission) },
  );
  const experience = new ExperienceStore(experienceDir);

  let resolveSettled: (() => void) | undefined;
  let lastOutcome = "error";
  let recorder: SessionRecorder | undefined;

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
      const entry = rememberFact(memory, text.slice("/remember ".length));
      process.stdout.write(entry ? `stored ${entry.id}\n` : "duplicate or blank\n");
      continue;
    }
    if (text === "/reflect") {
      const facts = await reflectMemories(registry.get(harnessId), {
        cwd,
        ...(model ? { model } : {}),
        task: "(interactive chat)",
        outcome: lastOutcome,
        tools: [],
      });
      let added = 0;
      for (const fact of facts) if (rememberFact(memory, fact)) added += 1;
      process.stdout.write(`reflect: +${added}\n`);
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
      await session.send({ text });
      await settled;
    } catch (error) {
      process.stdout.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resolveSettled = undefined;
      if (recorder) experience.append(recorder.snapshot());
      recorder = undefined;
    }
    process.stdout.write("\n");
  }

  rl.close();
  await session.dispose();
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
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

  memoryPath ??= join(cwd, ".mentat", "memory.json");
  experienceDir ??= join(cwd, ".mentat", "experience");

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

  const memory = new JsonFileMemoryStore(memoryPath);
  const memoryContext = buildMemoryContext(memory, prompt);
  const memoryMcp: McpServerSpec = {
    name: "memory",
    command: process.execPath,
    args: [fileURLToPath(new URL("../../memory-mcp/src/server.mjs", import.meta.url))],
    env: { MENTAT_MEMORY_FILE: memoryPath },
  };

  const adapter = registry.get(harnessId);
  const session = await adapter.createSession(
    {
      cwd,
      ...(model ? { model } : {}),
      ...(memoryContext ? { systemPrompt: memoryContext } : {}),
      mcpServers: [memoryMcp],
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
    await session.send({ text: prompt });
    await settled;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    reason = "error";
  } finally {
    await session.dispose();
  }
  new ExperienceStore(experienceDir).append(recorder.snapshot());

  let added = 0;
  for (const fact of remember) if (rememberFact(memory, fact)) added += 1;
  if (remember.length > 0) {
    process.stderr.write(`memory: +${added} (${remember.length - added} duplicate)\n`);
  }

  if (reflect && reason === "done") {
    const facts = await reflectMemories(adapter, {
      cwd,
      ...(model ? { model } : {}),
      task: prompt,
      outcome: reason,
      tools: recorder.snapshot().tools,
    });
    let reflected = 0;
    for (const fact of facts) if (rememberFact(memory, fact)) reflected += 1;
    process.stderr.write(`reflect: +${reflected} (${facts.length - reflected} duplicate)\n`);
  }
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
    case "chat":
      return chatCommand(rest);
    case "loop":
      return loopCommand(rest);
    case "evolve":
      return evolveCommand(rest);
    case "iterate":
      return iterateCommand(rest);
    case "trace":
      return traceCommand(rest);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}
