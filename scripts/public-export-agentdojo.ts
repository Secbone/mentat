/** Import exact upstream state-verifier outcomes; never score model-printed tool syntax. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonical,
  compareSubjects,
  type Dimension,
  type RunPlan,
  type TrialResult,
} from "@mentat/benchmark";
import { createRunDirectory, makeRun, saveRun, sha256 } from "@mentat/benchmark-file";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg)
  throw new Error("usage: public-export-agentdojo.ts <finished-run> <new-output>");
const input = resolve(inputArg),
  out = resolve(outputArg);
const source = JSON.parse(readFileSync(join(input, "summary.json"), "utf8"));
const manifest = source.manifest;
if (sha256(readFileSync(join(input, "runner.py"))) !== manifest.runnerSha256)
  throw new Error("runner source archive mismatch");
if (!manifest.subject?.codeSha256 || !manifest.datasetSha256 || !manifest.scorerSha256)
  throw new Error("verified frozen source and dataset/scorer identities required");
const rows = readFileSync(join(input, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((s) => JSON.parse(s));
if (canonical(rows) !== canonical(source.results))
  throw new Error("summary and result stream disagree");
const attack = manifest.phase === "fixed-injection-matrix";
const study = sha256(canonical(manifest));
const cases = manifest.planned.map(([suite, task, injection]: string[]) => ({
  suite,
  family: `${suite}/${task}`,
  caseId: `${suite}/${task}${injection ? `/${injection}` : ""}`,
}));
const metric = (id: string, dimension: Dimension, lower = false) => ({
  id,
  dimension,
  direction: lower ? ("lower-better" as const) : ("higher-better" as const),
  unit: "ratio",
  min: 0,
  max: 1,
});
const suites = [...new Set<string>(cases.map((c: { suite: string }) => c.suite))];
const metrics = [
  metric("utility", "tool-use"),
  ...suites.map((s) => metric(`utility.${s}`, "tool-use")),
  ...(attack ? [metric("attack-success", "safety", true), metric("safe-utility", "safety")] : []),
];
const runs = [];
for (const method of manifest.agents as string[]) {
  const subjectId = method === "mentat" ? "mentat-on-opencode" : "opencode-agentdojo-task-baseline";
  const plan: RunPlan = {
    schemaVersion: 1,
    benchmark: { id: "agentdojo", version: manifest.version, track: "adapted" },
    dataset: {
      revision: manifest.upstreamRevision,
      sha256: manifest.datasetSha256,
      split: manifest.phase,
      source: "https://github.com/ethz-spylab/agentdojo",
    },
    scorer: {
      id: "agentdojo-upstream-state-verifier",
      revision: manifest.scorerSha256,
      config: {
        runtimeSha256: manifest.runtimeSha256,
        attack: manifest.attack ?? "none",
        attackPayloadSha256: manifest.attackPayloadSha256 ?? "none",
      },
    },
    protocol: {
      id: "agentdojo-native-tools-controlled",
      revision: manifest.runnerSha256,
      config: {
        crossSubjectStudy: study,
        scope: manifest.scope,
        phase: manifest.phase,
        familyAggregation:
          "user-task macro; attack targets share a family; raw task micro means reported separately",
        policy: manifest.policy,
        limitations: manifest.limitations,
      },
      arms: [{ id: "main", memory: "reset" }],
      maxCalls: cases.length,
      turnTimeoutMs: 240000,
    },
    subject: {
      id: subjectId,
      revision: manifest.subject.revision,
      codeSha256: manifest.subject.codeSha256,
      harness: "opencode-acp",
      harnessVersion: "opencode-2.0.25",
      model: "opencode-go/deepseek-v4.1-flash",
      modelVersion: "deepseek-v4.1-flash",
      config: {
        study,
        method:
          method === "mentat"
            ? {
                implementation:
                  "Mentat host on OpenCode; own memory candidate tools plus official task tools; fresh task state",
              }
            : {
                implementation:
                  "OpenCode agent with AgentDojo task/system/tools; no Mentat policy or memory. Not the upstream provider-native basic agent loop.",
              },
      },
    },
    metrics,
    units: cases.map((c: { suite: string; family: string; caseId: string }) => ({
      caseId: c.caseId,
      familyId: c.family,
      sourceId: c.caseId,
      arm: "main",
      repetition: 0,
      metricIds: [
        "utility",
        `utility.${c.suite}`,
        ...(attack ? ["attack-success", "safe-utility"] : []),
      ],
    })),
  };
  const selected = rows.filter((r) => r.agent === method);
  const results: TrialResult[] = selected.map((row) => {
    const unit = plan.units.find((u) => u.caseId === row.caseId);
    if (!unit) throw new Error(`unexpected case ${row.caseId}`);
    if (row.status === "completed") {
      if (!Array.isArray(row.evidence) || row.evidence.length !== 1)
        throw new Error("missing trial evidence");
      const queries = readdirSync(row.evidence[0]).filter((name) => name.startsWith("query-"));
      if (!queries.length) throw new Error("missing query evidence");
      for (const name of queries) {
        const dir = join(row.evidence[0], name, "subject");
        const identity = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        const response = JSON.parse(readFileSync(join(dir, "response.json"), "utf8"));
        if (
          identity.codeSha256 !== manifest.subject.codeSha256 ||
          response.reason !== "done" ||
          !response.observations.models.length ||
          response.observations.models.some(
            (m: { effective: string }) => m.effective !== plan.subject.model,
          )
        )
          throw new Error("trial source/model verification failed");
      }
    }
    const known =
      row.status === "completed" &&
      typeof row.utility === "boolean" &&
      (!attack || typeof row.attackSuccess === "boolean");
    return {
      caseId: unit.caseId,
      familyId: unit.familyId,
      arm: unit.arm,
      repetition: 0,
      status: known ? "completed" : "error",
      durationMs: row.durationMs ?? null,
      costUsd: row.costUsd ?? null,
      metrics: Object.fromEntries(
        unit.metricIds.map((id) => [
          id,
          known
            ? {
                value: Number(
                  id === "attack-success"
                    ? row.attackSuccess
                    : id === "safe-utility"
                      ? row.utility && !row.attackSuccess
                      : row.utility,
                ),
              }
            : { value: null, reason: row.error ?? "unverified state outcome" },
        ]),
      ),
      evidence: row.evidence ?? [],
      ...(row.error ? { error: row.error } : {}),
      observations: { toolCalls: row.toolCalls ?? null, subject: subjectId },
    };
  });
  const directory = join(out, subjectId);
  createRunDirectory(directory, plan);
  const run = makeRun(
    plan,
    results,
    "normalized-v1",
    undefined,
    results.length === plan.units.length && results.every((r) => r.status === "completed")
      ? "completed"
      : "failed",
  );
  run.provenance.notes.push(
    "Official state verifier, adapted model/harness. Baseline is OpenCode with upstream task policy, not unmodified AgentDojo provider-native basic agent. No paper leaderboard subtraction.",
  );
  saveRun(directory, run, results);
  runs.push(run);
}
if (runs.length !== 2 || !runs[0] || !runs[1]) throw new Error("expected two controlled methods");
const comparison = compareSubjects(runs[1], runs[0]);
writeFileSync(join(out, "comparison.json"), JSON.stringify(comparison, null, 2), { flag: "wx" });
const micro = Object.fromEntries(
  manifest.agents.map((method: string) => {
    const group = rows.filter((r) => r.agent === method && r.status === "completed");
    return [
      method,
      {
        planned: cases.length,
        measured: group.length,
        utilityMicro: group.length ? group.filter((r) => r.utility).length / group.length : null,
        ...(attack
          ? {
              attackSuccessMicro: group.length
                ? group.filter((r) => r.attackSuccess).length / group.length
                : null,
              safeUtilityMicro: group.length
                ? group.filter((r) => r.utility && !r.attackSuccess).length / group.length
                : null,
            }
          : {}),
      },
    ];
  }),
);
writeFileSync(join(out, "micro-means.json"), JSON.stringify(micro, null, 2), { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ comparable: comparison.comparable, cases: cases.length, scope: manifest.scope, micro })}\n`,
);
