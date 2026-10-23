# 受限文件任务与结果验收

run 可以选择执行文件权限策略、结构化输出验收，或同时启用两者。它们不改变普通 run/chat 的默认权限，也不向通用助手策略添加商品规则。

## 最小用法

为每个任务准备一个独立的小目录，输入文件已存在，输出文件尚不存在。策略和验收配置放在任务目录之外。例如：

```text
/work/batch/task-001/
  input.txt
/work/batch/policy.json
/work/batch/output-contract.json
```

`policy.json`：

```json
{
  "kind": "file-allowlist",
  "readFiles": ["input.txt"],
  "writeFiles": ["result.json"]
}
```

`output-contract.json`：

```json
{
  "outputFile": "result.json",
  "schema": {
    "type": "object",
    "required": ["answer"],
    "properties": { "answer": { "type": "string", "minLength": 1 } },
    "additionalProperties": false
  }
}
```

在 Mentat 仓库执行：

```bash
pnpm dev run '读取 input.txt，将实际内容写入 result.json 的 answer 字段。' \
  --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /work/batch/task-001 \
  --execution-policy /work/batch/policy.json \
  --output-contract /work/batch/output-contract.json \
  --timeout-ms 180000 --log-protocol
```

路径须替换为本机真实路径。模型仍需从用户任务或只读说明文件获知结果要求；验收器与预期值不会自动注入提示词。

## 权限与输入审计

