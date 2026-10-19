# 评测资产

统一入口：`pnpm bench help`。设计、公开集选型、社区框架调研、接入协议和结果解释见 [评测框架](../docs/benchmark-framework.md)。

- `examples/episodes.json`：两条合成任务序列，验证新会话、显式类型确认及跨任务状态边界。
- `examples/native-plan.json`：两组八任务的 fake 冒烟计划。检查回显和框架连通性，不检查学习效果。
- `examples/harbor-*.json`：Harbor 单步 TrialResult 相关字段的合成契约样本与导入计划。
- `examples/inspect-*.json`：Inspect EvalLog JSON 相关字段的合成契约样本与导入计划。

这些均为 `smoke` 轨道，不是上游数据集、完整上游 schema 实例或公开 benchmark 成绩。`native-plan` 的零代码指纹是模板字段，原生运行时会替换为实际 checkout 指纹；导入示例保留 fixture 身份。数据摘要对应 `episodes.json` 的实际字节，编辑或格式化数据后须更新计划摘要。

```bash
pnpm test:benchmarks
pnpm bench:smoke
```

冒烟目录位于 `.mentat/benchmarks/`，包括完整 host 轨迹、记忆前后快照、逐样本结果、报告、比较和趋势 CSV；不提交生成的运行材料。付费模型、外部框架和公开数据下载不在冒烟中执行。

`pilots/2026-10-16/` 保存首次真实模型试点的冻结纵向输入、计划、精简结果和非盲复核记录；公开原始语料与完整运行材料仍保存在本机忽略目录。生成与分析脚本分别为 `scripts/prepare-unified-pilot.py`、`scripts/analyze-unified-pilot.py`。协议、边界与结论见[统一评测报告](../docs/research/unified-evaluation-2026-10-16.md)。

## 目录边界（代码管理）

评测相关代码分散在四处，职责固定，不要互相搬：

| 位置 | 职责 |
|---|---|
| `packages/benchmark` | **纯契约**：计划、任务单元、配对分析、`BENCHMARK_CATALOG`、`BridgeRegistry`（见 ADR-0005） |
| `packages/benchmark-file` | 运行文件、外部执行、结果适配器、报告 |
| `benchmarks/` | 评测**资产与桥**：`public/`（上游运行器与结果）、`examples/`、`pilots/`、`past-bench/`、`rsi-exam/` |
| `scripts/` | 薄入口与公开评测运行器（`public-*.ts`、`past-bench-agent.ts`、`*.py`）；由根 `tsconfig` 纳入类型检查 |
| `experiments/` | 学习实验（个人助理连续任务），带独立 tsconfig |

Python 依赖见 `benchmarks/requirements.txt`（venv 固定为 `.mentat/venvs/public`）。生成的运行材料写入忽略目录 `.mentat/`，不提交。
