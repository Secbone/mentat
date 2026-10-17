/** Import actual per-question output into the unified framework, never aggregate-only scores. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonical, compareSubjects, type RunPlan, type TrialResult } from "@mentat/benchmark";
import { createRunDirectory, makeRun, saveRun, sha256 } from "@mentat/benchmark-file";
import { readTrajectory, resolveEventData } from "@mentat/observability";

const [inputArg, outputArg, ...recoveryArgs] = process.argv.slice(2);
if (!inputArg || !outputArg)
  throw new Error("usage: public-export-longmemeval.ts <source-run> <new-output>");
const input = resolve(inputArg),
  out = resolve(outputArg);
const summary = JSON.parse(readFileSync(join(input, "summary.json"), "utf8"));
const manifest = summary.manifest;
const rows = readFileSync(join(input, "results.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
for (const recoveryArg of recoveryArgs) {
  const recovery = JSON.parse(readFileSync(resolve(recoveryArg), "utf8"));
  if (recovery.judgeFunctionSha256 !== manifest.judgeFunctionSha256)
    throw new Error("recovery scorer changed");
  for (const item of recovery.items) {
    const index = rows.findIndex(
      (r) => r.question_id === item.original.question_id && r.agent === item.original.agent,
    );
    const original = rows[index];
    if (
      !original ||
      canonical(original) !== canonical(item.original) ||
      !String(original.error).includes("ACP model mismatch")
    )
      throw new Error("invalid infrastructure-only recovery");
    if (item.kind === "pre-inference-reader") {
      if (original.hypothesis || item.proof.priorPromptSubmissions !== 0)
        throw new Error("reader already had an answer");
      const proof = item.proof;
      const request = readFileSync(proof.requestPath);
      if (sha256(request) !== proof.requestSha256) throw new Error("original request changed");
      const originalRequest = JSON.parse(request.toString());
      const replacementRequest = JSON.parse(
        readFileSync(join(resolve(item.replacement.evidence[0]), "..", "request.json"), "utf8"),
      );
      if (canonical(originalRequest.body) !== canonical(replacementRequest.body))
        throw new Error("replayed request differs from original");
      if (!proof.traces.length) throw new Error("missing prior trace proof");
      for (const trace of proof.traces) {
        if (sha256(readFileSync(trace.path)) !== trace.sha256)
          throw new Error("prior trace changed");
        const dir = resolve(trace.path, "..");
        for (const event of readTrajectory(dir)) {
          const data = resolveEventData(dir, event) as Record<string, unknown> | undefined;
          if (
            event.type === "turn.start" ||
            event.type === "capture.gap" ||
            (event.type === "agent.event" && data?.type === "run.started") ||
            (event.type === "adapter.protocol" &&
              data?.direction === "out" &&
              (data.data as { method?: string })?.method === "session/prompt")
          )
            throw new Error("prior inference submission or incomplete trace");
        }
      }
    } else if (!original.hypothesis || item.replacement.hypothesis !== original.hypothesis) {
      throw new Error("judge recovery changed original answer");
    }
    rows[index] = {
      ...item.replacement,
      originalStatus: original.status,
      recoveryPolicy: item.policy,
    };
  }
}
const study = sha256(canonical(manifest));
const types = [
  ...new Set<string>(manifest.planned.map((p: { question_type: string }) => p.question_type)),
];
const metric = (id: string) => ({
  id,
  dimension: "memory" as const,
  direction: "higher-better" as const,
  unit: "ratio",
  min: 0,
  max: 1,
});
const runs = [];
for (const agent of manifest.agents as string[]) {
  const metrics = [
    metric("qa.correct"),
    ...types.map((t) => metric(`qa.${t}`)),
    metric("qa.abstention"),
  ];
  const plan: RunPlan = {
    schemaVersion: 1,
    benchmark: { id: "longmemeval", version: manifest.upstreamRevision, track: "adapted" },
    dataset: {
      revision: "98d7416c24c778c2fee6e6f3006e7a073259d48f",
      sha256: manifest.datasetSha256,
      split: "cleaned-s",
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    },
    scorer: {
      id: "longmemeval-semantic-judge",
      revision: manifest.judgeFunctionSha256,
      config: {
        judgeModel: manifest.judgeModel,
        labelRule: manifest.judgeLabelRule,
        transport: manifest.transport,
      },
    },
    protocol: {
      id: "longmemeval-cleaned-s-controlled",
      revision: manifest.runnerSha256,
      config: {
        crossSubjectStudy: study,
        scope: manifest.scope,
        readerModel: manifest.readerModel,
        readerFunctionSha256: manifest.readerFunctionSha256,
        budgets: {
          nativeHistoryChars: manifest.nativeHistoryBudgetChars,
          bm25ContextTokens: manifest.bm25MaxContextTokens,
          bm25Sessions: manifest.bm25TopKSessions,
        },
        limitations: manifest.transportLimitations,
      },
      arms: [{ id: "main", memory: "reset" }],
      maxCalls: manifest.planned.length * 2,
      turnTimeoutMs: 180000,
    },
    subject: {
      id: agent,
      revision:
        agent === "mentat-episodic" ? manifest.transport.revision : manifest.upstreamRevision,
      codeSha256:
        agent === "mentat-episodic"
          ? manifest.transport.codeSha256
          : sha256(
              `${manifest.retrievalFunctionSha256}:${manifest.corpusFunctionSha256}:${manifest.readerFunctionSha256}`,
            ),
      harness: manifest.transport.harness,
      harnessVersion: "opencode-2.0.25",
      model: manifest.readerModel,
      modelVersion: "deepseek-v4.1-flash",
      config: {
        study,
        method:
          agent === "mentat-episodic"
            ? {
                history: "host.ingestHistory + lexical quoted observation retrieval",
                budgetChars: manifest.nativeHistoryBudgetChars,
                manualConfirmation: false,
                reflection: false,
              }
            : {
                implementation: "unchanged upstream BM25 functions and reader prompt",
                corpus: "user-only/session",
                readerTokenLimit: manifest.bm25MaxContextTokens,
                topK: manifest.bm25TopKSessions,
              },
      },
    },
    metrics,
    units: manifest.planned.map((p: { question_id: string; question_type: string }) => ({
      caseId: p.question_id,
      familyId: p.question_id,
      arm: "main",
      repetition: 0,
      sourceId: p.question_id,
      metricIds: [
        "qa.correct",
        `qa.${p.question_type}`,
        ...(p.question_id.endsWith("_abs") ? ["qa.abstention"] : []),
      ],
    })),
  };
  const results: TrialResult[] = rows
    .filter((r) => r.agent === agent)
    .map((r) => {
      const unit = plan.units.find((u) => u.caseId === r.question_id);
      if (!unit) throw new Error(`unexpected source question ${r.question_id}`);
      return {
        caseId: r.question_id,
        familyId: r.question_id,
        arm: "main",
        repetition: 0,
        status: r.status,
        metrics: Object.fromEntries(
          unit.metricIds.map((id) => [
            id,
            r.correct === null
              ? { value: null, reason: r.error ?? "unknown judge outcome" }
              : { value: Number(r.correct) },
          ]),
        ),
        evidence: r.evidence,
        ...(typeof r.error === "string" ? { error: r.error } : {}),
        durationMs: r.durationMs,
        costUsd: r.costUsd,
        observations: {
          ...(typeof r.judgeFormatValid === "boolean"
            ? { judgeFormatValid: r.judgeFormatValid }
            : {}),
          ...(r.originalStatus
            ? { originalStatus: r.originalStatus, recoveryPolicy: r.recoveryPolicy }
            : {}),
        },
      };
    });
  const directory = join(out, agent);
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
    "DeepSeek judge and OpenCode ACP transport variant. Budgets differ by method and are explicitly reported. Published GPT-4o-judge leaderboard scores are not directly comparable.",
  );
  saveRun(directory, run, results);
  runs.push(run);
}
if (runs.length !== 2) throw new Error("expected two controlled subjects");
const first = runs[0],
  second = runs[1];
if (!first || !second) throw new Error("comparison subjects missing");
// Positive deltas mean Mentat exceeds the upstream BM25 comparator.
const comparison = compareSubjects(second, first);
writeFileSync(join(out, "comparison.json"), JSON.stringify(comparison, null, 2), { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ out, comparable: comparison.comparable, subjects: runs.map((r) => ({ id: r.plan.subject.id, results: r.results.length, execution: r.provenance.execution })) })}\n`,
);