目前只有 OpenCode V2 适配器声明支持 `file-allowlist`；Pi、通用 ACP 和 fake 收到该策略时拒绝启动，不静默降级。OpenCode 使用原生默认 deny，再精确允许输入 read、输出 edit（包含 write/patch）；现有主 agent 的宽泛权限会被替换。原生配置规则依据 [OpenCode V2 权限说明](https://dev.opencode.ai/v2/docs/permissions/)。

- 路径是具体文件，不支持 `*`、`?` 或目录通配。输入与输出不能重叠，输出父目录必须已存在。
- 任务根路径先规范化；目录内部拒绝符号链接、硬链接和特殊文件，策略拒绝工作目录外路径。CLI 为每轮使用全新输出，已有输出会在模型启动前报错。
- 运行前后递归检查目录。已有文件被修改/删除，出现未声明的新文件或目录，均不能验收通过。
- 当前审计上限为 10000 个目录条目、64 MiB 文件总量；输出 JSON 上限 8 MiB。大项目代码修改不适用这种小任务目录模式，应继续使用原来的代码任务流程。

这是原生工具权限与最终文件状态校验，不是 OS 进程沙箱。前后摘要一致不能证明中途没有改写又恢复，不能代替面对恶意执行代码的系统级隔离。

CLI 打印 `control: <目录>` 和 `trace: <目录>`。受限 run 自动将日志、经验、空记忆文件、冻结契约和验收快照放在任务目录之外；不要同时传入 `--memory`、`--experience` 或 `--log-dir`。控制目录使用系统临时位置，需长期留存时在任务结束后自行归档整个 control 目录。

该模式禁用记忆工具、流程知识工具、历史召回与反思，拒绝混用 `--skills`、`--remember-*`、`--reflect*` 或非零 `--recall-chars`。shell、联网、子 agent、MCP 等未声明动作由原生默认拒绝规则限制。模型无法读回只写输出属于预期行为，结果由宿主独立检查。

## 业务验收程序

Schema 验证使用 Ajv 8 的 JSON Schema 2020-12 模式，严格检查，不转换类型、不补默认值、不删除字段。不支持远程加载 schema、异步 schema 或隐式格式插件。仅 Schema 通过时报告 `coverage=json-schema-only`，不能据此声称证据内容、事实或业务语义正确。

也可以只传 `--output-contract` 为普通 run 增加结果验收，但这不会限制模型工具或冻结输入目录。需要执行权限隔离时应同时提供 `--execution-policy`；验收程序和配置始终由可信宿主管理。

调用项目可在契约中添加可信验收程序：

```json
{
  "outputFile": "result.json",
  "schema": {
    "type": "object",
    "required": ["answer"],
    "properties": { "answer": { "type": "string", "minLength": 1 } }
  },
  "validator": {
    "command": "/absolute/path/to/python",
    "args": ["/absolute/path/to/host-owned-validator.py"],
    "timeoutMs": 20000
  }
}
```

程序应位于任务目录之外，由可信宿主管理，不是模型生成的待执行脚本。模型结果不拼接进 shell 命令；宿主直接启动 command/args，并将只读 JSON 快照的绝对路径追加为最后一个参数。程序的工作目录是 control 目录，脚本、数据依赖请使用绝对路径。

快照形状：

```json
{
  "schemaVersion": 1,
  "outputFile": "/work/batch/task-001/result.json",
  "outputSha256": "sha256-of-original-output",
  "value": { "answer": "模型输出内容" }
}
```

程序必须以 0 退出，并在 stdout 输出完整 JSON：

```json
{ "accepted": true, "issues": [] }
```

业务拒绝应返回 `{"accepted":false,"issues":["具体原因"]}`；退出码为 0 却没有合法结论也属于验收错误。非零退出、超时、取消、坏 JSON 不会被当作接受。stdout/stderr、返回码、契约摘要、输出摘要和目录审计报告留在证据中。验收后还会核对结果文件与输入目录，检查验收期间是否改变。

商品 ID/字段覆盖、重复字段、证据 SHA/原文锚点、单位换算、属性角色等均由商品项目的 validator 实现，不加入 Mentat 核心。Schema 与 validator 不会替调用方建立人工金标或证明领域准确率。

## 状态与退出码

执行状态与验收状态分开保存：

| 字段 | 解释 |
| --- | --- |
| `result.reason`、`termination` | 原始执行结果，不被验收改写 |
| `completion.verification` | 会话层仍为 unverified，不能替代外部验收 |
| `acceptance.status=accepted` | 声明的 Schema/验收程序通过，覆盖范围见 evidence.coverage |
| `rejected` | 目录审计、Schema 或业务条件未通过 |
| `error` | 验收程序、文件读取、超时或契约执行异常 |
| `not-evaluated` | 只启用权限策略且审计通过，没有配置结果契约 |

启用验收时，接受返回 CLI 0，拒绝/验收错误返回 2；只有权限策略、没有结果契约时，CLI 仍按执行状态返回。启动或配置错误返回 1。普通 run 的原有退出码语义不变。

预算截断的部分输出可以独立验收；执行 error/aborted 不能被验收器升级为 accepted。验收失败只留存结果，不自动合并业务数据，不追加模型重试，不重放工具。

日志中的 `task.acceptance.start`、`task.acceptance` 与 turn ID 关联；验收结论进入经验记录和反思元数据，仍不能作为用户长期偏好的确认依据。

## Host API

API 调用方通过 `HostConfig.executionPolicy` 传递文件策略；使用 `HostOverrides.resultEvaluator` 注入可信业务验证器：

```ts
const host = createAssistantHost(config, {
  resultEvaluator: {
    id: "my-domain-v1",
    timeoutMs: 30000,
    async evaluate({ input, result, signal }) {
      // 独立读取/验证交付物；遵守取消信号，不重放模型动作。
      return { status: "rejected", issues: ["尚未实现业务检查"] };
    },
  },
});
const { result, record, acceptance } = await host.turn(session, task);
```

受限 API 调用必须显式把 logDir、experienceDir 和可选 memoryPath 放在任务目录之外；使用空的记忆仓库，不注入历史。文件审计与标准输出契约可复用 `@mentat/evaluation` 的 `prepareFilePolicy`、`prepareOutputContract`。注入的 JS 验收器是可信代码，超时取消只能中断等待并发出 signal，不能强制终止忽略 signal 的回调；CLI 外部程序则复用进程组超时清理。

本次没有新增通用并发调度器或自动续跑。调用方可按一个商品/任务一个目录组织 checkpoint，仅在验收通过后合并；重试应创建新目录并保留旧证据。作为 ACP 服务端供其他工具调用是独立后续工作，当前仍通过 CLI/Host API 使用这些能力。

回归与两次真实 DeepSeek 探针见 [验证报告](research/worker-contract-validation-2026-10-21.md)。
