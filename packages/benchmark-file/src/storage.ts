import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assert,
  type BenchmarkRun,
  canonical,
  type RunPlan,
  type TrialResult,
  validatePlan,
  validateRun,
} from "@mentat/benchmark";
import { defaultResultAdapters, type ResultAdapterRegistry } from "./adapters";
import { sha256 } from "./digest";
import { renderReport } from "./report";

export function readPlan(path: string): RunPlan {
  return validatePlan(JSON.parse(readFileSync(path, "utf8")));
}
export function createRunDirectory(path: string, plan: RunPlan) {
  validatePlan(plan);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  // Exclusive directory creation: reruns cannot overwrite an accepted result or failed attempt.
  mkdirSync(path);
  writeFileSync(join(path, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(path, "events.jsonl"), "", { flag: "wx" });
}
export function appendResult(path: string, result: TrialResult) {
  appendFileSync(
    join(path, "events.jsonl"),
    `${JSON.stringify({ type: "trial.result", at: new Date().toISOString(), result })}\n`,
  );
}
export function makeRun(
  plan: RunPlan,
  input: unknown,
  adapterId: string,
  registry: ResultAdapterRegistry = defaultResultAdapters(),
  execution: BenchmarkRun["provenance"]["execution"] = "imported",
): BenchmarkRun {
  validatePlan(plan);
  const adapter = registry.get(adapterId);
  return validateRun({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    plan,
    provenance: {
      adapter: adapter.id,
      adapterVersion: adapter.version,
      artifactSha256: sha256(canonical(input)),
      execution,
      notes: [
        "Result import is not certification of upstream parity or claimed model identity.",
        ...(adapterId === "inspect-json-v1"
          ? [
              `Inspect source status: ${String((input as Record<string, unknown>).status ?? "not supplied")}; per-sample billing is unknown.`,
            ]
          : []),
      ],
    },
    results: adapter.read(input, plan),
  });
}
export function saveRun(path: string, run: BenchmarkRun, source: unknown) {
  validateRun(run);
  assert(sha256(canonical(source)) === run.provenance.artifactSha256, "source digest mismatch");
  const encoded = `${JSON.stringify(run, null, 2)}\n`;
  writeFileSync(join(path, "source.json"), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(path, "run.json"), encoded, { flag: "wx" });
  writeFileSync(join(path, "report.md"), renderReport(run), { flag: "wx" });
  writeFileSync(join(path, "integrity.json"), JSON.stringify({ runSha256: sha256(encoded) }), {
    flag: "wx",
  });
}
export function readRun(path: string): BenchmarkRun {
  const raw = readFileSync(join(path, "run.json"), "utf8");
  const integrity = JSON.parse(readFileSync(join(path, "integrity.json"), "utf8"));
  assert(sha256(raw) === integrity.runSha256, "run file integrity mismatch");
  const run = validateRun(JSON.parse(raw));
  assert(
    canonical(JSON.parse(readFileSync(join(path, "plan.json"), "utf8"))) === canonical(run.plan),
    "plan file integrity mismatch",
  );
  assert(
    sha256(canonical(JSON.parse(readFileSync(join(path, "source.json"), "utf8")))) ===
      run.provenance.artifactSha256,
    "source file integrity mismatch",
  );
  return run;
}
export function readResultInput(path: string, adapter: string): unknown {
  if (lstatSync(path).isDirectory()) {
    assert(adapter === "harbor-trials-v1", "directory input supported only for Harbor job trials");
    const trials = readdirSync(path)
      .sort()
      .flatMap((name) => {
        const dir = join(path, name);
        if (!lstatSync(dir).isDirectory()) return [];
        const files = readdirSync(dir);
        if (!files.includes("result.json")) return [];
        assert(
          lstatSync(join(dir, "result.json")).isFile(),
          "Harbor result must be a regular file",
        );
        return [JSON.parse(readFileSync(join(dir, "result.json"), "utf8"))];
      });
    assert(trials.length, "no per-trial Harbor result files found");
    return trials;
  }
  assert(lstatSync(path).isFile(), "result input must be a regular file or Harbor job directory");
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl"))
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  return JSON.parse(text);
}
export function history(root: string) {
  return readdirSync(root)
    .sort()
    .filter((name) => lstatSync(join(root, name)).isDirectory())
    .map((name) => {
      const path = join(root, name);
      try {
        return { path, run: readRun(path), error: null };
      } catch (error) {
        return { path, run: null, error: String(error) };
      }
    });
}
