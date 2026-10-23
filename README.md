# Mentat

Mentat 是一个自迭代 agent 框架试验台。它通过 Pi / OpenCode 等引擎执行任务，管理上下文、记忆、流程知识和执行轨迹，并通过提案、门控、评测、选择和归档验证修改。

## 安装与快速开始

需要 Node.js >=22、pnpm 11.26.0。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev help
pnpm dev harness list

# 不调用模型，先验证本地启动链路
pnpm dev run "整理今天的任务" --harness fake
```

`fake` 是确定性假引擎，只验证流程，不会实际完成专业任务。

使用真实模型时，先安装并授权对应引擎。以下使用本项目已验证的 OpenCode 模型；模型是否可用以本机 `opencode models` 为准：

```bash
opencode auth login
opencode models

pnpm dev run "检查这个项目并列出待办" \
  --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /absolute/path/to/project --permission ask --timeout-ms 600000

pnpm dev chat --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /absolute/path/to/project --permission ask --timeout-ms 600000
```

`pnpm dev` 从仓库运行 CLI；在其他目录可使用 `/absolute/path/to/mentat/mentat` 启动器，不要求安装全局 `mentat` 命令。显式指定 `--cwd` 决定任务目录和默认记忆、经验、轨迹位置。

## 使用说明

完整步骤、参数、数据位置和排查方法见 [使用指南](docs/usage.md)：

- [单次任务、多轮聊天与参数](docs/usage.md#执行任务与聊天)
- [记忆确认、反思、历史召回与流程知识](docs/usage.md#记忆反思与流程知识)
- [查看日志与判断完成状态](docs/usage.md#日志与结果判断)
- [代码演化与记忆演化](docs/usage.md#代码演化与记忆演化)
- [统一评测与常见问题](docs/usage.md#统一评测)
- [受限批处理任务与结果验收](docs/worker-execution.md)

默认值有所不同：`run` 使用 `fake` / `auto`，`chat` 使用 `pi` / `full`。示例显式传入引擎和 `ask`，避免依赖默认值。`ask` 对经过宿主权限处理器的请求逐次询问；引擎原生工具还受其自身权限配置控制。

## 当前结构与验证

当前有 **24 个功能包**。协议与纯领域规则、会话执行、宿主装配、记忆与流程知识、文件存储、可观测性、演化、评测及引擎适配分别维护。完整职责与依赖见 [子包规则](docs/dev-rules/layering.md)，当前修复与能力边界见 [架构评审](docs/architecture-review.md)。

```bash
pnpm check             # 分层、类型、行为、实验、Python 审计和格式检查
pnpm test:benchmarks   # 统一评测框架回归
pnpm bench:smoke       # fake 连通性冒烟，不产生真实模型成绩
```

2026-10-21 在提交 `277a1bd` 前完成完整检查：376 项 Vitest 测试通过、1 项跳过，PAST Python 审计 18 项、SWE Python 审计 11 项通过。Docker 实机测试按显式开关默认跳过。

SWE-bench Pro V2 已完成开发样本接入：两个 Python 样本通过独立重评；NodeBB 在单独的 VZ/Rosetta 环境中通过独立重评。环境与源码快照不同，分别报告，不合并为同批次成绩，也不据此宣称 RSI 提升。操作入口见 [SWE 接入说明](benchmarks/swe-bench/README.md)，结果见 [首轮报告](docs/research/swe-bench-pro-v2-pilot-2026-10-21.md) 和 [NodeBB 复验](docs/research/nodebb-swe-bench-validation-2026-10-21.md)。

## 进一步阅读

- [上下文、记忆与确认策略](docs/prompt-context.md)
- [执行与可观测性](docs/refactor-execution-observability.md)
- [多维度评测框架](docs/benchmark-framework.md)
- [记忆专项优化清单](docs/research/memory-optimization-backlog.md)
- [设计计划](docs/plan.md)（包含历史规划，以当前实现说明为准）
