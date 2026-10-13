# Mentat — 自迭代 Agent 框架 · 实施计划 v1.0

> 状态：work in progress
> 北极星：实践 agent 框架的**自迭代**。
> 衡量成功的不是功能多少，而是系统能否在完成任务的过程中，安全地改进自己的
> 记忆 / 工具 / skill / 模型 / prompt / 策略 / 适配器 / 核心 / 迭代管线，
> 并用客观信号证明「变好了」。

---

## 0. 定位

Mentat 不是「又一个 Cindy」。它是一个**自迭代试验台**：

- **迭代对象 = 框架的全部**，而不只是"多引擎接入"。记忆、工具、skill、模型、
  prompt、策略、适配器、核心代码、乃至自迭代管线本身，都是可被 agent 修改的制品。
- **多引擎（Pi / opencode / …）只是"手脚"（substrate）**：让 agent 有执行与改代码的能力，
  并为「改动能否跨引擎泛化」提供实验维度。
- 首要交付物是一条**被客观指标证实的自迭代轨迹**，而不是一个功能齐全的产品。

参考范式：**Darwin Gödel Machine (DGM)**（Sakana AI / UBC，arXiv:2505.22954，ICLR 2026）
——自我修改 + 经验验证（而非形式证明）+ archive/open-ended 搜索 + 分级评测 + 沙箱与人类监督。

---

## 1. 核心抽象：一切皆「可迭代制品」(Iterable Artifact)

用统一契约让**同一条迭代管线**适用于所有对象。

```ts
type ArtifactKind =
  | "prompt" | "tool" | "skill" | "memory"
  | "model" | "policy" | "adapter" | "core" | "pipeline";

interface IterableArtifact {
  kind: ArtifactKind;
  id: string;
  version: string;                 // content-addressed + git commit
  form: "code" | "data";           // 决定变更通道
  apply(rt: Runtime): Disposable;  // 装进运行时
  snapshot(): JsonValue;           // 归档 / 迁移
  evalSpec(): EvalSpec;            // 如何评测这个制品
}
```

两种变更通道：

- **code 制品**（tool / policy / adapter / core / pipeline）：沙箱内改源码 →
  **热重载**（cordis 风格 kernel + per-session scope）。
- **data 制品**（memory / skill / model / prompt）：版本化存储里改数据 →
  快照替换，无需重编译。

---

## 2. 架构

```
┌──────────────────────── mentat: 自迭代试验台 ────────────────────────┐
│                                                                      │
│  ② 制品注册表 (code + data, git 支撑)                                 │
│        │                                                             │
│  ③ 自迭代引擎 (observe→propose→gate→evaluate→select→archive)          │
│        │                                                             │
│  ④ 评测 harness (多信号指标 + 任务集 + 容器 runner)                    │
│  ⑤ 归档/谱系 (archive, DGM 式垫脚石)                                  │
│        │                                                             │
│  ① 运行时内核 (cordis 风格插件核心 + 热重载 + per-session scope)        │
│        ├── 记忆子系统(自迭代)   ├── 模型层(routing/catalog 自迭代)      │
│        └── 工具 / skill / policy / adapter 都是插件                    │
│                                                                      │
│  安全门: 审批(ask/auto/full) · 版本化+回滚 · 测试后激活 · 沙箱          │
│                                                                      │
│  底座(substrate): Pi RPC(默认) + ACP(opencode) —— agent 的手脚         │
└──────────────────────────────────────────────────────────────────────┘
   + 薄层 HTTP/SSE server（可观测 + 未来 GUI）
```

### 包结构

| 包 | 职责 |
|---|---|
| `@mentat/core` | kernel、artifact 契约、`AgentEvent`、自迭代 loop、eval、archive、memory、model；零引擎依赖 |
| `@mentat/transport-pi` | Pi 原生 RPC adapter（`pi --mode rpc`）+ 注入的 bridge 扩展（权限门控） |
| `@mentat/transport-acp` | 通用 ACP client（opencode 及未来 claude/codex） |
| `@mentat/server` | 薄层 HTTP + SSE（基于可观察状态，供未来 GUI/远程） |
| `@mentat/cli` | CLI（bin: `mentat`） |
| `@mentat/shared` | 共享类型/工具 |

