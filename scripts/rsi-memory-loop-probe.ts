/** Real-model diagnostic of the existing offline evolution -> live memory boundary. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Candidate, FunctionEvaluator } from "@mentat/evolution";
import { createMemoryAccess } from "@mentat/memory";
import { memoryArtifact, recallTask } from "@mentat/memory-evolution";
import { FileMemoryRepository } from "@mentat/memory-file";
import { ExperienceStore, projectExperience } from "@mentat/observability";
import { evolveCommand } from "../packages/cli/src/commands/evolve";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";
import { checkoutIdentity } from "../packages/cli/src/lib/benchmark-subject";

const [trialPath, output] = process.argv.slice(2);
if (!trialPath || !output) throw new Error("expected source PAST trial and new output");
const root = process.cwd(),
  trial = resolve(trialPath),
  out = resolve(output);
const disk = statfsSync(root, { bigint: true });
if (disk.bavail * disk.bsize < 30n * 1024n ** 3n) throw new Error("disk reserve below 30 GiB");
mkdirSync(out);
const save = (name: string, data: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
const config = JSON.parse(readFileSync(join(trial, "controller.json"), "utf8"));
const response = JSON.parse(readFileSync(join(trial, "subject/response.json"), "utf8"));
const record = projectExperience(
  response.evidenceDir,
  { prompt: config.query, cwd: root, harness: "acp" },
  response.taskTurnId,
);
if (!record.messages?.length || !record.prompt.includes("external advisory roster"))
  throw new Error("expected the original SM02 user interaction");
const experience = join(out, "experience");
new ExperienceStore(experience).append(record);
const train = [
  { query: "external advisory roster Ava Chen Owen Brooks", expectId: "advisory-roster" },
  { query: "internal planning notes sharing only employees", expectId: "sharing-boundary" },
];
// Additional paraphrase probes stay out of the proposer; these are ID-recall
// diagnostics over the same source facts, not unseen business tasks.
const heldout = [
  { query: "Ava Owen external advisory", expectId: "advisory-roster" },
  { query: "planning source-note shares employees", expectId: "sharing-boundary" },
];
save("train-queries.json", train);
save("heldout-queries.json", heldout);
const model = "opencode-go/deepseek-v4.1-flash";
const identity = checkoutIdentity(root, join(out, "subject-source.json"));
save("plan.json", {
  ...identity,
  model,
  sourceTrial: trial,
  sourceResponseSha256: createHash("sha256")
    .update(readFileSync(join(trial, "subject/response.json")))
    .digest("hex"),
  protocol: "native-memory-evolution-three-proposals-v2",
  iterations: 3,
  proposer: "existing evolve memory --agent --from-experience",
  evaluator: "existing recallTask + memoryGate",
  limits: [
    "ID-recall proxy, not semantic correctness",
    "only paraphrase holdout of same facts",
    "paraphrase queries are selection/development probes, not an independent final acceptance set",
    "proposer policy and evaluator fixed",
    "iterations are proposals, not necessarily accepted generations",
    "no code edits or automatic user-rule confirmation",
  ],
});
const work = join(out, "work");
mkdirSync(work);
process.env.MENTAT_ACP_BIN = "opencode";
process.env.MENTAT_ACP_ARGS = "acp";
process.env.OPENCODE_DISABLE_AUTOUPDATE = "true";
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
  agents: { title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } } },
  autoupdate: false,
  share: "disabled",
  instructions: [],
  plugins: [],
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
});
process.chdir(work);
let exitCode: number;
try {
  exitCode = await evolveCommand([
    "memory",
    "--harness",
    "acp",
    "--model",
    model,
    "--agent",
    "--from-experience",
    "--training-queries",
    join(out, "train-queries.json"),
    "--queries",
    join(out, "heldout-queries.json"),
    "--store",
    join(out, "store"),
    "--memory",
    join(out, "live-memory.json"),
    "--experience",
    experience,
    "--log-dir",
    join(out, "trace"),
    "--iterations",
    "3",
  ]);
} finally {
  process.chdir(root);
}
const candidates = [];
for (const name of readdirSync(join(out, "store")).filter(
  (name) => name.endsWith(".json") && name !== "current.json",
)) {
  const data = JSON.parse(readFileSync(join(out, "store", name), "utf8"));
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
const liveQueries = [];
for (const query of heldout)
  liveQueries.push({
    query: query.query,
    activeResults: (await memory.search({ text: query.query, statuses: ["active"] })).length,
  });
const traces = readdirSync(join(out, "trace"));
if (traces.length !== 1) throw new Error("expected one evolution trajectory");
const observations = benchmarkObservations(join(out, "trace", traces[0] ?? ""));
// The existing evolve CLI does not forward ACP diagnostic/protocol callbacks.
// Independently verify the exact experiment directory's native sessions rather
// than treating a requested model name as confirmation.
const nativeAccounting = JSON.parse(
  execFileSync("python3", [join(root, "benchmarks/past-bench/read_loop_accounting.py"), work], {
    encoding: "utf8",
    timeout: 10000,
  }),
);
if (nativeAccounting.model !== model) throw new Error("unverified model");
save("summary.json", {
  exitCode,
  candidates,
  live: {
    entries: snapshot.entries.length,
    active: snapshot.entries.filter((e) => (e.status ?? "active") === "active").length,
    candidate: snapshot.entries.filter((e) => e.status === "candidate").length,
    queries: liveQueries,
  },
  observations,
  nativeAccounting,
});
process.stdout.write(`${JSON.stringify({ summary: join(out, "summary.json") })}\n`);
