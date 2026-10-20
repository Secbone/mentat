/** Synthetic integration check through the public host API, not a benchmark score. */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDefaultRegistry } from "@mentat/harnesses";
import { createAssistantHost } from "@mentat/host";
import { projectExperience, readTrajectory, resolveEventData } from "@mentat/observability";
import { FileSkillRepository } from "@mentat/skills-file";
import { benchmarkObservations } from "../packages/cli/src/lib/benchmark-observations";

const destination = process.argv[2];
if (!destination) throw new Error("output directory required");
const out = resolve(destination);
mkdirSync(out);
const cwd = join(out, "work");
mkdirSync(cwd);
const nonce = `check-${randomUUID()}`;
const config = {
  model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" },
  agents: {
    title: { model: { providerID: "opencode-go", model: "deepseek-v4.1-flash" } },
    build: { steps: 12 },
  },
  instructions: [],
  plugins: [],
  autoupdate: false,
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    ...["procedures_skills_list", "procedures_skill_view", "procedures_skill_save"].map(
      (action) => ({ action, resource: "*", effect: "allow" }),
    ),
  ],
};
const host = createAssistantHost({
  cwd,
  adapter: createDefaultRegistry("ask", {
    opencode: {
      binary: "opencode",
      env: { OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    },
  }).get("opencode"),
  model: "opencode-go/deepseek-v4.1-flash",
  memoryPath: join(out, "memory.json"),
  memoryTools: { memory: "disabled" },
  skillsPath: join(out, "skills.json"),
  scope: "synthetic-probe",
  logDir: join(out, "trace"),
  timeoutMs: 120000,
  protocolLog: true,
  permission: { request: () => "deny" },
});
const task = `Save a reusable procedure named verify-export. Applicability: checking a locally generated export. Steps: count the records, compare the count to the source, and report any discrepancy. Supporting evidence: a synthetic integration exercise observed that comparing counts detected a truncated export. Include the diagnostic marker ${nonce} in the procedure content. Then find and open the saved procedure using the procedure tools to verify that it was persisted. Do not use shell, files, or external services.`;
let status: unknown;
try {
  const session = await host.open();
  const { result, record } = await host.turn(session, task);
  status = { reason: result.reason, error: result.error, text: result.text, turnId: record.id };
} finally {
  await host.close();
}
const rows = new FileSkillRepository(join(out, "skills.json")).list("synthetic-probe");
const observations = benchmarkObservations(host.logDir);
if (!host.logDir) throw new Error("missing host trace");
const taskTurn = readTrajectory(host.logDir).find(
  (event) =>
    event.type === "turn.start" &&
    (resolveEventData(host.logDir as string, event) as { input?: { text?: string } }).input
      ?.text === task,
);
if (!taskTurn?.turnId) throw new Error("missing task turn");
const calls =
  projectExperience(
    host.logDir,
    { prompt: task, cwd, harness: "opencode" },
    taskTurn.turnId,
  ).toolCalls?.filter((c) => c.kind === "call") ?? [];
const passed =
  rows.some((s) => s.name === "verify-export" && s.content.includes(nonce)) &&
  calls.some((c) => c.name === "procedures_skill_save" && c.status === "completed") &&
  calls.some((c) => c.name === "procedures_skill_view" && c.status === "completed");
writeFileSync(
  join(out, "result.json"),
  JSON.stringify({ passed, status, calls, observations, skills: rows }, null, 2),
);
process.stdout.write(
  `${JSON.stringify({
    passed,
    result: join(out, "result.json"),
    calls: calls.map((c) => ({ name: c.name, status: c.status })),
    costUsd: observations.costUsd,
  })}\n`,
);
process.exitCode = passed ? 0 : 2;