依赖方向：`cli → transport-* / server → core`；`core` 不依赖任何 adapter（注册表反向注入）。

---

## 3. 自迭代循环（双时间尺度）

用户要求「在完成不同任务的过程中不断自我学习」，因此分两拍：

### 在线（每任务级，轻量）
1. 跑真实任务 → 采集轨迹与多信号反馈
2. 记忆即时更新（curated / digest），小的 prompt / skill 提案入队
3. 不打断任务流

### 离线（批次级，DGM 式）
```
Observe(评测日志/在线信号)
  → Propose(agent 分析后提出改哪个制品)
  → Materialize(写 code 分支 或 data 版本)
  → Static gate(typecheck / lint, 沙箱)
  → Test gate(单测 / 契约测试；分级: 先证明能自我编辑，再扩大)
  → Approval gate(ask/auto/full；高风险升级人工)
  → Evaluate(容器内跑 benchmark，多信号)
  → Select(Pareto: 变好才保留，否则回滚)
  → Archive(存变体 + 谱系 + 提案 + 指标；更新父代选择权重)
  → Repeat / 从垫脚石分支(open-ended)
```

**元指标**：自我改进能力 = 修改任务成功率 + 下游任务表现。

---

## 4. 多信号反馈模型

不追求单一标量（会 reward hacking），用 **Pareto 前沿 + 多目标**：

| 信号维度 | 例子 |
|---|---|
| 任务成功 | pass rate / 完成率 |
| 成本 | tokens、$、延迟 |
| 工具效率 | 步数、重试、循环检测命中 |
| 记忆效用 | 召回精度、记忆是否真的帮上忙 |
| 人类/模型反馈 | 显式纠正、满意度 |
| 回归 | 既有能力不退化 |
| 自我改进 | 改动是否编译 / 测试通过 / 带来提升 |

Archive 保留**非支配的多样变体**（开放探索），而非只留最高分。

---

## 5. 迭代对象矩阵

| 制品 | 形式 | 变更通道 | 审批重点 | 主要信号 |
|---|---|---|---|---|
| prompt | data | 版本替换 | 轻 | 行为 / 质量 |
| skill | data(包) | 版本替换 | 中 | 任务成功 |
| memory | data | 增删改 / 遗忘 | **删除需人工** | 召回效用、反馈 |
| model | data(routing/catalog) | 版本替换 | **成本敏感, 人工** | 成本 / 延迟 / 质量 / cache |
| tool | code | 热重载 | 测试 + 审批 | 成功、工具效率 |
| policy | code | 热重载 | **严格** | 安全、零误放 |
| adapter | code | 热重载 | 测试 | 引擎一致性 |
| core | code | 容器内重建 / 重启 | **严格人工** | 回归套件 |
| pipeline | code | 受保护，初期不可自改 | 仅人工 | 元指标 |

---

## 6. 安全与可控性

因涉及 core / pipeline 自改，且默认"尽量无人"：

- **自我保护底线**：安全门与自迭代管线设为**受保护核心**，初期 agent **不可自行修改**
  （DGM 亦将 archive / 父代选择设为不可改）。L3（改管线本身）作为后续独立实验开放。
- **升级人工的触发点**：触及安全门、模型 / 凭证、删除记忆、网络访问、core、pipeline。
- **默认自主**：低风险制品（prompt / skill / tool / memory 增改）自动走完闭环；风险项才提醒。
- 评测一律在**容器**里跑（网络受限，DGM 同款）；运行时先 allowlist（如实说明非强隔离）。
- git 谱系 = 审计与回滚；另加**预算 / 速率上限**防失控循环。

---

## 7. 里程碑（实验驱动）

| 阶段 | 交付 | 验收（可测） |
|---|---|---|
| M0 | pnpm 骨架、tsup、biome、vitest、CI | 全绿 |
| M1 | kernel + `IterableArtifact` + `AgentEvent` + FakeAdapter + 契约测试 + CLI 骨架 | 假 adapter 跑通 CLI |
| M2 | Pi RPC adapter + 流式 CLI + 权限桥(ask/auto/full) | 真实 Pi 完成 + 可中断 |
| M3 | 记忆子系统 + 模型层（均自迭代） | 记忆可增删改并影响行为 |
| M4 | 评测 harness + 容器 runner + 多信号指标 | 一个任务集产出稳定分数 |
| M5 | 自迭代循环 + git 谱系（先 hill-climb） | **出现一条可复现的"改进轨迹"** |
| M6 | open-ended archive + 父代选择 + 垫脚石 | 归档保留多样变体并可分支 |
| M7 | ACP adapter + opencode | 两引擎跑通；可做跨引擎泛化实验 |
| M8 | L2/L3 实验（core/pipeline 自改，严格监督） | 受控下通过回归门 |
| M9 | 薄层 server + 可观测面板 | 能看谱系 / 指标 / 门状态 |

