import { type BenchmarkRun, canonical, comparisonIdentity, summarizeRun } from "@mentat/benchmark";
import { sha256 } from "./digest";

function cell(value: unknown) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
export function renderReport(run: BenchmarkRun) {
  const s = summarizeRun(run);
  return [
    `# Benchmark ${cell(run.plan.benchmark.id)} / ${cell(run.id)}`,
    "",
    `Track: ${cell(run.plan.benchmark.track)}. Execution: ${cell(run.provenance.execution)}.`,
    "",
    `Subject: ${cell(run.plan.subject.id)} @ ${cell(run.plan.subject.revision)}; code ${run.plan.subject.codeSha256}.`,
    `Model: ${cell(run.plan.subject.model)} @ ${cell(run.plan.subject.modelVersion)}; harness ${cell(run.plan.subject.harness)} @ ${cell(run.plan.subject.harnessVersion)}.`,
    `Dataset: ${cell(run.plan.dataset.revision)}, sha256 ${run.plan.dataset.sha256}; scorer ${cell(run.plan.scorer.id)} @ ${cell(run.plan.scorer.revision)}.`,
    "",
    `Planned ${s.planned}; completed ${s.trials.completed}; error ${s.trials.error}; missing ${s.trials.missing}; skipped ${s.trials.skipped}.`,
    `Known cost $${s.cost.knownUsd.toFixed(6)}; measured ${s.cost.measured}/${s.planned}; unknown ${s.cost.unknown}. This is not a complete total when coverage is partial.`,
    `Reflection attempted ${s.reflections.attempted}; completed ${s.reflections.completed}; invalid ${s.reflections.invalid}; errors ${s.reflections.errors}. Business scores are recorded independently of reflection outcomes.`,
    "",
    "| Dimension | Arm | Metric | Unit | Family macro mean | Measured / planned | Families |",
    "|---|---|---|---|---:|---:|---:|",
    ...s.metrics.map(
      (m) =>
        `| ${m.dimension} | ${cell(m.arm)} | ${cell(m.metric)} | ${cell(m.unit)} | ${m.macroMean === null ? "unknown" : m.macroMean.toFixed(4)} | ${m.measured}/${m.planned} | ${m.families} |`,
    ),
    "",
    "Means use observed measurements only. Missing scores are unknown, not zero. Check coverage and failures before comparing. No cross-benchmark composite score is calculated.",
    "",
    ...run.provenance.notes.map((note) => `- ${cell(note)}`),
    "",
  ].join("\n");
}
function csv(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
/** Each row is a benchmark/arm/metric observation, with a compatibility cohort key. */
export function trendsCsv(runs: BenchmarkRun[]) {
  const header = [
    "createdAt",
    "runId",
    "benchmark",
    "track",
    "cohort",
    "revision",
    "dimension",
    "arm",
    "metric",
    "unit",
    "macroMean",
    "measured",
    "planned",
    "unknown",
    "execution",
  ];
  const rows = runs.flatMap((run) =>
    summarizeRun(run).metrics.map((m) => [
      run.createdAt,
      run.id,
      run.plan.benchmark.id,
      run.plan.benchmark.track,
      sha256(canonical(comparisonIdentity(run))),
      run.plan.subject.revision,
      m.dimension,
      m.arm,
      m.metric,
      m.unit,
      m.macroMean,
      m.measured,
      m.planned,
      m.unknown,
      run.provenance.execution,
    ]),
  );
  return `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`;
}
