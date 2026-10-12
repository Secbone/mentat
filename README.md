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
| `@mentat/core` | kernel、artifact 契约、`AgentEvent`、自迭代 loop、eval、archive |
| `@mentat/transport-pi` | Pi 原生 RPC 适配器（`pi --mode rpc`）+ 权限 bridge 扩展 |
| `@mentat/iterate` | 真件：`GitWorkspace`、`AgentProposer`、命令门与评测器 |
| `@mentat/cli` | CLI（bin: `mentat`） |

## 引擎接入

```bash
mentat harness list                                   # 列出可用引擎与能力
mentat run "补全测试" --harness pi --permission ask    # 用 Pi，工具调用逐次审批
mentat run "..." --harness fake                        # 无依赖的假引擎
```

引擎适配器必须通过 `@mentat/core/testing` 的共享契约测试（`describeHarnessContract`）；
新增引擎只要实现 `HarnessAdapter` 并跑通它即可。

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

> 状态：M0–M2 完成；M5 真件完成（`GitWorkspace`/`AgentProposer`/命令门与评测器 + `mentat iterate`）。
> 下一步：记忆/模型层（M3）、多信号评测 harness 与容器 runner（M4）。