**v1 的真正交付物**：一个能跑的试验台 + **第一条被客观指标证实的自迭代轨迹**。

---

## 8. 待验证的研究假设

1. 自我修改（含记忆 / skill / 工具）能否传导为下游任务表现提升？
2. 哪类制品的自迭代 ROI 最高？
3. 多信号 Pareto vs 单标量，是否更能避免 reward hacking？
4. open-ended archive 是否优于 hill-climbing（是否出现"垫脚石"）？
5. 改进能否跨 harness 泛化（Pi → opencode）？
6. 安全约束能在多大程度上不牺牲改进能力？

---

## 9. 主要风险

- **目标被 game**（多信号 + 容器 + 人工审批）
- **安全门被自改**（把门设为受保护核心）
- Node 无原生沙箱（评测进容器；运行时 allowlist，不夸大）
- 热重载正确性 / 内存泄漏（在途安全 → 未来可评估 chord）
- 跨版本的状态 / 上下文迁移
- 插件运行时过度设计

---

## 10. 已确定的决策

| 决策 | 结论 |
|---|---|
| 目标 | 实践 agent 框架自迭代（最高优先级） |
| 技术栈 | TypeScript + Node |
| 形态 | CLI + 可嵌入核心；v1 加薄层 HTTP/SSE server |
| 仓库 | pnpm monorepo（core + transport + cli） |
| 协议策略 | 双层：Pi 原生 RPC（默认） + ACP 通用（opencode 及未来） |
| 权限 | ask / auto / full 三档 |
| 迭代层次 | L0–L3 全覆盖（L3 初期受保护） |
| 自主度 | 尽量无人，需要时人工审批 |
| 搜索策略 | DGM 式 archive + 垫脚石 |
| 沙箱 | 先 allowlist，评测在容器内 |
| 底座 | Pi + opencode |
| 插件核心 | 自建 cordis 风格极简核心；cordis/chord 列为 v2 候选 |
| 迭代对象 | 记忆 / 工具 / skill / 模型 / prompt / 策略 / 适配器 / core / pipeline 全覆盖 |

---

## 11. 进度

- **M0** 完成：pnpm monorepo（`@mentat/core`、`@mentat/cli`），tsc/biome/vitest。
- **M1** 完成：`AgentEvent` 统一事件流、`HarnessAdapter` 接入缝、`IterableArtifact` 契约、
  cordis 风格 kernel、FakeAdapter、共享 harness 契约测试套件。
- **M2** 完成：`@mentat/transport-pi`（`pi --mode rpc` + 事件翻译 + bridge 扩展），
  CLI 支持 `--harness pi` 与 ask/auto/full 权限三档。
- **M5 骨架** 完成（用假件跑通闭环，真件待接）：
  - `loop/`：`SelfIterationLoop`（observe→propose→materialize→gate→evaluate→select→archive）、
    `Workspace`/`InMemoryWorkspace`、`Proposer`/`ScriptedProposer`、`Evaluator`/`FunctionEvaluator`、
    `Gate`/`GateChain`、`Archive`（谱系 + DGM 式父代选择）、Pareto `dominates`。
  - 保护机制：`protected` artifact 不可被修改（安全门/管线）。
  - 可观察：`mentat loop demo` 打印 accept/rollback/archive 轨迹。
- **M5 真件** 完成：`@mentat/iterate` 提供 `GitWorkspace`（commit=候选、reset=回滚、
  `changedFiles`）、`AgentProposer`（把任意 session runner 变成 proposer）、`commandGate`、
  `CheckEvaluator`/`JsonCommandEvaluator`；`mentat iterate` 串起真闭环。
  Pi 自动复用 opencode 凭据（`OPENCODE_API_KEY` 或 opencode auth.json）。
  实测：Pi（`opencode-go/deepseek-v4.1-flash`）在隔离 git repo 上改代码 → 提交 → 门 → 评测 →
  accept，产出可回滚的候选提交。

