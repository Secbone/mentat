import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue, PermissionMode } from "@mentat/core";
import { CheckEvaluator, commandGate, JsonCommandEvaluator, runCommand } from "@mentat/evaluation";
import {
  AgentProposer,
  type Gate,
  GateChain,
  pathGuardGate,
  SelfIterationLoop,
  type SessionRunner,
} from "@mentat/evolution";
import { buildExperienceDigest, ExperienceStore, FileTrajectoryStore } from "@mentat/observability";
import { runOnce } from "@mentat/session";
import { GitWorkspace } from "@mentat/workspace";
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
  let prepare: string | undefined;
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
    } else if (arg === "--prepare") {
      prepare = args[++i];
    } else if (arg === "--iterations") {
      iterations = Number(args[++i] ?? "1");
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
  if (protect.length === 0) protect.push("packages/evolution/src/**");

  const registry = createDefaultRegistry(permission);
  if (!registry.has(harnessId)) {
    process.stderr.write(`iterate: unknown harness "${harnessId}"\n`);
    return 1;
  }

  let workspace: GitWorkspace;
  try {
    workspace = GitWorkspace.isolated(target);
  } catch (error) {
    process.stderr.write(`iterate: ${String(error)}\n`);
    return 1;
  }

  try {
    const executionCwd = workspace.cwd;
    const adapter = registry.get(harnessId);
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const runDir = logDir ? join(logDir, runId) : join(process.cwd(), ".mentat", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const tracer = new FileTrajectoryStore(
      runDir,
      { metadata: { runId, target, task, harness: harnessId, model: model ?? null } },
      runId,
    );

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
      const result = await runOnce(
        adapter,
        { cwd: executionCwd, ...(model ? { model } : {}) },
        { text: prompt },
        {
          tracer,
          deps: { onPermission: createPermissionHandler(permission) },
          onEvent: (event) => {
            if (event.type === "message.delta") process.stdout.write(event.text);
            else if (event.type === "tool.start") process.stdout.write(`\n[tool] ${event.name}\n`);
          },
        },
      );
      if (result.reason !== "done")
        throw new Error(result.error ?? `agent ended: ${result.reason}`);
    };

    const gates: Gate[] = [
      pathGuardGate("protected", protect, (candidate) => workspace.changedFiles(candidate)),
    ];
    if (check) gates.push(commandGate("check", { cwd: executionCwd, shell: check, tracer }));

    const evaluator = evalCmd
      ? new JsonCommandEvaluator({ cwd: executionCwd, shell: evalCmd, tracer })
      : new CheckEvaluator({ cwd: executionCwd, shell: check ?? "", tracer }, "check");

    const extraContext = fromExperience
      ? buildExperienceDigest(new ExperienceStore(experienceDir).recent(recent))
      : "";

    const loop = new SelfIterationLoop({
      workspace,
      proposer: new AgentProposer({
        task,
        cwd: executionCwd,
        runner,
        logDir: runDir,
        ...(extraContext ? { extraContext } : {}),
      }),
      evaluator,
      gates: new GateChain(gates),
      config: { maxIterations: iterations },
      tracer,
    });

    let result: Awaited<ReturnType<typeof loop.run>>;
    try {
      if (prepare) {
        const setup = await runCommand({ cwd: executionCwd, shell: prepare, tracer });
        if (!setup.ok) throw new Error(`worktree preparation failed: ${setup.stderr}`);
      }
      result = await loop.run();
      tracer.emit("workspace.publish.start", { candidateId: result.best.id, target });
      await workspace.publish(result.best);
      tracer.emit("workspace.publish.end", { candidateId: result.best.id, target });
    } catch (error) {
      tracer.emit("run.error", { error: String(error) });
      await tracer.close("error");
      throw error;
    }

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
    await tracer.close();

    process.stdout.write("\niteration  gate   accepted  reason\n");
    for (const record of result.records) {
      const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
      process.stdout.write(
        `${String(record.iteration).padEnd(10)} ${gate.padEnd(6)} ${
          record.accepted ? "yes" : "no"
        }       ${record.reason ?? ""}\n`,
      );
    }
    process.stdout.write(
      `\narchive: ${result.archive.size()} candidates, best=${result.best.id}\n`,
    );
    process.stdout.write(`log: ${runDir}\n`);
    return 0;
  } finally {
    await workspace.dispose();
  }
}
