import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assert, type BenchmarkRun, canonical, object, type RunPlan } from "@mentat/benchmark";
import { runCommand } from "@mentat/evaluation";
import { defaultResultAdapters } from "./adapters";
import { sha256 } from "./digest";
import { createRunDirectory, makeRun, readResultInput, saveRun } from "./storage";

export interface ExternalJob {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  adapter: string;
  /** Must resolve inside the new run directory. {runDir} is the only substitution. */
  resultPath: string;
}
export function validateJob(value: unknown): ExternalJob {
  const job = object(value);
  for (const key of ["command", "cwd", "adapter", "resultPath"])
    assert(typeof job[key] === "string" && String(job[key]).trim(), `invalid job.${key}`);
  assert(
    Array.isArray(job.args) && job.args.every((x) => typeof x === "string"),
    "job args required",
  );
  assert(Number.isSafeInteger(job.timeoutMs) && Number(job.timeoutMs) > 0, "job timeout required");
  assert(
    !("shell" in job) && !("env" in job),
    "use argv and inherited credentials, not shell or serialized secrets",
  );
  return value as ExternalJob;
}
/** Delegate execution to the original harness; this layer owns run identity and result coverage. */
export async function runExternal(plan: RunPlan, rawJob: ExternalJob, out: string) {
  const job = validateJob(rawJob),
    dir = resolve(out);
  const adapter = defaultResultAdapters().get(job.adapter);
  const substitute = (s: string) => s.replaceAll("{runDir}", dir);
  const resultPath = resolve(job.cwd, substitute(job.resultPath));
  const rel = relative(dir, resultPath);
  assert(
    rel !== "" && !rel.startsWith("..") && !isAbsolute(rel),
    "external resultPath must be inside fresh run directory",
  );
  createRunDirectory(dir, plan);
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 2), { flag: "wx" });
  appendFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ type: "external.start", at: new Date().toISOString() })}\n`,
  );
  const result = await runCommand({
    command: job.command,
    args: job.args.map(substitute),
    cwd: job.cwd,
    timeoutMs: job.timeoutMs,
  });
  writeFileSync(join(dir, "stdout.log"), result.stdout, { flag: "wx" });
  writeFileSync(join(dir, "stderr.log"), result.stderr, { flag: "wx" });
  appendFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ type: "external.end", at: new Date().toISOString(), ok: result.ok, code: result.code })}\n`,
  );
  let source: unknown, run: BenchmarkRun;
  try {
    source = readResultInput(resultPath, job.adapter);
    run = makeRun(plan, source, job.adapter, undefined, result.ok ? "completed" : "failed");
  } catch (error) {
    writeFileSync(
      join(dir, "failure.json"),
      JSON.stringify({ error: String(error), exitCode: result.code }),
      { flag: "wx" },
    );
    source = [];
    run = makeRun(plan, source, "normalized-v1", undefined, "failed");
    run.provenance.adapter = adapter.id;
    run.provenance.adapterVersion = adapter.version;
    run.provenance.notes.push(
      `External execution/output failure: ${String(error)}. All planned trials remain missing; see failure.json and upstream artifacts.`,
    );
  }
  run.provenance.executionConfigSha256 = sha256(canonical(job));
  saveRun(dir, run, source);
  return {
    run,
    ok:
      result.ok &&
      run.provenance.execution !== "failed" &&
      run.results.every(
        (r) => r.status === "completed" && Object.values(r.metrics).every((m) => m.value !== null),
      ),
  };
}