- **可观测性** 完成：`@mentat/core` 的 `Tracer`（循环每步发出结构化事件），
  `@mentat/iterate` 的 `JsonlTracer`；`mentat iterate` 把每次运行落盘到
  `.mentat/runs/<runId>/`（`trace.jsonl` 事件流 + `run.json` 摘要 + `iter-<n>.diff`），
  `mentat trace` 回看。这是"用日志驱动自迭代"的原料。

- **M6** 完成：`LoopConfig.parentSelection: "current" | "archive"`，archive 模式下
  `SelfIterationLoop` 用 `Archive.selectParent()` 采样父代并经 `Workspace.checkout()` 分支，
  实现 DGM 式 open-ended 探索（垫脚石可再分支）。
- **M3** 完成（`@mentat/core`）：`MemoryStore`/`InMemoryMemoryStore`（关键词召回、标签过滤、
  遗忘）+ `memoryArtifact`（data 制品，可被循环迭代）；`ModelCatalog`（按上下文/成本/供应商
  选择）+ `modelCatalogArtifact`。
- **M4** 完成：`TaskSuite` 抽象；`@mentat/iterate` 的 `ContainerRunner`（Docker：`--rm`、
  挂载 workdir、默认 `--network none`）+ `containerGate`/`ContainerEvaluator` + `dockerRunArgs`
  纯构造器。真实 Docker（alpine:3）集成测试通过（默认跳过，`MENTAT_DOCKER=1` 启用）。
- **M7** 完成：`@mentat/transport-acp`（ACP 客户端），由 agent 在**冻结契约测试 + 保护路径**
  下自迭代实现（见下）。
- **M9** 暂缓（用户决定）。
- **数据制品离线演化** 完成：`SelfIterationLoop` 本就能演化任意 `IterableArtifact`。
  - `core/memory`：`recallTask`（held-out 查询的 recall/noise 双信号）、`RuleMemoryProposer`
    （规则变异：去重追加）、`memoryGate`（schema/类型/重复 id 校验）。
  - `iterate`：`JsonStoreWorkspace`（数据制品的版本化持久化 + 回滚 + `load` 恢复）、
    `AgentDataProposer`（agent 输出 JSON → 制品，含 `extractJson`）。
  - CLI：`mentat loop memory`（演示）、`mentat evolve memory --facts|--agent --queries [--store]`
    （规则/agent 驱动、跨运行持久化）。

- **在线"边干活边进化" P1–P4** 完成（`mentat run` 现在会学习）：
  - P1 持久化记忆 `JsonFileMemoryStore` + `buildMemoryContext`；Pi 用
    `--append-system-prompt`、ACP 前缀注入 → `run` 任务前检索并注入。
  - P1b 记忆 MCP server `@mentat/memory-mcp`（`memory_search`/`memory_add`）；
    `SessionOptions.mcpServers` 经 bridge（Pi）与 `session/new`（ACP）注入。
  - P2 经验采集 `ExperienceStore`/`SessionRecorder`；`run` 每次落盘
    `.mentat/experience/*.jsonl`（outcome/usage/tools/toolErrors）。
  - P3 规则在线写：`run --remember "<fact>"`（`rememberFact` 去重）。
  - P4 按需 agent 反射：`run --reflect`（`reflectionPrompt`/`parseReflectedMemories`），
    仅在 `run.settled === "done"` 时蒸馏并写入记忆。
- 信号：在线仅用 `run.settled`（生命周期），不引入额外 `--check`。

- **离线消费经验** 完成：`@mentat/iterate` 的 `buildExperienceDigest`（把 `ExperienceStore`
  的近期记录压成可读摘要）；`mentat evolve memory --agent --from-experience [--experience <dir>]
  [--recent <n>]` 把该摘要喂给 agent 提案器 → 离线 loop 评测/保留。实测：agent 依据经验摘要
  产出命中 held-out 查询的记忆（recall 1）。

**下一步**：用 `mentat iterate` 对 mentat 自身的 worktree 做更多 agent 自迭代任务；
把"经验→提案"扩展到代码（不只是记忆）。
