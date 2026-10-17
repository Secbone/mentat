import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assert,
  BENCHMARK_CATALOG,
  canonical,
  checkJsonCriteria,
  compareArms,
  compareRuns,
  compareSubjects,
  DIMENSIONS,
  FRAMEWORK_CATALOG,
  gradeEpisode,
  runEpisodes,
  summarizeRun,
  validateCriteria,
  validateDataset,
  validatePlan,
} from "@mentat/benchmark";
import {
  appendResult,
  createRunDirectory,
  defaultResultAdapters,
  history,
  makeRun,
  readPlan,
  readResultInput,
  readRun,
  renderReport,
  runExternal,
  saveRun,
  sha256,
  trendsCsv,
  validateJob,
} from "@mentat/benchmark-file";
import { checkoutIdentity, mentatBenchmarkSubject } from "../lib/benchmark-subject";

export const BENCH_USAGE = `mentat bench — versioned, per-trial benchmark tracking
  bench list [--json]
  bench validate --plan <plan.json> [--dataset <episodes.json>]
  bench run --plan <plan.json> --dataset <episodes.json> --out <new-dir>
  bench external --plan <plan.json> --job <job.json> --out <new-dir>
  bench import --plan <plan.json> --adapter <id> --input <file-or-harbor-job> --out <new-dir>
  bench report --run <dir> [--json]
  bench compare --before <dir> --after <dir>
  bench compare-subjects --before <dir> --after <dir>
  bench arms --run <dir> --baseline <arm> --treatment <arm>
  bench history --root <dir> [--csv]

Adapters: normalized-v1, harbor-trials-v1, inspect-json-v1.
Native episodes use deterministic rule checks, typed explicit memory and fresh sessions.
Public suites require pinned upstream tasks, scorer and a Mentat agent bridge; registration is not integration.
See docs/benchmark-framework.md and benchmarks/examples.`;

