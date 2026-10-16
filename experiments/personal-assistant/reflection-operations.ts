/** Model-backed replay of real interaction evidence; no regeneration of task answers or hidden rubrics. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantHost } from "@mentat/host";
import { inspectTrajectory, readTrajectory, resolveEventData } from "@mentat/observability";
import type { ExperienceRecord } from "@mentat/session";
import { createAcpAdapter } from "@mentat/transport-acp";

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const source = resolve(arg("--source") ?? ".mentat/experiments/multiturn-scope-merge-20261015");
const out = resolve(arg("--out") ?? `.mentat/experiments/reflection-operations-${Date.now()}`);
if (existsSync(out)) throw Error("use a new output directory");
const sourceText = readFileSync(join(source, "results.jsonl"), "utf8");
const rows = sourceText
  .trim()
  .split("\n")
  .map(
    (line) =>
      JSON.parse(line) as { id: string; arm: string; turns: Array<{ record?: ExperienceRecord }> },
  )
  .filter((row) => row.arm === "persistent");
if (
  rows.length !== 3 ||
  rows.some((row) => row.turns.length !== 4 || row.turns.some((turn) => !turn.record))
)
  throw Error("expected three completed four-turn persistent tasks");
mkdirSync(out, { recursive: true });
const write = (name: string, data: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(data, null, 2)}\n`);
const model = process.env.MENTAT_SMOKE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
write("manifest.json", {
  model,
  source,
  sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
  reflectionSchemaVersion: "evidence-operations-v3",
  maximumCalls: 3,
  treatment:
    "empty isolated candidate branch; no active user profile; same cumulative real evidence",
});
const host = createAssistantHost({
  cwd: out,
  memoryPath: join(out, "memory.json"),
  logDir: join(out, "traces"),
  model,
  timeoutMs: 30000,
  protocolLog: true,
  adapter: createAcpAdapter({
    binary: "opencode",
    baseArgs: ["acp"],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        small_model: model,
        autoupdate: false,
        share: "disabled",
        instructions: [],
        plugin: [],
        permission: { "*": "deny" },
      }),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
  }),
});
const history: ExperienceRecord[] = [];
const results: unknown[] = [];
try {
  for (const row of rows) {
    for (const turn of row.turns) if (turn.record) history.push(turn.record);
    const reflection = await host.reflect(
      {
        task: history.map((record) => record.prompt).join("\n"),
        outcome: "done",
        tools: [...new Set(history.flatMap((record) => record.tools))],
        interactions: history,
      },
      { timeoutMs: 90000 },
    );
    const memory = await host.memory.search({});
    results.push({ id: row.id, interactions: history.length, reflection, memory });
    write("results.json", results);
    process.stdout.write(
      `${JSON.stringify({ id: row.id, status: reflection.status, added: reflection.added, merged: reflection.merged, skipped: reflection.skipped, rejected: reflection.rejected, memories: memory.length })}\n`,
    );
  }
} finally {
  await host.close();
  if (host.logDir) {
    const ids = new Set<string>(),
      models: unknown[] = [];
    for (const event of readTrajectory(host.logDir)) {
      const data = resolveEventData(host.logDir, event) as Record<string, unknown> | undefined;
      if (event.type === "adapter.diagnostic" && data?.code === "ACP_MODEL_CONFIRMED")
        models.push(JSON.parse(String(data.message)));
      const wire = data?.data as { result?: { sessionId?: unknown } } | undefined;
      if (event.type === "adapter.protocol" && typeof wire?.result?.sessionId === "string")
        ids.add(wire.result.sessionId);
    }
    const accounting = JSON.parse(
      execFileSync(
        "python3",
        [fileURLToPath(new URL("./multiturn-accounting.py", import.meta.url))],
        { input: JSON.stringify([...ids]), encoding: "utf8", timeout: 10000 },
      ),
    );
    write("validation.json", {
      model,
      models,
      accounting,
      trajectory: inspectTrajectory(host.logDir),
    });
  }
}
