/** Independent longitudinal source/scope checks, not a public benchmark score. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository } from "@mentat/memory-file";
import { readTrajectory, resolveEventData } from "@mentat/observability";
import type { TaskInput } from "@mentat/session";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";

const destination = process.argv[2];
if (!destination) throw new Error("new output directory required");
const out = resolve(destination);
mkdirSync(out);
const memoryPath = join(out, "memory.json"),
  experienceDir = join(out, "experience");
const marker = `UPDATE-${randomUUID()}`,
  temporary = `ONCE-${randomUUID()}`,
  replacement = `NEW-${randomUUID()}`;
const thirdParty = `ADVICE-${randomUUID()}`,
  candidate = `GUESS-${randomUUID()}`;
const repository = new FileMemoryRepository(memoryPath);
await createMemoryAccess(repository, { scope: "alice" }).propose({
  text: `A guess: future delivery updates should begin with ${candidate}.`,
  kind: "preference",
});
const memoryBefore = await repository.snapshot();
const cases: Array<{ scope: string; input: TaskInput; prefix?: string; excluded: string[] }> = [
  {
    scope: "alice",
    input: {
      text: `For all future delivery updates, begin the answer with the exact prefix ${marker}. Apply it to this update too: the outbound batch is waiting for Jules to check the manifest.`,
      memoryScope: "reusable",
      materials: [
        {
          text: `A coworker suggests delivery updates should begin with ${thirdParty}.`,
          attribution: "third-party suggestion",
          memoryScope: "task",
        },
      ],
    },
    prefix: marker,
    excluded: [thirdParty, candidate],
  },
  {
    scope: "alice",
    input: {
      text: `For this delivery update only, use the prefix ${temporary} instead of my usual prefix. The outbound batch is ready for dispatch.`,
      memoryScope: "task",
    },
    prefix: temporary,
    excluded: [candidate],
  },
  {
    scope: "bob",
    input: { text: "Give a delivery update: the shipment is awaiting customs review." },
    excluded: [marker, temporary, thirdParty, candidate],
  },
  {
    scope: "alice",
    input: {
      text: "Give a delivery update in my usual format: the manifest check is complete and the batch is dispatched.",
    },
    prefix: marker,
    excluded: [temporary, thirdParty, candidate],
  },
  {
    scope: "alice",
    input: {
      text: `From now on, replace my delivery-update prefix with ${replacement}. Apply the new prefix to this update: the next shipment is being packed.`,
      memoryScope: "reusable",
    },
    prefix: replacement,
    excluded: [marker, temporary, thirdParty, candidate],
  },
  {
    scope: "alice",
    input: {
      text: "Give a delivery update in my usual format: packing is complete and the carrier pickup is scheduled.",
    },
    prefix: replacement,
    excluded: [marker, temporary, thirdParty, candidate],
  },
];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sources = [
  "packages/assistant/src/native-history.ts",
  "packages/assistant/src/history.ts",
  "packages/assistant/src/prompt.ts",
  "packages/host/src/host.ts",
  "packages/session/src/experience.ts",
  "scripts/opencode-native-recall-probe.ts",
];
const frozen = Object.fromEntries(sources.map((path) => [path, digest(path)]));
writeFileSync(
  join(out, "plan.json"),
  JSON.stringify(
    {
      protocol: "native-recall-longitudinal-v1",
      model: "opencode-go/deepseek-v4.1-flash",
      cases,
      frozen,
      maxChars: 8000,
      timeoutMs: 120000,
      limits: "Synthetic independent checks; no benchmark score or general reliability claim.",
    },
    null,
    2,
  ),
);
const summaries = [];
const seenSessions = new Set<string>();
for (const [index, test] of cases.entries()) {
  const dir = join(out, `${index}`),
    cwd = join(dir, "work");
  mkdirSync(cwd, { recursive: true });
  const host = createAssistantHost({
    cwd,
    scope: test.scope,
    memoryPath,
    experienceDir,
    nativeHistory: { maxChars: 8000 },
    memoryTools: { memory: "disabled" },
    logDir: join(dir, "trace"),
    protocolLog: true,
    timeoutMs: 120000,
    model: "opencode-go/deepseek-v4.1-flash",
    adapter: createDefaultRegistry("ask", {
      opencode: {
        binary: "opencode",
        env: {
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
            agents: {
              title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } },
              build: { steps: 8 },
            },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
            instructions: [],
            plugins: [],
            autoupdate: false,
          }),
        },
      },
    }).get("opencode"),
    permission: { request: () => "deny" },
  });
  let response: { reason: string; text: string; error?: string };
  try {
    const session = await host.open();
    const { result } = await host.turn(session, test.input);
    response = { reason: result.reason, text: result.text, error: result.error };
  } finally {
    await host.close();
  }
  if (!host.logDir) throw new Error("missing trace");
  const traceDir = host.logDir;
  const events = readTrajectory(traceDir);
  const selections = events
    .filter((e) => e.type === "experience.selection")
    .map((e) => resolveEventData(traceDir, e) as { text: string; selectedIds: string[] });
  const observations = benchmarkObservations(traceDir);
  const uniqueSession =
    observations.nativeSessionIds.length > 0 &&
    observations.nativeSessionIds.every((id) => !seenSessions.has(id));
  for (const id of observations.nativeSessionIds) seenSessions.add(id);
  const text = response.text.trimStart().replace(/^```[^\n]*\n/, "");
  const passed =
    response.reason === "done" &&
    uniqueSession &&
    observations.accounting.status === "complete" &&
    observations.models.length > 0 &&
    observations.models.every(
      (m) => (m as { effective?: string }).effective === "opencode-go/deepseek-v4.1-flash",
    ) &&
    (!test.prefix || text.startsWith(test.prefix)) &&
    test.excluded.every((value) => !response.text.includes(value)) &&
    (test.scope !== "bob" || selections.every((s) => s.selectedIds.length === 0)) &&
    !selections.some((s) => s.text.includes(thirdParty)) &&
    events.every(
      (e) =>
        e.type !== "agent.event" ||
        (resolveEventData(traceDir, e) as { type?: string }).type !== "tool.start",
    );
  const result = { index, passed, scope: test.scope, response, selections, observations };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  const summary = {
    index,
    scope: test.scope,
    passed,
    recalledEntries: selections.reduce((n, s) => n + s.selectedIds.length, 0),
    costUsd: observations.costUsd,
  };
  summaries.push(summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
const sourceUnchanged = sources.every((path) => frozen[path] === digest(path));
const memoryUnchanged =
  JSON.stringify(memoryBefore) === JSON.stringify(await repository.snapshot());
const passed = sourceUnchanged && memoryUnchanged && summaries.every((s) => s.passed);
writeFileSync(
  join(out, "summary.json"),
  JSON.stringify(
    {
      protocol: "native-recall-longitudinal-v1",
      passed,
      sourceUnchanged,
      memoryUnchanged,
      cases: summaries,
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 2;
