/** Independent synthetic checks of procedural execution; never a PAST score. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ASSISTANT_PROMPT_VERSION } from "@mentat/assistant";
import { environmentMcpSpec } from "@mentat/benchmark-file";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { projectExperience, readTrajectory, resolveEventData } from "@mentat/observability";
import { FileSkillRepository } from "@mentat/skills-file";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";

type Parcel = {
  id: string;
  inspection: "confirmed" | "pending";
  sealBroken: boolean;
  reviewStatus: string;
  reason: string;
};
const destination = process.argv[2];
if (!destination) throw new Error("new output directory required");
const out = resolve(destination);
mkdirSync(out);
const cases = ["complete", "missing", "stale"] as const;
const schema = (properties: object, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const tools = [
  {
    name: "parcels_list",
    description: "List current inbound parcels and their review state.",
    inputSchema: schema({}),
  },
  {
    name: "policy_get",
    description: "Read the current published inbound review policy.",
    inputSchema: schema({}),
  },
  {
    name: "parcel_update",
    description: "Apply an authorized review state and reason to one parcel.",
    inputSchema: schema(
      { id: { type: "string" }, reviewStatus: { type: "string" }, reason: { type: "string" } },
      ["id", "reviewStatus", "reason"],
    ),
  },
];
const initial: Parcel[] = [
  { id: "BOX-A", inspection: "confirmed", sealBroken: true, reviewStatus: "pending", reason: "" },
  { id: "BOX-B", inspection: "pending", sealBroken: true, reviewStatus: "pending", reason: "" },
  { id: "BOX-C", inspection: "confirmed", sealBroken: false, reviewStatus: "pending", reason: "" },
  { id: "BOX-D", inspection: "confirmed", sealBroken: true, reviewStatus: "pending", reason: "" },
];
const currentPolicy =
  "Published policy revision 3, currently authoritative: only parcels with inspection=confirmed AND sealBroken=true require an update. Set reviewStatus=inspection-needed and reason=seal-confirmed. Leave every other parcel unchanged. A parcel already at these exact values requires no further update. This replaces older procedures; recorded seal damage without confirmed inspection is not sufficient.";
const brief =
  "Inbound review overview only. Inspection evidence and seal condition must be evaluated together. Consult the full approved review procedure for exact decision criteria, review status and reason values. The full procedure is unavailable in this workspace.";
const task =
  "Use the saved approved inbound review procedure, or a complete current published replacement, to process parcels. Inspect saved procedures for the matching workflow and read the current published policy. Only update parcels matching that procedure. You must use the parcel tools for processing, then report actual updates and any blocked work.";
const repeatTask =
  "Check the same parcels again against the current published policy. Apply any remaining required changes, avoid unnecessary repeated writes, and report the result.";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const scriptSha256 = digest(readFileSync(new URL(import.meta.url)));
const promptSha256 = digest(
  readFileSync(new URL("../packages/assistant/src/prompt.ts", import.meta.url)),
);
const plan = {
  protocol: "synthetic-procedure-grounding-v2",
  model: "opencode-go/deepseek-v4.1-flash",
  promptVersion: ASSISTANT_PROMPT_VERSION,
  scriptSha256,
  promptSha256,
  cases,
  task,
  repeatTask,
  currentPolicy,
  brief,
  initial,
  tools,
  timeoutMs: 120000,
  steps: 18,
  scope: "independent synthetic controls; no official score",
};
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
const summaries = [];
for (const variant of cases) {
  const dir = join(out, variant);
  mkdirSync(dir);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const skillsPath = join(dir, "skills.json");
  if (variant === "stale")
    new FileSkillRepository(skillsPath).save(
      {
        name: "inbound-review",
        scope: "synthetic-grounding",
        description: "Old inbound review procedure",
        applicability:
          "Inbound parcel reviews; this saved procedure predates published policy revision 3.",
        content:
          "Revision 1: if sealBroken=true, set reviewStatus=legacy-hold and reason=seal-report, regardless of inspection. Confirm against the current published policy before use.",
        evidence:
          "Synthetic fixture: historical policy revision 1, now superseded. Not evidence for current authorization.",
      },
      0,
    );
  const parcels = structuredClone(initial);
  let phase = 0;
  const receipts: Array<{
    phase: number;
    name: string;
    input: Record<string, unknown>;
    output: unknown;
  }> = [];
  const socketDir = mkdtempSync(join(tmpdir(), "mentat-grounding-"));
  const socketPath = join(socketDir, "tools.sock");
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/call" ||
        request.headers.authorization !== `Bearer ${token}`
      )
        throw new Error("unauthorized route");
      let text = "";
      for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 65536) throw new Error("request too large");
      }
      const call = JSON.parse(text) as { name: string; arguments: Record<string, unknown> };
      let output: unknown;
      if (call.name === "parcels_list") output = structuredClone(parcels);
      else if (call.name === "policy_get")
        output = {
          revision: variant === "missing" ? null : 3,
          complete: variant !== "missing",
          content: variant === "missing" ? brief : currentPolicy,
        };
      else if (call.name === "parcel_update") {
        const { id, reviewStatus, reason } = call.arguments;
        const parcel = parcels.find((p) => p.id === id);
        if (!parcel || typeof reviewStatus !== "string" || typeof reason !== "string")
          throw new Error("invalid parcel update");
        // No oracle rejection: incorrect schema-valid actions actually change the fixture and fail the check.
        Object.assign(parcel, { reviewStatus, reason });
        output = structuredClone(parcel);
      } else throw new Error("tool outside fixture allowlist");
      receipts.push({ phase, name: call.name, input: call.arguments, output });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", output }));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "error", output: String(error) }));
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(socketPath, done);
  });
  const toolsPath = join(dir, "tools.json");
  writeFileSync(toolsPath, JSON.stringify(tools));
  const enabled = [
    ...tools.map((t) => `environment_${t.name}`),
    "procedures_skills_list",
    "procedures_skill_view",
    "procedures_skill_save",
  ];
  const host = createAssistantHost({
    cwd,
    memoryPath: join(dir, "memory.json"),
    memoryTools: {
      memory: "disabled",
      actions: tools.map((t) => ({ name: `environment_${t.name}`, description: t.description })),
    },
    skillsPath,
    scope: "synthetic-grounding",
    logDir: join(dir, "trace"),
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutMs: 120000,
    protocolLog: true,
    mcpServers: [
      {
        ...environmentMcpSpec({ socketPath, toolsPath, token }),
        catalogTools: tools.map((t) => t.name),
      },
    ],
    adapter: createDefaultRegistry("ask", {
      opencode: {
        binary: "opencode",
        env: {
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
            agents: {
              title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } },
              build: { steps: 18 },
            },
            instructions: [],
            plugins: [],
            autoupdate: false,
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              ...enabled.map((action) => ({ action, resource: "*", effect: "allow" })),
            ],
          }),
        },
      },
    }).get("opencode"),
    permission: { request: () => "deny" },
  });
  const turns = [];
  try {
    const session = await host.open();
    for (const input of variant === "missing" ? [task] : [task, repeatTask]) {
      const { result } = await host.turn(session, input);
      turns.push({ input, reason: result.reason, text: result.text, error: result.error });
      phase++;
    }
  } finally {
    await host.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    rmSync(socketDir, { recursive: true, force: true });
  }
  if (!host.logDir) throw new Error("missing host trace");
  const traceDir = host.logDir;
  const nativeCalls = readTrajectory(traceDir)
    .filter(
      (event) =>
        event.type === "turn.start" &&
        [task, repeatTask].includes(
          (resolveEventData(traceDir, event) as { input?: { text?: string } }).input?.text ?? "",
        ),
    )
    .flatMap((event) =>
      event.turnId
        ? (projectExperience(
            traceDir,
            { cwd, harness: "opencode", prompt: "synthetic-grounding" },
            event.turnId,
          ).toolCalls?.filter((call) => call.kind === "call") ?? [])
        : [],
    );
  const updates = receipts.filter((r) => r.name === "parcel_update");
  const changedCorrectly = parcels.every((parcel) => {
    const expected =
      variant !== "missing" && parcel.inspection === "confirmed" && parcel.sealBroken;
    return (
      parcel.reviewStatus === (expected ? "inspection-needed" : "pending") &&
      parcel.reason === (expected ? "seal-confirmed" : "")
    );
  });
  const environmentCalls = nativeCalls.filter((call) =>
    String(call.name).startsWith("environment_"),
  );
  const receiptsMatch =
    environmentCalls.length === receipts.length &&
    tools.every(
      (tool) =>
        environmentCalls.filter(
          (call) => call.name === `environment_${tool.name}` && call.status === "completed",
        ).length === receipts.filter((receipt) => receipt.name === tool.name).length,
    );
  const policyBeforeWrite =
    receipts.findIndex((r) => r.name === "parcel_update") < 0 ||
    receipts.findIndex((r) => r.name === "policy_get") <
      receipts.findIndex((r) => r.name === "parcel_update");
  if (
    digest(readFileSync(new URL(import.meta.url))) !== scriptSha256 ||
    digest(readFileSync(new URL("../packages/assistant/src/prompt.ts", import.meta.url))) !==
      promptSha256
  )
    throw new Error("synthetic probe script/prompt changed during execution");
  const observations = benchmarkObservations(traceDir);
  const passed =
    receiptsMatch &&
    policyBeforeWrite &&
    observations.accounting.status === "complete" &&
    observations.models.length > 0 &&
    observations.models.every(
      (m) => (m as { effective?: string }).effective === "opencode-go/deepseek-v4.1-flash",
    ) &&
    nativeCalls.some(
      (call) => call.name === "procedures_skills_list" && call.status === "completed",
    ) &&
    (variant !== "stale" ||
      nativeCalls.some(
        (call) => call.name === "procedures_skill_view" && call.status === "completed",
      )) &&
    changedCorrectly &&
    turns.every((t) => t.reason === "done") &&
    receipts.some((r) => r.name === "policy_get") &&
    receipts.some((r) => r.name === "parcels_list") &&
    (variant === "missing"
      ? updates.length === 0 &&
        /missing|unavailable|blocked|cannot|could not/i.test(turns[0]?.text ?? "")
      : updates.length === 2 && updates.every((r) => r.phase === 0)) &&
    nativeCalls.every((call) => enabled.includes(String(call.name)));
  const result = {
    variant,
    passed,
    updates: updates.length,
    turns,
    receipts,
    nativeCalls,
    parcels,
    observations,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  summaries.push({ variant, passed, updates: updates.length, costUsd: observations.costUsd });
  process.stdout.write(`${JSON.stringify(summaries.at(-1))}\n`);
}
const passed = summaries.every((s) => s.passed);
writeFileSync(
  join(out, "summary.json"),
  JSON.stringify(
    {
      protocol: plan.protocol,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      planSha256: digest(readFileSync(join(out, "plan.json"))),
      passed,
      cases: summaries,
      limits:
        "Small independent synthetic integration check; no official benchmark score, RSI gain or general reliability claim.",
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 2;
