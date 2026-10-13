# Mentat

> A self-iterating agent framework. 想到，就能改到。

Mentat 是一个**自迭代 agent 框架**试验台：记忆、工具、skill、模型、prompt、
策略、适配器、核心代码、乃至自迭代管线本身，都是可被 agent 修改的**制品**
(artifact)，由统一的迭代闭环（observe → propose → gate → evaluate → select →
archive）驱动，并用多信号客观指标验证「变好了」。

多引擎（Pi / opencode）只是"手脚"（substrate）；真正的目标是实践 agent 框架的
自迭代。

设计动机与完整计划见 [`docs/plan.md`](docs/plan.md)。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm dev harness list
```

## 包结构

| 包 | 职责 |
|---|---|
| `@mentat/core` | 纯引擎：kernel、artifact 契约、`AgentEvent`、自迭代 loop、eval、archive、model（零 workspace 依赖、无 `node:`） |
| `@mentat/memory` | 记忆域：store、memory artifact、离线演化、experience、reflection、memory MCP server |
| `@mentat/runtime` | 引擎无关的执行件：`GitWorkspace`、data workspace、命令门、评测器、proposer、tracer |
| `@mentat/transport-pi` | Pi 原生 RPC 适配器（`pi --mode rpc`）+ 权限 bridge 扩展 |
| `@mentat/transport-acp` | 通用 ACP 适配器（opencode 及未来 claude/codex） |
| `@mentat/cli` | CLI（bin: `mentat`），负责装配 |

分层规则与依赖方向见 [`docs/dev-rules/layering.md`](docs/dev-rules/layering.md)，
由 `pnpm check:layering` 校验；workspace 别名由 `pnpm gen` 从各包 `package.json`
的 `exports` 单一来源生成。

## 引擎接入

```bash
mentat harness list                                   # 列出可用引擎与能力
mentat run "补全测试" --harness pi --permission ask    # 用 Pi，工具调用逐次审批
mentat run "..." --harness fake                        # 无依赖的假引擎
```

引擎适配器必须通过 `@mentat/core/testing` 的共享契约测试（`describeHarnessContract`）；
新增引擎只要实现 `HarnessAdapter`、跑通它，并在 `packages/cli/src/lib/registry.ts` 注册即可。
通用 ACP 引擎为可选：设置 `MENTAT_ACP_BIN`（如某个 opencode 构建）后 `--harness acp` 可用，
`MENTAT_ACP_ARGS` 覆盖默认参数 `acp`。

## 自迭代

```bash
mentat loop demo                                       # 确定性闭环演示
mentat iterate --target <git-repo> --task "<goal>" \
  --check "pnpm typecheck && pnpm test" \
  --harness pi --model opencode-go/deepseek-v4.1-flash  # 真件闭环（agent 改代码）
```

`iterate` 在隔离的 git repo 上：agent 编辑代码 → 提交为候选 → 门（protected 路径 + check）
→ 评测信号 → Pareto 保留/回滚 → 写入 archive。Pi 会复用 opencode 的凭据（`OPENCODE_API_KEY`
或 `~/.local/share/opencode/auth.json`）。

## 执行日志

每次 `iterate` 都会落盘一份可观测的执行轨迹到 `.mentat/runs/<runId>/`：

- `trace.jsonl` — 结构化事件流：`run.start` → `agent.prompt` → 每个 `agent.event`
  （工具调用/结果、消息、usage）→ `iteration.propose/apply/gate/select` → `loop.end` → `run.end`。
- `run.json` — 本次运行摘要（目标、模型、每个 iteration 的门/信号/是否保留、best）。
- `iter-<n>.diff` — 每个候选相对父提交的 unified diff。

回看：

```bash
mentat trace            # 最近一次运行的轨迹（默认折叠 token 级 delta）
mentat trace <run-dir>  # 指定运行目录
mentat trace --all      # 含 token 级 delta
mentat trace --raw      # 原始 JSONL
```

这份轨迹就是"用日志驱动自迭代"的原料：agent 的 `proposer` 会拿到 `--log-dir`，
可读取历史运行记录来决定下一轮改什么。

## 边干活边进化（在线）

`mentat run` 现在的一趟任务会**读记忆 → 干活 → 写记忆**：

- **任务前**：从 `.mentat/memory.json` 检索相关记忆，注入 system prompt；
  同时挂载**记忆 MCP server**（`@mentat/memory` 的 `memory_search`/`memory_add`），
  agent 可按需读写。
- **任务后**：把本次运行落盘为经验（`.mentat/experience/*.jsonl`：outcome/usage/tools），
  并可选写入记忆。

```bash
mentat run "<task>" --harness pi --model <id> --permission full \
  --remember "the api base url is /v1"   # 规则写入（去重）
mentat run "<task>" --reflect            # 任务后让 agent 蒸馏可复用记忆
```

在线只写**数据**（记忆），过 schema 门 + 去重、可 forget；**代码变更仍只走离线 loop**。

## 交互使用

一次性任务用 `run`，多轮对话用 `chat`（REPL，带记忆工具）：

```bash
# 从仓库内运行（pnpm dev 等价）
pnpm dev chat --harness pi --model opencode-go/deepseek-v4.1-flash --cwd ~/my-project
# 或使用便捷启动器（可把它加进 PATH 或 alias）
./mentat chat --harness pi --model opencode-go/deepseek-v4.1-flash --cwd ~/my-project
```

chat 里支持：`/remember <fact>`（写记忆）、`/reflect`（蒸馏本次对话的可复用记忆）、
`/exit`。`chat` 复用与你 opencode 相同的模型（自动读取 `OPENCODE_API_KEY`）。

只想跑一趟任务：

```bash
./mentat run "帮我重构这个函数并跑测试" --harness pi --cwd ~/my-project --permission full
```

> 状态：M0–M6 完成；M7（ACP/opencode 适配器）由 agent 自迭代实现并合并；
> 在线"边干活边进化" P1–P4 完成（持久记忆 + systemPrompt/MCP 注入、经验落盘、
> `--remember`、`--reflect`）。下一步：离线 loop 消费 `ExperienceStore`。
