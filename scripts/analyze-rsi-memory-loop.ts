/** Independent read-only reconciliation after the legacy evolve CLI diagnostic. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Candidate, FunctionEvaluator } from "@mentat/evolution";
import { createMemoryAccess } from "@mentat/memory";
import { memoryArtifact, type RecallQuery, recallTask } from "@mentat/memory-evolution";
import { FileMemoryRepository } from "@mentat/memory-file";
import { readTrajectory, resolveEventData } from "@mentat/observability";

const output = process.argv[2];
if (!output) throw new Error("expected completed loop output directory");
const out = resolve(output);
const read = (name: string) => JSON.parse(readFileSync(join(out, name), "utf8"));
const train = read("train-queries.json") as RecallQuery[],
  heldout = read("heldout-queries.json") as RecallQuery[];
const accounting = JSON.parse(
  execFileSync("python3", ["benchmarks/past-bench/read_loop_accounting.py", join(out, "work")], {
    encoding: "utf8",
    timeout: 10000,
  }),
);
const dirs = readdirSync(join(out, "trace"));
if (dirs.length !== 1) throw new Error("expected one evolution trajectory");
const trace = join(out, "trace", dirs[0] ?? "");
const events = readTrajectory(trace);
const selects = events
  .filter((event) => event.type === "iteration.select")
  .map((event) => resolveEventData(trace, event));
const candidates = [];
for (const name of readdirSync(join(out, "store"))
  .filter((name) => name.endsWith(".json") && name !== "current.json")
  .sort()) {
  const data = read(`store/${name}`);
  const candidate: Candidate = {
    id: data.id,
    version: data.version,
    artifacts: [memoryArtifact("memory", data.artifacts[0].snapshot)],
  };
  candidates.push({
    id: candidate.id,
    train: await new FunctionEvaluator([recallTask(train)]).evaluate(candidate),
    heldout: await new FunctionEvaluator([recallTask(heldout)]).evaluate(candidate),
  });
}
const repository = new FileMemoryRepository(join(out, "live-memory.json"));
const snapshot = await repository.snapshot();
const memory = createMemoryAccess(repository);
const queries = [];
for (const query of heldout)
  queries.push({
    query: query.query,
    activeResults: (await memory.search({ text: query.query, statuses: ["active"] })).length,
    allStatusResults: (await memory.search({ text: query.query })).length,
    contextSelected: (await memory.context(query.query)).selectedIds.length,
  });
const summary = {
  protocol: read("plan.json").protocol,
  model: accounting.model,
  proposalCount: events.filter((event) => event.type === "iteration.propose").length,
  commitCount: events.filter((event) => event.type === "workspace.commit.end").length,
  rollbackCount: events.filter((event) => event.type === "workspace.rollback.end").length,
  selects,
  current: read("store/current.json"),
  candidates,
  live: {
    entries: snapshot.entries.length,
    active: snapshot.entries.filter((entry) => (entry.status ?? "active") === "active").length,
    candidate: snapshot.entries.filter((entry) => entry.status === "candidate").length,
    queries,
  },
  accounting,
  originalReporter:
    "evolution and live apply completed; reporter refused unverified model because evolve CLI omits ACP diagnostics. Independently reconciled by unique directory and native assistant message model fields; no proposal rerun.",
  limits: read("plan.json").limits,
};
writeFileSync(join(out, "summary-verified.json"), `${JSON.stringify(summary, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
