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

> 状态：M0–M2 完成；M5 真件完成（`GitWorkspace`/`AgentProposer`/命令门与评测器 + `mentat iterate`）。
> 下一步：记忆/模型层（M3）、多信号评测 harness 与容器 runner（M4）。
