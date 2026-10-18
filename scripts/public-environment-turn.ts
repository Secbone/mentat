/** One real tool-enabled task. Controller files/labels never enter model messages. */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { environmentMcpSpec, sha256, verifySourceArchive } from "@mentat/benchmark-file";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { FileTrajectoryStore, projectExperience, readTrajectory } from "@mentat/observability";
import { closeSession, openSession, runTurn } from "@mentat/session";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";
import { checkoutIdentity } from "../packages/cli/src/lib/benchmark-subject";

const [configuration, output] = process.argv.slice(2);
if (!configuration || !output)
  throw new Error("usage: public-environment-turn.ts <controller.json> <new-output>");
const config = JSON.parse(readFileSync(configuration, "utf8"));
if (
  Object.keys(config).some(
    (k) =>
      ![
        "socketPath",
        "toolsPath",
        "token",
        "query",
        "system",
        "method",
        "timeoutMs",
        "maxSteps",
      ].includes(k),
  ) ||
  typeof config.query !== "string" ||
  typeof config.system !== "string" ||
  !["mentat", "upstream-basic"].includes(config.method)
)
  throw new Error("invalid controller fields; private labels must remain in upstream runner");
const timeoutMs = config.timeoutMs ?? 180000,
  maxSteps = config.maxSteps ?? 20;
if (
  !Number.isSafeInteger(maxSteps) ||
  maxSteps < 1 ||
  maxSteps > 100 ||
  !Number.isFinite(timeoutMs) ||
  timeoutMs <= 0
)
  throw new Error("invalid task budget");
const out = resolve(output);
const disk = statfsSync(process.cwd(), { bigint: true });
if (disk.bavail * disk.bsize < 30n * 1024n ** 3n) throw new Error("host disk reserve below 30 GiB");
mkdirSync(out);
const cwd = join(out, "work");
mkdirSync(cwd);
const model = "opencode-go/deepseek-v4.1-flash";
const environment = environmentMcpSpec(config);
const tools = JSON.parse(readFileSync(config.toolsPath, "utf8")) as Array<{ name: string }>;
const memory = memoryMcpSpec(join(out, "memory.json"), "public-task");
const probeNonce = `ready-${randomUUID()}`,
  readyToken = randomUUID(),
  receiptPath = join(out, "mcp-catalog.jsonl");
memory.env = {
  ...memory.env,
  MENTAT_MCP_PROBE_NONCE: probeNonce,
  MENTAT_MCP_READY_FILE: receiptPath,
  MENTAT_MCP_READY_TOKEN: readyToken,
};
const enabled = [
  ...tools.map((t) => `environment_${t.name}`),
  ...(config.method === "mentat"
    ? ["direct_memory_memory_add", "direct_memory_memory_search", "direct_memory_memory_ready"]
    : []),
];
const local = (spec: typeof environment) => ({
  type: "local",
  codemode: false,
  command: [spec.command, ...spec.args],
  environment: spec.env,
});
const engineConfig = {
  model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
  agents: {
    title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } },
    build: { steps: maxSteps },
  },
  autoupdate: false,
  share: "disabled",
  instructions: [],
  plugins: [],
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    ...enabled.map((action) => ({ action, resource: "*", effect: "allow" })),
  ],
  mcp: {
    servers: {
      environment: local(environment),
      ...(config.method === "mentat"
        ? {
            direct_memory: {
              type: "local",
              codemode: false,
              command: [memory.command, ...(memory.args ?? [])],
              environment: memory.env,
            },
          }
        : {}),
    },
  },
};
const sourceArchive = process.env.MENTAT_BENCH_FROZEN_ARCHIVE;
if (sourceArchive) {
  const frozen = JSON.parse(readFileSync(join(dirname(sourceArchive), "manifest.json"), "utf8"));
  if (
    resolve(frozen.source) !== process.cwd() ||
    process.env.TSX_TSCONFIG_PATH !== join(process.cwd(), "tsconfig.json") ||
    sha256(readFileSync(join(frozen.dependencyWorkspace, "pnpm-lock.yaml"))) !==
      frozen.dependencyLockSha256
  )
    throw new Error("frozen checkout/dependency identity mismatch");
  for (const name of [
    "@mentat/host",
    "@mentat/session",
    "@mentat/memory-file",
    "@mentat/memory-mcp",
    "@mentat/benchmark-file",
  ])
    if (!import.meta.resolve(name).startsWith(pathToFileURL(`${process.cwd()}/`).href))
      throw new Error(`workspace module escaped frozen source: ${name}`);
}
const identity = sourceArchive
  ? verifySourceArchive(process.cwd(), sourceArchive)
  : checkoutIdentity(process.cwd(), join(out, "checkout-source.json"));
