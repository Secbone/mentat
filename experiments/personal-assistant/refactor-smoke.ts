import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createFakeAdapter } from "@mentat/core";
import { createAssistantHost } from "@mentat/host";
import { inspectTrajectory, readTrajectory } from "@mentat/observability";
import { createAcpAdapter } from "@mentat/transport-acp";

// Bounded smoke, never a benchmark. All task state is confined to a fresh directory.
const real = process.argv.includes("--real");
const cwd = mkdtempSync(join(tmpdir(), "mentat-refactor-smoke-"));
const output = resolve(
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ?? join(cwd, "report.json"),
);
const model = process.env.MENTAT_SMOKE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const adapter = real
  ? createAcpAdapter({
      binary: "opencode",
      baseArgs: ["acp"],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model,
          small_model: model,
          autoupdate: false,
          share: "disabled",
          permission: { "*": "deny" },
          instructions: [],
        }),
      },
    })
  : createFakeAdapter();
const host = createAssistantHost({
  cwd,
  adapter,
  model: real ? model : undefined,
  memoryPath: join(cwd, "memory.json"),
  protocolLog: real,
  timeoutMs: 30_000,
  permission: { request: () => "deny" },
});
let error: string | undefined;
const outcomes: unknown[] = [];
try {
  const session = await host.open();
  await host.remember("请优先用中文给出简洁清单。周末安排必须在11点前回家，预留20分钟交通缓冲。");
  for (const task of [
    "给我一个周末上午办事安排。不要使用工具或访问任何外部资源。",
    "这次请用一段简短文字描述；只对本次生效。不要使用工具。",
    "再次给我周末上午安排，并检查回家时间和交通缓冲。不要使用工具。",
  ].slice(0, Number(process.argv.find((arg) => arg.startsWith("--turns="))?.slice(8) ?? 3))) {
    const { result } = await host.turn(session, task, { timeoutMs: 45_000 });
    outcomes.push({
      turnId: result.turnId,
      reason: result.reason,
      text: result.text,
      error: result.error,
    });
    if (result.reason !== "done") break;
  }
  if (outcomes.length === 3) {
    host.feedback({
      turnId: (outcomes[0] as { turnId: string }).turnId,
      correction: "用于验证反馈记录与任务关联，不代表质量评分",
    });
  }
} catch (cause) {
  error = String(cause);
} finally {
  await host.close();
}
const logDir = host.logDir;
if (!logDir) throw new Error("missing trace directory");
const report = {
  mode: real ? "real-model-smoke" : "fake-contract-smoke",
  cwd,
  logDir: host.logDir,
  modelRequested: real ? model : null,
  error,
  outcomes,
  trajectory: inspectTrajectory(logDir),
  eventTypes: [...new Set(readTrajectory(logDir).map((event) => event.type))],
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: output, ...report }));
if (error || outcomes.some((value) => (value as { reason: string }).reason !== "done"))
  process.exitCode = 1;
// Verify the report is independently readable after close.
JSON.parse(readFileSync(output, "utf8"));