function flags(args: string[]) {
  const options = new Map<string, string>();
  const boolean = new Set(["--json", "--csv"]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(typeof key === "string", "option required");
    assert(key.startsWith("--"), `unexpected argument ${key}`);
    assert(!options.has(key), `duplicate option ${key}`);
    if (boolean.has(key)) {
      options.set(key, "true");
      continue;
    }
    const value = args[++i];
    assert(value && !value.startsWith("--"), `${key}: missing value`);
    options.set(key, value);
  }
  return options;
}
export async function benchCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    process.stdout.write(`${BENCH_USAGE}\n`);
    return 0;
  }
  try {
    const options = flags(rest);
    const allowed: Record<string, string[]> = {
      list: ["--json"],
      validate: ["--plan", "--dataset"],
      run: ["--plan", "--dataset", "--out"],
      external: ["--plan", "--job", "--out"],
      import: ["--plan", "--adapter", "--input", "--out"],
      report: ["--run", "--json"],
      compare: ["--before", "--after"],
      "compare-subjects": ["--before", "--after"],
      arms: ["--run", "--baseline", "--treatment"],
      history: ["--root", "--csv"],
    };
    assert(allowed[action], `unknown benchmark command ${action}`);
    for (const key of options.keys())
      assert(allowed[action]?.includes(key), `unknown option ${key}`);
    const required = (name: string) => {
      const value = options.get(name);
      assert(value, `missing ${name}`);
      return value;
    };
    const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    if (action === "list") {
      if (options.has("--json"))
        print({
          dimensions: DIMENSIONS,
          benchmarks: BENCHMARK_CATALOG,
          frameworks: FRAMEWORK_CATALOG,
          adapters: defaultResultAdapters().list(),
        });
      else
        process.stdout.write(
          `${BENCHMARK_CATALOG.map(
            (b) =>
              `${b.id}\t${b.priority}\t${b.dimensions.join(",")}\t${b.integration}\t${b.runtime}`,
          ).join("\n")}\n`,
        );
      return 0;
    }
    if (action === "validate") {
      const plan = readPlan(required("--plan"));
      if (options.has("--dataset")) {
        const raw = readFileSync(required("--dataset"));
        assert(sha256(raw) === plan.dataset.sha256, "dataset digest mismatch");
        const { validateEpisodePlan } = await import("@mentat/benchmark");
        validateEpisodePlan(plan, validateDataset(JSON.parse(raw.toString())));
      }
      print({ valid: true, benchmark: plan.benchmark, planned: plan.units.length });
      return 0;
    }
    if (action === "run") {
      let plan = readPlan(required("--plan"));
      const bytes = readFileSync(required("--dataset"));
      assert(sha256(bytes) === plan.dataset.sha256, "dataset digest mismatch");
      const dataset = validateDataset(JSON.parse(bytes.toString()));
      const { validateEpisodePlan } = await import("@mentat/benchmark");
      validateEpisodePlan(plan, dataset);
      assert(plan.subject.id === "mentat", "native runner evaluates mentat only");
      if (plan.subject.harness === "fake")
        assert(plan.benchmark.track === "smoke", "fake harness requires smoke track");
      plan = validatePlan({
        ...plan,
        scorer: {
          ...plan.scorer,
          config: {
            ...plan.scorer.config,
            implementationSha256: sha256(
              `${gradeEpisode.toString()}\n${canonical.toString()}\n${checkJsonCriteria.toString()}\n${validateCriteria.toString()}`,
            ),
          },
        },
        protocol: {
          ...plan.protocol,
          config: { ...plan.protocol.config, runnerSha256: sha256(runEpisodes.toString()) },
        },
        subject: { ...plan.subject, ...checkoutIdentity(process.cwd()) },
      });
      const out = resolve(required("--out"));
      const subject = mentatBenchmarkSubject(plan, out);
      createRunDirectory(out, plan);
      writeFileSync(resolve(out, "dataset.json"), bytes, { flag: "wx" });
      const result = await runEpisodes(plan, dataset, subject, (row) => appendResult(out, row));
      const run = makeRun(
        plan,
        result.results,
        "normalized-v1",
        undefined,
        result.results.every((r) => r.status === "completed") ? "completed" : "failed",
      );
      run.provenance.notes.push(
        "Native rule-based regression; not an upstream benchmark score. Local process/permission isolation is not a filesystem sandbox.",
        "Model/harness versions are declared by the plan; verification.json records ACP model confirmation and read-only native session accounting when available.",
      );
      saveRun(out, run, result.results);
      print({ out, calls: result.calls, ...summarizeRun(run) });
      return run.provenance.execution === "completed" ? 0 : 1;
    }
    if (action === "external") {
      const plan = readPlan(required("--plan")),
        job = validateJob(JSON.parse(readFileSync(required("--job"), "utf8")));
      const result = await runExternal(plan, job, required("--out"));
      print(summarizeRun(result.run));
      return result.ok ? 0 : 1;
    }
    if (action === "import") {
      const plan = readPlan(required("--plan")),
        adapter = required("--adapter"),
        source = readResultInput(required("--input"), adapter);
      const run = makeRun(plan, source, adapter);
      const out = required("--out");
      createRunDirectory(out, plan);
      saveRun(out, run, source);
      print(summarizeRun(run));
      return 0;
    }
    if (action === "report") {
      const run = readRun(required("--run"));
      if (options.has("--json")) print(summarizeRun(run));
      else process.stdout.write(renderReport(run));
      return 0;
    }
    if (action === "compare" || action === "compare-subjects" || action === "arms") {
      const compared =
        action === "compare"
          ? compareRuns(readRun(required("--before")), readRun(required("--after")))
          : action === "compare-subjects"
            ? compareSubjects(readRun(required("--before")), readRun(required("--after")))
            : compareArms(
                readRun(required("--run")),
                required("--baseline"),
                required("--treatment"),
              );
      print(compared);
      return compared.comparable ? 0 : 2;
    }
    const records = history(required("--root"));
    if (options.has("--csv")) {
      process.stdout.write(trendsCsv(records.flatMap((r) => (r.run ? [r.run] : []))));
      for (const r of records.filter((r) => r.error))
        process.stderr.write(`${r.path}: ${r.error}\n`);
    } else
      print(
        records.map((r) => ({
          path: r.path,
          error: r.error,
          ...(r.run ? { summary: summarizeRun(r.run) } : {}),
        })),
      );
    return records.some((r) => r.error) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`bench: ${String(error)}\n`);
    return 1;
  }
}
