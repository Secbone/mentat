import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type Gate,
  GateChain,
  type JsonValue,
  pathGuardGate,
  SelfIterationLoop,
} from "@mentat/core";
import { buildExperienceDigest, ExperienceStore } from "@mentat/memory";
import {
  AgentProposer,
  CheckEvaluator,
  commandGate,
  GitWorkspace,
  JsonCommandEvaluator,
  JsonlTracer,
  type SessionRunner,
} from "@mentat/runtime";
import type { PermissionMode } from "@mentat/transport-pi";
import { defaultExperienceDir } from "../lib/paths";
import { createPermissionHandler, parsePermissionMode } from "../lib/permission";
import { createDefaultRegistry } from "../lib/registry";

export async function iterateCommand(args: string[]): Promise<number> {
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
  let experienceDir = defaultExperienceDir(process.cwd());
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
