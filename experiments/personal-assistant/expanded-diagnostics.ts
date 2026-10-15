import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantPromptOptions } from "@mentat/assistant";
import { taskContext } from "@mentat/host";
import { buildTurnContext, type MemoryEntry } from "@mentat/memory";
import { JsonFileMemoryStore } from "@mentat/memory-file";
import { memoryMcpSpec } from "@mentat/memory-mcp";
import { createAcpAdapter } from "@mentat/transport-acp";
import { acpPermission, sendTurn } from "./runner";

const sourceArg = process.argv.indexOf("--source");
if (sourceArg < 0 || !process.argv[sourceArg + 1])
  throw new Error("--source expanded run directory required");
const source = resolve(process.argv[sourceArg + 1] as string);
const out = resolve(`.mentat/experiments/personal-assistant/expanded-diagnostics-${Date.now()}`);
mkdirSync(out);
const write = (path: string, data: unknown) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const model = "opencode-go/deepseek-v4.1-flash";
const controls = [
  {
    scenario: "teacher",
    name: "许敏",
    role: "初中数学教师",
    prompt: "给七年级学生讲比例，准备8分钟讲解。",
    material: "例子为2支笔6元，5支笔多少钱；学生理解整数乘除。",
    policies: [
      {
        id: "example-first",
        text: "许敏给学生讲课明确偏好先生活例子，再引出规则，最后一题检查理解。",
        criterion: "教学主体先具体实例后规则",
      },
      {
        id: "definition-first",
        text: "许敏给学生讲课明确偏好先给正式定义与规则，再用生活例子解释，最后一题检查理解。",
        criterion: "教学主体先定义规则后实例",
      },
    ],
  },
  {
    scenario: "finance",
    name: "陈悦",
    role: "企业财务分析员",
    prompt: "写管理层费用简报。",
    material: "已发生42000元，预算38000元，差异来自临时运费4000元；数据已齐。",
    policies: [
      {
        id: "cause-wanyuan",
        text: "陈悦的管理层费用简报偏好先解释差异原因再列数字；金额用万元保留一位小数。",
        criterion: "原因在金额表之前，4.2/3.8/0.4万元",
      },
      {
        id: "table-yuan",
        text: "陈悦的管理层费用简报偏好先给金额对比表再解释原因；金额用元保留两位小数。",
        criterion: "金额表在原因之前，42000.00/38000.00/4000.00元",
      },
    ],
  },
  {
    scenario: "retail",
    name: "吴桐",
    role: "小型电商经营者",
    prompt: "给等发货的客户起草一条回复。",
    material: "订单已延迟2天，仓库未确认出库日期；勿编造物流、承诺发货时间、退款或补偿。",
    policies: [
      {
        id: "short-50",
        text: "吴桐的客服表达偏好：全答复仅一条可发送的中文回复，50字以内（含标点），不要附说明或第二版本。",
        criterion: "全答复正文<=50字符，无附注或第二版本",
      },
      {
        id: "detailed-100-160",
        text: "吴桐的客服表达偏好：全答复仅一条可发送的中文回复，100至160字（含标点），有同理心且解释已知与未知，不附说明或第二版本。",
        criterion: "全答复正文100–160字符，无未确认承诺",
      },
    ],
  },
  {
    scenario: "designer",
    name: "沈禾",
    role: "自由职业设计师",
    prompt: "给首次合作的书店做海报初步提案。",
    material: "首次合作；A3；受众附近居民；主题旧书交换；下周五交付；只有一张海报，规格已确认。",
    policies: [
      {
        id: "one-direction",
        text: "沈禾的新客户首轮提案偏好只给一个推荐方向，并解释选择理由；不追加合同外内容。",
        criterion: "恰好一个方向及理由",
      },
      {
        id: "two-directions",
        text: "沈禾的新客户首轮提案偏好给两个有明确取舍的方向；不追加合同外内容。",
        criterion: "恰好两个方向，取舍明确",
      },
    ],
  },
];
const trials: Array<{
  id: string;
  scenario: string;
  arm: string;
  kind: string;
  input: string;
  memory: MemoryEntry[];
  criterion: string;
}> = [];
for (const item of controls)
  for (const policy of item.policies) {
    trials.push({
      id: `${item.scenario}-${policy.id}`,
      scenario: item.scenario,
      arm: policy.id,
      kind: "counterfactual-profile",
      input: `用户：${item.name}，${item.role}。\n任务：${item.prompt}\n材料：${item.material}\n仅草拟，不执行真实发送或排期。`,
      memory: [{ id: "controlled-profile", text: policy.text, tags: ["preference"], createdAt: 1 }],
      criterion: policy.criterion,
    });
  }
