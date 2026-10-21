/** Import fresh-sandbox SWE rewards into the unified framework, retaining missing coverage. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonical, type TrialResult, validatePlan } from "@mentat/benchmark";
import { createRunDirectory, makeRun, saveRun, sha256 } from "@mentat/benchmark-file";
import type { JsonValue } from "@mentat/core";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("expected pilot directory and new unified directory");
const root = resolve(source);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const results = JSON.parse(readFileSync(join(root, "results.json"), "utf8"));
if (!["completed", "incomplete"].includes(results.status))
  throw new Error("pilot is still running");
interface Response {
  sourceIdentity?: { revision: string; codeSha256: string };
  observations?: {
    costUsd?: number | null;
    models?: unknown[];
    accounting?: { sessions?: Array<{ version?: string }> };
  };
  result?: {
    reason?: string;
    durationMs?: number;
    termination?: JsonValue;
    completion?: JsonValue;
  };
}
const responses = new Map<string, Response>();
for (const row of results.cases) {
  if (!row.stages?.mentat?.trial) continue;
  const path = join(dirname(row.stages.mentat.trial), "agent/host/response.json");
  if (existsSync(path)) responses.set(row.id, JSON.parse(readFileSync(path, "utf8")));
}
const sourceHashes = new Set(
  [...responses.values()].map((response) => response.sourceIdentity?.codeSha256).filter(Boolean),
);
const versions = new Set(
  [...responses.values()].flatMap((response) =>
    (response.observations?.accounting?.sessions ?? []).flatMap((session) =>
      session.version ? [session.version] : [],
    ),
  ),
);
const plan = validatePlan({
  schemaVersion: 1,
  benchmark: { id: "swe-bench-pro-v2", version: "v2", track: "adapted" },
  dataset: {
    revision: manifest.upstreamRevision,
    sha256: sha256(canonical(manifest.tasks)),
    split: "development-sample",
    source:
      "https://github.com/scaleapi/SWE-bench_Pro-os/tree/66f92766bba642462d4bbe5479e83f91f9211862/v2",
  },
  scorer: {
    id: "swe-bench-pro-v2-fresh-replay",
    revision: manifest.upstreamRevision,
    config: { upstreamTaskFiles: manifest.tasks },
  },
  protocol: {
    id: "mentat-coding-sandbox",
    revision: "2",
    config: {
      memory: "disabled",
      network: "agent-offline-verifier-public",
      grading: "upstream-patch-replay-fresh-sandbox",
      selection: manifest.selection,
      calibration: "oracle-and-empty-per-case",
      runtime: manifest.runtime ?? null,
    },
    arms: [{ id: "reset", memory: "reset" }],
    maxCalls: manifest.maxSteps,
    turnTimeoutMs: manifest.timeoutMs,
  },
  subject: {
    id: "mentat",
    revision: manifest.subjectRevision,
    codeSha256:
      sourceHashes.size === 1
        ? [...sourceHashes][0]
        : sha256(
            canonical([
              manifest.subjectDiffSha256,
              manifest.bridgeFiles,
              [...responses].map(([id, response]) => [id, response.sourceIdentity ?? null]),
            ]),
          ),
    harness: "opencode",
    harnessVersion: versions.size === 1 ? [...versions][0] : "runtime-not-captured-or-mixed",
    model: manifest.model,
    modelVersion: manifest.model,
    config: { dirty: manifest.subjectDirty, sourceManifest: join(root, "manifest.json") },
  },
  metrics: [
    {
      id: "task.resolved",
      dimension: "task-quality",
      direction: "higher-better",
      unit: "ratio",
      min: 0,
      max: 1,
      source: "reward",
    },
  ],
  units: manifest.ids.map((id: string) => ({
    caseId: id,
    familyId: id.split("__")[0],
    arm: "reset",
    repetition: 0,
    sourceId: id,
    metricIds: ["task.resolved"],
  })),
});
const rows: TrialResult[] = plan.units.map((unit) => {
  const row = results.cases.find((value: { id: string }) => value.id === unit.caseId);
  const response = responses.get(unit.caseId);
  // Older development controllers could replay an absent subject patch as an
  // empty patch. A grader's zero alone is not evidence a model was evaluated.
  const verifiedModel = response?.observations?.models?.some(
    (model) =>
      typeof model === "object" &&
      model !== null &&
      "effective" in model &&
      model.effective === manifest.model,
  );
  const stages = row?.stages;
  const verifiedCalibration =
    stages?.oracle?.status === "completed" &&
    stages.oracle.reward === 1 &&
    stages?.empty?.status === "completed" &&
    stages.empty.reward === 0;
  const verifiedReplay =
    stages?.regrade?.status === "completed" && stages.regrade.reward === row?.reward;
  const scored =
    row?.status === "completed" &&
    [0, 1].includes(row.reward) &&
    response?.result?.reason !== "error" &&
    verifiedModel &&
    verifiedCalibration &&
    verifiedReplay;
  const error = row?.error ?? "no verified model attempt or fresh-sandbox score";
  return {
    caseId: unit.caseId,
    familyId: unit.familyId,
    arm: unit.arm,
    repetition: 0,
    status: scored ? "completed" : "error",
    metrics: {
      "task.resolved": scored ? { value: row.reward } : { value: null, reason: error },
    },
    ...(scored ? {} : { error }),
    evidence: [
      join(root, "manifest.json"),
      join(root, "results.json"),
      ...Object.values(row?.stages ?? {}).map((stage) =>
        String((stage as { trial?: string }).trial ?? ""),
      ),
    ].filter(Boolean),
    durationMs:
      row?.stages?.mentat?.elapsedSeconds != null ? row.stages.mentat.elapsedSeconds * 1000 : null,
    costUsd: response?.observations?.costUsd ?? null,
    observations: {
      sourceIdentity: response?.sourceIdentity ?? null,
      modelConfirmation: response?.observations?.models ?? [],
      subjectOutcome: response?.result?.reason ?? null,
      subjectTermination: response?.result?.termination ?? null,
      subjectCompletion: response?.result?.completion ?? null,
      subjectDurationMs: response?.result?.durationMs ?? null,
    },
  };
});
const run = makeRun(plan, rows, "normalized-v1");
run.provenance.notes.push(
  "Development sample with reduced agent budget. No leaderboard or RSI claim. Original grading runs in a fresh sandbox; operational failures remain unscored. Model usage is in each host response.json; unknown costs stay null.",
);
createRunDirectory(destination, plan);
saveRun(destination, run, rows);
