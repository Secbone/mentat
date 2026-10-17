import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, type RunPlan, type SubjectFactory } from "@mentat/benchmark";
import { sha256 } from "@mentat/benchmark-file";
import { createAssistantHost } from "@mentat/host";
import { FileMemoryRepository } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
import { benchmarkObservations } from "./benchmark-observations";
import { createDefaultRegistry } from "./registry";

/** Hash the actual tracked + untracked nonignored checkout, not just its HEAD label. */
export function checkoutIdentity(cwd: string, archivePath?: string) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const names = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const archive: unknown[] = [];
  const files = names.map((name) => {
    try {
      const path = join(cwd, name),
        stat = lstatSync(path);
      const content = stat.isFile() ? readFileSync(path) : undefined;
      const target = stat.isSymbolicLink() ? readlinkSync(path) : undefined;
      if (archivePath)
        archive.push({
          name,
          mode: stat.mode,
          ...(target !== undefined ? { target } : {}),
          ...(content !== undefined ? { base64: content.toString("base64") } : {}),
        });
      return [
        name,
        stat.mode,
        target !== undefined
          ? sha256(target)
          : content !== undefined
            ? sha256(content)
            : "non-file",
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (archivePath) archive.push({ name, deleted: true });
      return [name, "deleted"];
    }
  });
  const identity = { revision, codeSha256: sha256(JSON.stringify(files)) };
  if (archivePath)
    writeFileSync(archivePath, JSON.stringify({ ...identity, files: archive }), {
      flag: "wx",
      mode: 0o600,
    });
  return identity;
}
/** Native episodes measure host memory behavior; official tool environments use their upstream runner. */
export function mentatBenchmarkSubject(plan: RunPlan, out: string): SubjectFactory {
  const registry = createDefaultRegistry(
    "ask",
    plan.protocol.config.isolateOpenCode === true
      ? {
          acp: {
            binary: "opencode",
            baseArgs: ["acp"],
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                model: plan.subject.model,
                small_model: plan.subject.model,
                autoupdate: false,
                share: "disabled",
                instructions: [],
                plugin: [],
                permission: { "*": "deny" },
              }),
              OPENCODE_DISABLE_AUTOUPDATE: "true",
            },
          },
        }
      : {},
  );
  assert(registry.has(plan.subject.harness), `unknown harness ${plan.subject.harness}`);
  assert(
    plan.protocol.config.permission === "deny",
    "native benchmark requires explicit permission=deny; delegate tool environments to upstream sandboxes",
  );
  return async ({ stateKey, unit }) => {
    const state = join(out, "state", sha256(stateKey));
    const trial = join(
      out,
      "trials",
      sha256(JSON.stringify([unit.caseId, unit.arm, unit.repetition])),
    );
    const cwd = join(trial, "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(state, { recursive: true });
    const memoryPath = join(state, "memory.json"),
      experienceDir = join(state, "experience");
    const snapshot = async (name: string) =>
      writeFileSync(
        join(trial, name),
        JSON.stringify((await new FileMemoryRepository(memoryPath).snapshot()).entries, null, 2),
        { flag: "wx" },
      );
    await snapshot("memory-before.json");
    const host = createAssistantHost({
      cwd,
      adapter: registry.get(plan.subject.harness),
      model: plan.subject.model,
      memoryPath,
      experienceDir,
      logDir: join(trial, "trace"),
      scope: sha256(stateKey),
      timeoutMs: plan.protocol.turnTimeoutMs,
      permissionMode: "deny",
      permission: { request: () => "deny" },
      protocolLog: true,
    });
    let session: Awaited<ReturnType<typeof host.open>>;
    try {
      session = await host.open();
    } catch (error) {
      await host.close();
      throw error;
    }
    let turn = 0;
    return {
      async turn(input) {
        const { result } = await host.turn(session, input, {
          timeoutMs: plan.protocol.turnTimeoutMs,
        });
        const path = join(trial, `turn-${turn++}.json`);
        writeFileSync(path, JSON.stringify({ input, result }, null, 2), { flag: "wx" });
        return {
          text: result.text,
          ok: result.reason === "done",
          costUsd: result.usage?.costUsd ?? null,
          evidence: [path, host.logDir ?? host.traceId],
        };
      },
      async remember(input) {
        const result = await host.remember(input);
        assert(result.op !== "reject", `explicit memory rejected: ${JSON.stringify(result)}`);
      },
      async reflect() {
        const interactions = new ExperienceStore(experienceDir).list();
        const result = await host.reflect(
          {
            task: "Reflect on observed interactions only.",
            outcome: "done",
            tools: [...new Set(interactions.flatMap((r) => r.tools))],
            interactions,
          },
          { timeoutMs: plan.protocol.turnTimeoutMs },
        );
        writeFileSync(join(trial, "reflection.json"), JSON.stringify(result, null, 2), {
          flag: "wx",
        });
        return {
          costUsd: null,
          evidence: [join(trial, "reflection.json"), host.logDir ?? host.traceId],
          result: {
            status:
              result.status === "ok" &&
              !["rejected", "partial", "not-applied"].includes(result.applicationStatus)
                ? ("completed" as const)
                : ("invalid" as const),
            added: result.added,
            merged: result.merged,
            skipped: result.skipped,
            rejected: result.rejected,
          },
        };
      },
      async close() {
        try {
          await host.close();
        } finally {
          await snapshot("memory-after.json");
        }
        const observations = benchmarkObservations(host.logDir);
        writeFileSync(join(trial, "verification.json"), JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        if (plan.protocol.config.requireModelConfirmation === true)
          assert(observations.models.length > 0, "actual ACP model identity not confirmed");
        return {
          costUsd: observations.costUsd,
          evidence: [join(trial, "verification.json")],
          observations,
        };
      },
    };
  };
}
