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
| `@mentat/cli` | CLI（bin: `mentat`） |

> 状态：M1 开发中（core 抽象 + FakeAdapter + CLI 骨架）。