// The runtime token is transport authorization, never part of the model-visible task.
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      ...identity,
      sourceArchive: sourceArchive ?? join(out, "checkout-source.json"),
      model,
      method: config.method,
      maxSteps,
      timeoutMs,
      enabled,
      startupReadiness:
        config.method === "mentat"
          ? "catalog-receipt-and-native-read-only-probe"
          : "compatibility-delay-only",
      network: "only declared Unix-socket tools; model service required; OS isolation unverified",
    },
    null,
    2,
  ),
);
const adapter = createDefaultRegistry("ask", {
  acp: {
    binary: "opencode",
    baseArgs: ["acp"],
    startupSettleMs: config.method === "mentat" ? 0 : 2000,
    ...(config.method === "mentat"
      ? {
          startupReadiness: {
            receiptPath,
            token: readyToken,
            tools: ["memory_ready", "memory_search", "memory_add"],
          },
        }
      : {}),
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(engineConfig),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
  },
}).get("acp");
const permission = { request: () => "deny" as const };
let text: string, reason: string, evidenceDir: string | undefined;
if (config.method === "mentat") {
  const host = createAssistantHost({
    cwd,
    adapter,
    model,
    memoryPath: join(out, "memory.json"),
    experienceDir: join(out, "experience"),
    logDir: join(out, "trace"),
    scope: "public-task",
    memoryTools: {
      memory: "read-write",
      transport: "external",
      searchName: "direct_memory_memory_search",
      addName: "direct_memory_memory_add",
    },
    requireFinalAnswer: true,
    startupToolProbe: {
      toolName: "direct_memory_memory_ready",
      expectedOutput: probeNonce,
      maxAttempts: 2,
    },
    permission,
    permissionMode: "declared-task-tools-only",
    protocolLog: true,
    timeoutMs,
  });
  try {
    const session = await host.open();
    const result = await host.turn(
      session,
      { text: config.query, hostPolicy: config.system, memoryScope: "task" },
      { timeoutMs },
    );
    text = result.result.text;
    reason = result.result.reason;
    evidenceDir = host.logDir;
  } finally {
    await host.close();
  }
} else {
  const trace = new FileTrajectoryStore(join(out, "trace"));
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    session = await openSession(
      adapter,
      { cwd, model, systemPrompt: config.system, systemPromptMode: "append" },
      {
        onDiagnostic: (d) => trace.emit("adapter.diagnostic", d),
        onProtocol: (r) => trace.emit("adapter.protocol", r as never),
        onPermission: permission,
      },
      { timeoutMs },
    );
    const result = await runTurn(session, { text: config.query }, { timeoutMs, tracer: trace });
    text = result.text;
    reason = result.reason;
  } finally {
    if (session) await closeSession(session);
    await trace.close();
  }
  evidenceDir = trace.dir;
}
const observations = benchmarkObservations(evidenceDir);
if (!observations.models.length || reason !== "done")
  throw new Error("unverified model or unfinished task");
if (!evidenceDir) throw new Error("missing tool trace");
const turnId = readTrajectory(evidenceDir).find((event) => event.type === "turn.start")?.turnId;
if (!turnId) throw new Error("missing task turn identity");
const calls = (
  projectExperience(evidenceDir, { prompt: config.query, cwd, harness: "acp" }, turnId).toolCalls ??
  []
).filter((call) => call.kind === "call");
if (calls.some((c) => !enabled.includes(String(c.name))))
  throw new Error("tool outside declared allowlist executed");
writeFileSync(
  join(out, "response.json"),
  JSON.stringify({ text, reason, calls, evidenceDir, observations }, null, 2),
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify({ response: join(out, "response.json") })}\n`);