const pressureInput = JSON.parse(readFileSync(join(source, "pressure-small-1.json"), "utf8")).input;
const saturation: MemoryEntry[] = JSON.parse(
  readFileSync(join(source, "pressure-same-priority-saturation.memory.json"), "utf8"),
);
for (let repetition = 1; repetition <= 2; repetition += 1)
  trials.push({
    id: `pressure-saturated-${repetition}`,
    scenario: "household-pressure",
    arm: "saturated",
    kind: "pressure",
    input: pressureInput,
    memory: saturation,
    criterion: "硬约束被预算排除时，观察MCP补查是否恢复并识别11:15超过11:00",
  });
write(join(out, "plan.json"), {
  source,
  model,
  maxHostCalls: 10,
  maxObservedCostUsd: 0.1,
  concurrency: 2,
  controlledProfiles: "人工构造相反且无冲突的单条画像；检验偏好响应能力，不算自动学习成绩",
  criteriaNotSentToModel: true,
  trials: trials.map(({ memory, ...item }) => ({ ...item, memoryCount: memory.length })),
});
let index = 0;
let completed = 0;
let cost = 0;
let aborted = false;
async function worker() {
  while (!aborted && index < trials.length) {
    const trial = trials[index++];
    if (!trial) break;
    const cwd = mkdtempSync(join(tmpdir(), "mentat-expanded-diag-"));
    const memoryPath = join(cwd, "memory.json");
    write(memoryPath, trial.memory);
    const metrics = join(out, `${trial.id}.usage.jsonl`);
    const adapter = createAcpAdapter({
      binary: process.execPath,
      baseArgs: [fileURLToPath(new URL("./acp-observer.mjs", import.meta.url))],
      env: {
        MENTAT_OPENCODE_BIN: "/opt/homebrew/bin/opencode",
        MENTAT_EXPERIMENT_METRICS: metrics,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model,
          small_model: model,
          autoupdate: false,
          share: "disabled",
          permission: acpPermission("C"),
          instructions: [],
          plugin: [],
        }),
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_DIR: join(cwd, "opencode-config"),
      },
    });
    const session = await adapter.createSession(
      { cwd, model, ...assistantPromptOptions(adapter), mcpServers: [memoryMcpSpec(memoryPath)] },
      {
        onPermission: {
          request: (request) =>
            /^(?:mcp__memory__|memory_)?memory_(?:search|add)$/.test(request.toolName)
              ? "allow"
              : "deny",
        },
      },
    );
    const snapshot = buildTurnContext(new JsonFileMemoryStore(memoryPath), trial.input);
    let first: Awaited<ReturnType<typeof sendTurn>>;
    try {
      const wrapped = {
        id: session.id,
        subscribe: session.subscribe.bind(session),
        send: (input: { text: string }) =>
          session.send({ text: input.text, context: taskContext(memoryPath, input.text) }),
        interrupt: session.interrupt.bind(session),
        dispose: session.dispose.bind(session),
      };
      first = await sendTurn(wrapped, trial.input, 90000);
    } finally {
      await session.dispose();
    }
    const native = readFileSync(metrics, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const costs = new Map<string, number>();
    for (const row of native)
      if (row.type === "acpUsage" && row.cost?.currency === "USD")
        costs.set(row.wireSessionId, row.cost.amount);
    const observedCostUsd = [...costs.values()].reduce((a, b) => a + b, 0);
    cost += observedCostUsd;
    const result = {
      ...trial,
      memory: undefined,
      memoryBefore: trial.memory,
      context: snapshot,
      first,
      nativeModels: native.filter((row) => row.type === "model"),
      nativeAcpUsage: native.filter((row) => row.type === "acpUsage"),
      observedCostUsd,
    };
    write(join(out, `${trial.id}.json`), result);
    appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
    completed += 1;
    console.log(`${completed}/10 ${trial.id} cost=${cost.toFixed(4)}`);
    if (first.reason !== "done" || cost >= 0.1) aborted = true;
  }
}
console.log(`Output: ${out}`);
await Promise.all([worker(), worker()]);
write(join(out, "summary.json"), {
  status: aborted ? "incomplete" : "completed-unscored",
  completed,
  calls: completed,
  observedCostUsd: cost,
});
if (aborted) process.exitCode = 1;
