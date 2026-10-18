/** Real-model contract probe, separate from public dataset scores.
 * Only the project's two memory tools are enabled. No general shell/web/file tools.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { FileMemoryRepository } from "@mentat/memory-file";
import { readTrajectory, resolveEventData } from "@mentat/observability";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";
import { checkoutIdentity } from "../packages/cli/src/lib/benchmark-subject";

const out = resolve(process.argv[2] ?? ".mentat/public-evaluations/memory-tools-probe-v1");
mkdirSync(out);
const identity = checkoutIdentity(process.cwd(), join(out, "checkout-source.json"));
const model = "opencode-go/deepseek-v4.1-flash";
const warmupIndex = process.argv.indexOf("--warmup-ms");
const warmupMs = warmupIndex < 0 ? 0 : Number(process.argv[warmupIndex + 1]);
if (!Number.isFinite(warmupMs) || warmupMs < 0 || warmupMs > 10000)
  throw new Error("invalid diagnostic warmup");
const enabled = [
  "direct_memory_memory_add",
  "direct_memory_memory_search",
  "direct_memory_memory_ready",
];
const file = join(out, "memory.json");
const receiptPath = join(out, "mcp-catalog.jsonl"),
  readyToken = randomUUID();
const probeNonce = `ready-${randomUUID()}`;
const registryOptions = {
  acp: {
    binary: "opencode",
    baseArgs: ["acp"],
    startupSettleMs: warmupMs,
    startupReadiness: { receiptPath, token: readyToken, tools: ["memory_add", "memory_search"] },
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model,
        small_model: model,
        autoupdate: false,
        share: "disabled",
        instructions: [],
        plugin: [],
        mcp: {
          servers: {
            direct_memory: {
              type: "local",
              codemode: false,
              command: [
                process.execPath,
                fileURLToPath(new URL("../packages/memory-mcp/src/server.mjs", import.meta.url)),
              ],
              environment: {
                MENTAT_MEMORY_FILE: file,
                MENTAT_MEMORY_SCOPE: "memory-tools-contract",
                MENTAT_MCP_READY_FILE: receiptPath,
                MENTAT_MCP_READY_TOKEN: readyToken,
                MENTAT_MCP_PROBE_NONCE: probeNonce,
              },
            },
          },
        },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...enabled.map((action) => ({ action, resource: "*", effect: "allow" })),
        ],
      }),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
  },
};
writeFileSync(join(out, "configuration.json"), registryOptions.acp.env.OPENCODE_CONFIG_CONTENT, {
  flag: "wx",
});
if (process.argv.includes("--config-only")) process.exit(0);
const registry = createDefaultRegistry("ask", registryOptions);
const host = createAssistantHost({
  cwd: out,
  adapter: registry.get("acp"),
  model,
  memoryPath: file,
  experienceDir: join(out, "experience"),
  logDir: join(out, "trace"),
  scope: "memory-tools-contract",
  memoryTools: {
    memory: "read-write",
    transport: "external",
    searchName: enabled[1],
    addName: enabled[0],
  },
  requireFinalAnswer: true,
  startupToolProbe: {
    toolName: "direct_memory_memory_ready",
    expectedOutput: probeNonce,
    maxAttempts: 2,
  },
  timeoutMs: 180000,
  protocolLog: true,
  permissionMode: "memory-tools-only",
  permission: { request: (request) => (enabled.includes(request.toolName) ? "allow" : "deny") },
});
const nonce = `probe-${randomUUID()}`;
const turns: unknown[] = [];
try {
  const session = await host.open();
  turns.push(
    await host.turn(session, {
      text: `For a diagnostic, propose one unconfirmed memory candidate with key public-probe and text: diagnostic label is ${nonce}. Do not claim it is confirmed.`,
      hostPolicy:
        "Use the available memory_add tool for this diagnostic. Do not print a simulated tool call. Other tools are forbidden.",
      memoryScope: "task",
    }),
  );
  const second = await host.open();
  turns.push(
    await host.turn(second, {
      text: "Find the unconfirmed candidate with key public-probe. What diagnostic label does it contain? Identify it as unconfirmed.",
      hostPolicy:
        "Use memory_search with includeCandidates=true for this diagnostic. Do not print a simulated tool call. Other tools are forbidden.",
      memoryScope: "task",
    }),
  );
} finally {
  await host.close();
}
const snapshot = await new FileMemoryRepository(file).snapshot();
const traceDir = host.logDir;
const events = traceDir
  ? readTrajectory(traceDir).map((e) => ({
      type: e.type,
      data: resolveEventData(traceDir, e) as Record<string, unknown> | undefined,
    }))
  : [];
const tools = events
  .filter((e) => e.type === "agent.event" && e.data?.type === "tool.start")
  .map((e) => e.data?.name);
const candidateStored = snapshot.entries.some(
  (e) => e.text.includes(nonce) && e.status === "candidate",
);
const candidateActivated = snapshot.entries.some(
  (e) => e.text.includes(nonce) && e.status === "active",
);
const candidateReadBack =
  turns.length === 2 &&
  String((turns[1] as { result: { text: string } }).result.text).includes(nonce);
const addExecuted = tools.some((name) => String(name).includes("memory_add"));
const searchExecuted = tools.some((name) => String(name).includes("memory_search"));
const result = {
  model,
  ...identity,
  enabled,
  warmupMs,
  turns,
  tools,
  candidateStored,
  candidateActivated,
  candidateReadBack,
  addExecuted,
  searchExecuted,
  snapshot,
  observations: benchmarkObservations(host.logDir),
  scope:
    "Synthetic real-model instrumentation probe; not a benchmark score or learning-efficacy result.",
};
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2), { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ tools, candidateStored, candidateActivated, evidence: join(out, "result.json") })}\n`,
);
if (!addExecuted || !searchExecuted || !candidateStored || !candidateReadBack || candidateActivated)
  process.exitCode = 1;
