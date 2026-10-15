import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Candidate, FunctionEvaluator, GateChain, SelfIterationLoop } from "@mentat/evolution";
import { type MemoryEntry, MemoryService } from "@mentat/memory";
import {
  applyEvolvedMemory,
  memoryArtifact,
  memoryGate,
  type RecallQuery,
  RuleMemoryProposer,
  recallTask,
} from "@mentat/memory-evolution";
import { JsonFileMemoryStore, JsonlMemoryAudit } from "@mentat/memory-file";
import { buildExperienceDigest, ExperienceStore, FileTrajectoryStore } from "@mentat/observability";
import { runOnce } from "@mentat/session";
import { type ArtifactSnapshot, JsonStoreWorkspace } from "@mentat/workspace";
import { defaultExperienceDir, defaultMemoryPath, defaultMemoryStoreDir } from "../lib/paths";
import { createAgentMemoryProposer } from "../lib/proposers";
import { createDefaultRegistry } from "../lib/registry";

export async function evolveCommand(args: string[]): Promise<number> {
  if (args[0] !== "memory") {
    process.stderr.write(
      "usage: mentat evolve memory --queries <file> [--facts <file> | --agent [--from-experience]] [--model <id>] [--store <dir>] [--iterations <n>]\n",
    );
    return 1;
  }

  let store = defaultMemoryStoreDir(process.cwd());
  let memoryPath = defaultMemoryPath(process.cwd());
  let factsPath: string | undefined;
  let queriesPath: string | undefined;
  let iterations = 0;
  let useAgent = false;
  let harnessId = "pi";
  let logDir = join(process.cwd(), ".mentat", "runs");
  let model: string | undefined;
  let fromExperience = false;
  let experienceDir = defaultExperienceDir(process.cwd());
  let recent = 20;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--harness") harnessId = args[++i] ?? harnessId;
    else if (arg === "--log-dir") logDir = args[++i] ?? logDir;
    else if (arg === "--store") store = args[++i] ?? store;
    else if (arg === "--memory") memoryPath = args[++i] ?? memoryPath;
    else if (arg === "--facts") factsPath = args[++i];
    else if (arg === "--queries") queriesPath = args[++i];
    else if (arg === "--iterations") iterations = Number(args[++i] ?? "0") || 0;
    else if (arg === "--agent") useAgent = true;
    else if (arg === "--model") model = args[++i];
    else if (arg === "--from-experience") fromExperience = true;
    else if (arg === "--experience") experienceDir = args[++i] ?? experienceDir;
    else if (arg === "--recent") recent = Number(args[++i] ?? "20") || 20;
  }
  if (!queriesPath || (!factsPath && !useAgent)) {
    process.stderr.write("evolve memory: --queries is required (and --facts unless --agent)\n");
    return 1;
  }
  if (fromExperience && !useAgent) {
    process.stderr.write("evolve memory: --from-experience requires --agent\n");
    return 1;
  }

  const facts = factsPath ? (JSON.parse(readFileSync(factsPath, "utf8")) as MemoryEntry[]) : [];
  const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as RecallQuery[];
  const rebuild = (snapshot: ArtifactSnapshot) =>
    memoryArtifact(snapshot.id, snapshot.snapshot as unknown as MemoryEntry[]);

  const root: Candidate = JsonStoreWorkspace.load(store, rebuild) ?? {
    id: "root",
    version: "root",
    artifacts: [memoryArtifact("memory", [])],
  };

  const digest = fromExperience
    ? buildExperienceDigest(new ExperienceStore(experienceDir).recent(recent))
    : "";
  const tracer = new FileTrajectoryStore(join(logDir, randomUUID()), {
    metadata: { operation: "evolve-memory", model: model ?? null, harness: harnessId },
  });
  tracer.emit("evolution.input", {
    facts: facts as unknown as import("@mentat/core").JsonValue,
    queries: queries as unknown as import("@mentat/core").JsonValue,
  });
  const runner = async (prompt: string) => {
    const result = await runOnce(
      createDefaultRegistry("ask").get(harnessId),
      { cwd: process.cwd(), ...(model ? { model } : {}) },
      { text: prompt },
      { tracer, deps: { onPermission: { request: () => "deny" } } },
    );
    if (result.reason !== "done")
      throw new Error(result.error ?? `proposer ended: ${result.reason}`);
    return result.text;
  };
  const proposer = useAgent
    ? createAgentMemoryProposer(queries, runner, digest)
    : new RuleMemoryProposer(facts);

  const loop = new SelfIterationLoop({
    tracer,
    workspace: new JsonStoreWorkspace(store, root),
    proposer,
    evaluator: new FunctionEvaluator([recallTask(queries)]),
    gates: new GateChain([memoryGate()]),
    config: { maxIterations: iterations > 0 ? iterations : useAgent ? 1 : facts.length },
  });
  try {
    const result = await loop.run();

    process.stdout.write("iter  child        gate   accepted  recall  noise\n");
    for (const record of result.records) {
      const recall = record.after?.find((signal) => signal.name === "recall")?.value ?? "-";
      const noise = record.after?.find((signal) => signal.name === "noise")?.value ?? "-";
      const gate = (record.gate?.passed ?? true) ? "pass" : "fail";
      process.stdout.write(
        `${String(record.iteration).padEnd(5)} ${record.childId.padEnd(12)} ${gate.padEnd(6)} ${(record.accepted ? "yes" : "no").padEnd(9)} ${String(recall).padEnd(7)} ${noise}\n`,
      );
    }
    process.stdout.write(`\nstore: ${store}\nbest: ${result.best.id}\n`);

    // Commit the selected entries to the live memory through the unified service
    // (dedup/versioning + audit), rather than bypassing it via the artifact store.
    const bestEntries = (result.best.artifacts[0]?.snapshot() ?? []) as unknown as MemoryEntry[];
    const service = new MemoryService(
      new JsonFileMemoryStore(memoryPath),
      new JsonlMemoryAudit(`${memoryPath}.audit.jsonl`),
    );
    const applied = applyEvolvedMemory(
      service,
      bestEntries,
      useAgent ? "agent" : "user",
      `evolve:${store}`,
    );
    process.stdout.write(
      `memory: ${applied} written via MemoryService (${bestEntries.length - applied} duplicate) -> ${memoryPath}\n`,
    );
    tracer.emit("memory.evolution.applied", { applied, evidence: `evolve:${store}` });
    return 0;
  } catch (error) {
    tracer.emit("evolution.error", { error: String(error) });
    throw error;
  } finally {
    await tracer.close();
  }
}
