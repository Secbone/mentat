# Mentat on DSH：产品定位与架构

日期：2026-11-05。状态：设计提案，Phase 0 spike 后确认。配套决策：[ADR-0007](../adr/0007-dsh-hosted-mentat.md)。

## 0. 结论

Mentat 仍然是一个产品，但不再自己造 agent runtime。它基于 DeepSeek Harness（DSH）的插件生态构建，参考 Super-agent 的 Router/Worker 运行逻辑，把执行面开放给异构 Worker（Pi、OpenCode、Codex、DSH-native），把自进化放在控制面完成，并以版本化的 **Capability Pack** 下发给 Worker。

一句话定位：

> **DSH 是宿主，Super-agent 是运行逻辑参考，Mentat 是"异构 Worker 的控制面 + 自进化能力层"。**

## 1. 背景

### 1.1 DSH 提供什么

本机安装的是 `@deepseek-ai/dsh` 0.2.1-rc.5。DSH 是 MIT 开源的 Cordis 插件宿主，明确标注 developer preview、会有 breaking changes。它已经提供：

- `ctx.sessions`：append-only session log、回放、恢复；
- `ctx.sessionQuery`：跨 session 查询；
- `ctx.tools`：工具注册与执行管线；
- `ctx.systemPrompt`：system prompt 分段组装；
- `ctx.skills`：技能注册表 + provider 机制（文件系统、内置技能等）；
- `ctx.schedule`：after/at/every/daily/weekly/cron 的持久化提醒；
- `ctx.jobs`：后台任务；
- `ctx.agents` / `ctx.subagents`：agent 生命周期与子代理；
- worktree、sandbox、审批、settings、telemetry、web panel、plugin manager。

这些能力不应该在 Mentat 里重写。

### 1.2 Super-agent 提供什么

DeepSeek 的 Super-agent（`dsh-superagent-prototype`，MIT，research prototype）是 DSH 上的一个应用 bundle。它提供：

- **Router / Worker 双层**：Router 与人交互、评估候选、派工；Worker 每 Ticket 一个独立 Session 和目录；
- **领域模型**：Source → Trigger → Thread → Eval（gate + assessment）→ Decision → Ticket + Mandate → Assignment → Executor → Report → Channel；
- **Policy**：允许列表、admission table、accept mode（off/observe/auto）、Policy version、Mandate revalidation；
- **持久状态**：SQLite + 目录锁；Engine 是唯一写者；
- **durable effects / outbox**：外部副作用先入队、提交后执行、失败重试；
- **Prompt / Settings / Panel**：版本化 prompt、团队 section、技能、执行环境、只显示"需要人"的面板。

它默认只面向单个 GitHub 仓库（可选 Feishu），Worker 是 DSH Session。这两点正是 Mentat 要泛化的地方。

### 1.3 Mentat 的现状

Mentat 已有：

- `@mentat/session`、`@mentat/host`、`@mentat/harnesses`、`transport-pi`、`transport-acp`：单会话执行与多引擎接入；
- `@mentat/memory`、`@mentat/skills`、`memory-file`、`skills-file`：记忆与流程知识；
- `@mentat/workspace`：Git worktree 与内容寻址候选；
- `@mentat/observability`：轨迹、经验、receipt；
- `@mentat/evaluation`、`@mentat/benchmark`、`@mentat/evolution`：评测、基准、制品演化；
- `@mentat/cli`：run/chat/iterate/evolve。

缺口：常驻 Runtime、多工单、Source/Trigger/Thread、Policy/Mandate、durable effects、Router/Worker、Panel。

## 2. 为什么不是全量切换，也不是平行重写

| 方案 | 问题 |
|---|---|
| 全量变成 DSH/Super-agent bundle | 丢掉 Mentat 的证据/进化层，产品变成 DeepSeek 应用的分支 |
| 把 DSH 架构整体搬进 Mentat | 重造 session/tool/sandbox/UI，维护成本高且追不上 |
| 保持现有平行 runtime | 无法以合理成本提供常驻、多工单、多 Worker 的产品 |
| **DSH 宿主 + Mentat 产品层 + 异构 Worker** | **复用生态，保留差异化，Worker 可选** |

选择最后一种，并用 **控制面 / 执行面** 的边界避免两套 agent loop 打架。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ 控制面（DSH Host + Mentat Plugins）                           │
│                                                              │
│  Router Session        Domain Service         Panel          │
│  Source/Trigger/Thread  Ticket/Mandate/Policy  Overview       │
│  Eval/Decision          Assignment/Report      Workers        │
│                                                              │
│  Memory     Skill Provider     Eval/Receipts                 │
│  Dream      Evolution          Worker Registry               │
├──────────────────────────────────────────────────────────────┤
│ 能力面（版本化、可下发）                                      │
│  CapabilityPack: prompt · skills · memory · tools/MCP ·       │
│                  policy · routing · model                     │
├──────────────────────────────────────────────────────────────┤
│ 执行面（异构 Worker）                                         │
│  Pi Adapter   OpenCode Adapter   Codex Adapter   DSH Adapter  │
│  （每个 Worker 一个隔离 workspace，只向 Router 报告）          │
├──────────────────────────────────────────────────────────────┤
│ 证据面                                                        │
│  ArtifactRef / Receipt / EvalProtocol / Archive / Attribution │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 职责边界

**控制面（DSH 里的 Mentat 插件）**

- 接收 Source 事件，维护 Trigger/Thread；
- 运行 Eval（gate + assessment），产生 Decision；
- 创建 Ticket/Mandate/Assignment；
- 选择 Worker 和 CapabilityPack；
- 汇总 Report、回复人、更新 Panel；
- 运行 Dream/Evolution，产生并下发新的 Pack；
- 不做具体实现，不直接跑 shell。

**执行面（Worker）**

- 一个 Ticket 一个独立 workspace；
- 接收 CapabilityPack；
- 执行、自测、产出 artifacts；
- 只向 Router 报告，不直接与人对话；
- 不同 Worker 的 prompt/tool/sandbox 能力通过 adapter 协商。

**证据面**

- 每个 Assignment 记录 Pack digest；
- 每个 Receipt 记录实际注入的 prompt/skill/memory/tool 版本；
- 每次评测记录协议 digest、环境指纹、Worker 版本；
- 任何"变好了"都必须能追溯到具体 Pack/Worker/协议。

## 4. 领域模型（参考 Super-agent）

| 概念 | 定义 | Mentat 的处理 |
|---|---|---|
| Source | 事件流；kind + instance | 复用 Super-agent 的 Source 协议，新增企业内部 Source |
| Trigger | 不可变事件 + Source 元数据 | 进入 Engine，幂等 |
| Thread | 时间有序的 Trigger 流 | 同一 Thread 同时最多一个 Eval |
| Eval | gate（确定性）+ assessment（模型） | gate 用 Policy，assessment 用 Router Session |
| Decision | accept/stop/ignore/unavailable | 记录原因、强度、Policy 版本 |
| Mandate | 授权：范围、强度、依据、Policy 版本 | 只有 accept 创建、人工 stop 撤回、revalidation 失败撤销 |
| Ticket | 授权工作单元 | 状态不跟随 Worker Session |
| Assignment | Ticket 与一个 Worker 实例的绑定 | 记录 Worker id、workspace、Pack digest |
| Subscription | Ticket 与 Thread 的关系 | 只提供上下文，不授予权限 |
| Channel | 写回 Source 的通道 | 复用 Super-agent 的 Channel |
| Policy | 版本化规则 + Source 允许列表 + admission + accept mode | 核心使用 Super-agent 模型；Mentat 扩展规则 |
| Input | 送给 Ticket 的上下文 | 记录是否已读、是否被 Executor 接管 |
| Report | Assignment 的状态报告 | 统一 Worker 事件后的结构化报告 |

如果 Super-agent 开源版的 domain/panel 足够通用，优先复用并扩展；如果它绑定单仓库 GitHub，Mentat 在自己的 domain 包里泛化，而不是改它的核心。

## 5. 控制面：DSH 集成点

| DSH 能力 | Mentat 用法 |
|---|---|
| `ctx.sessions` | Router、Dream、Evolution 的会话；Worker session 的外部引用 |
| `ctx.sessionQuery` | Dream 回放历史、Evolution 选择经验 |
| `ctx.tools` | `memory_search`、`memory_write`、`skill_*`、`eval_*`、`dream_*`、`evolve_*`、`worker_*` |
| `ctx.systemPrompt` | 注入 memory/skill/policy 段；按 Pack 版本组装 |
| `ctx.skills` | Mentat 只注册 **skill provider**，不替换 registry |
| `ctx.schedule` | Dream 的每日/每周整理；Evolution 的定期评测 |
| `ctx.jobs` | 长时评测、跨 Worker 矩阵、批量回放 |
| `ctx.agents` / `ctx.subagents` | Router、Dream、Evolution 的"思考型"会话 |
| settings | Pack、Worker、Policy、Dream 的配置与版本 |
| panel | Overview / Workers / Evolution / Dream / Memory / Settings |
| telemetry | Receipt、归因、成本、延迟 |
| authorization | Super-agent Policy + Mentat 扩展规则；不要重写 gate |

### 5.1 插件/包布局

```
@mentat/contracts              # 纯类型：ArtifactRef / Receipt / EvalProtocol / Pack / Report
@mentat/domain                 # 纯领域：Source/Trigger/Thread/Eval/Ticket/Mandate/Policy/Assignment
@mentat/dsh                    # Cordis 插件/服务/工具/Panel 的适配层
@mentat/worker                 # WorkerAdapter 协议 + FakeWorker + 能力协商
@mentat/worker-pi              # Pi adapter
@mentat/worker-opencode        # OpenCode/ACP adapter
@mentat/worker-codex           # Codex adapter
@mentat/plugin-memory          # 记忆 service + tools + 注入 + 存储 + panel
@mentat/plugin-skill           # ctx.skills 的 provider（版本/审查/恢复）
@mentat/plugin-eval            # 协议、receipt、归因、benchmark、panel
@mentat/plugin-evolve          # artifact registry + propose/eval/gate/archive
@mentat/plugin-dream           # schedule/jobs + session replay + consolidation
@mentat/plugin-source-*        # 额外 Source
@mentat/superagent-pack        # bundle：一次安装上述插件
```

依赖方向：

```
contracts
  ↑
domain ← plugin-eval ← plugin-evolve
  ↑         ↑              ↑
plugin-memory ← plugin-dream
  ↑
plugin-skill (ctx.skills provider)
```

插件之间只通过 `contracts` 的服务接口和 DSH 事件通信，不直接 import 彼此。

## 6. 执行面：WorkerAdapter

```ts
export interface WorkerCapabilities {
  promptInjection: "system" | "prefix" | "none";
  skills: "filesystem" | "mcp" | "none";
  mcp: boolean;
  permissions: "sandbox" | "approval" | "none";
  events: "acp" | "jsonl" | "rpc";
  streaming: boolean;
  costReporting: boolean;
}

export interface WorkerAdapter {
  readonly id: string;
  capabilities(): WorkerCapabilities;
  spawn(input: {
    assignment: Assignment;
    workspace: Workspace;
    pack: CapabilityPack;
    signal: AbortSignal;
  }): Promise<WorkerSession>;
  send(session: WorkerSession, input: Input): Promise<void>;
  events(session: WorkerSession): AsyncIterable<WorkerEvent>;
  cancel(session: WorkerSession): Promise<void>;
  report(session: WorkerSession): Promise<Report>;
  artifacts(session: WorkerSession): Promise<ArtifactRef[]>;
}
```

关键点：

- **能力协商**：不支持的项要显式降级，不能静默忽略；
- **workspace 隔离**：一个 Assignment 一个 worktree/目录；
- **事件归一化**：把 ACP/JSONL/RPC 事件映射成统一的 `WorkerEvent`（tool start/end、message、error、cost、artifact）；
- **报告结构化**：progress/waiting/ready/blocked/failed/dropped + 一个具体问题；
- **成本/延迟**：能报就报，不能报就标记 unknown；
- **取消/恢复**：每个 adapter 必须支持 cancel 和 resume 语义，或明确声明不支持。

首批 adapter：

| Worker | 接入方式 | 备注 |
|---|---|---|
| FakeWorker | 进程内 | 领域/评测测试 |
| OpenCode | ACP | 复用 `transport-acp` |
| Pi | Pi RPC | 复用 `transport-pi` |
| Codex | CLI/JSONL 或 ACP | 需要新 adapter |
| DSH-native | `ctx.agents` | 可选，不是默认 |

## 7. 能力面：CapabilityPack

```ts
export interface CapabilityPack {
  id: string;
  version: number;
  digest: Digest;
  prompt: {
    system: string;
    teamSections: Record<string, string>;
    role: "router" | "worker";
  };
  skills: SkillRef[];
  memory: MemorySnapshotRef;
  tools: {
    mcpServers: McpServerRef[];
    allowlist: string[];
    blockedCommands: string[];
  };
  policy: {
    budget: { wallMs?: number; steps?: number; costUsd?: number };
    permissions: "read" | "write" | "sandbox";
    routing?: RoutingHint;
  };
  model: { provider: string; model: string; effort?: string };
  evalProtocol?: EvalProtocolRef;
}
```

规则：

- Pack 是内容寻址的（digest）；Assignment 记录 pack digest；
- Receipt 记录实际注入的 prompt/skill/memory/tool 版本，而不是只记录 Pack；
- Worker 不支持某项能力时，adapter 必须报告降级；
- Pack 可以 canary、回滚、按 Worker/任务类型分组；
- Pack 的变更必须经过 Eval + Gate，不能直接改线上。

2026-11-06 首版实现：`@mentat/pack` 定义 `CapabilityPack` 与
`defineCapabilityPack()`，对整包做内容寻址；`MentatRuntime` 把 digest 写入
Assignment 和 receipt；`HarnessWorker` 注入 prompt/model/MCP/executionPolicy，
对 skills、memory 和 tool allowlist 目前显式报错，而不是静默丢弃。skills/memory
的真实注入由后续的 Skill/Memory 插件提供。

## 8. 自进化层

```
Observe（Worker 轨迹 + Receipt）
  → Distill（Dream：经验 → memory/skill/prompt 候选）
  → Propose（Evolution：生成 CapabilityPack 变更）
  → Evaluate（冻结任务集 × 多 Worker × 配对比较）
  → Gate（安全/成本/回归/人工）
  → Promote（新 Pack 版本，canary）
  → Distribute（下发给 Worker）
  → Archive（digest + lineage + receipt）
```

### 8.1 可进化对象

| 对象 | 例子 | 评测方式 |
|---|---|---|
| Memory | 用户偏好、项目事实、失败教训 | 召回/纠正率 |
| Skill | 可复用流程、工具使用步骤 | 任务成功率 |
| Prompt | Router/Worker 的角色与约束 | 基准 + 人工 |
| Tool/MCP 配置 | 允许的工具、参数默认值 | 任务成功率/成本 |
| Policy | 预算、权限、路由规则 | 安全 + 成本 |
| Routing | 任务类型 → Worker/模型 | 跨 Worker 矩阵 |
| Worker 代码 | 自研 Worker 的代码 | 代码评测 |

### 8.2 Dream

Dream 是离线整理，不是在线 agent：

- 由 `ctx.schedule` 或 `ctx.jobs` 触发；
- 用 `ctx.sessionQuery` 回放最近会话；
- 抽取事实/偏好/失败教训，合并/去重 memory；
- 生成 skill/prompt 候选；
- 交给 Eval 做小规模验证；
- 写入 Evolution 的 archive；
- Panel 展示"待人工决定"的候选。

**Dream 不直接改 memory/skill/prompt**，只产生候选。这符合 Super-agent 的"最小人类注意力 + 可审计"原则。

### 8.3 评测矩阵

```
tasks × workers × packs × protocols
```

- 冻结协议：dataset/scorer/model/budget/environment 全部内容寻址；
- 配对比较：reset vs learned、worker A vs worker B、pack v1 vs v2；
- holdout：开发集与最终验收集分开；
- 成本/延迟：与质量一起报告；
- 归因：区分 Worker 变强、Pack 变强、路由变强。

单 Worker 的提升不能直接报告为"系统变强"；必须说明是哪一个维度。

## 9. 插件清单与粒度

| 插件 | 职责 | DSH hooks | 依赖 |
|---|---|---|---|
| `@mentat/contracts` | 纯类型/协议 | 无（不是插件） | 无 |
| `@mentat/domain` | 领域规则、Engine、Policy、Stage | 无（纯逻辑） | contracts |
| `@mentat/dsh` | Cordis 插件/服务/工具/Panel 适配 | 全部 | domain/contracts |
| `@mentat/worker` | WorkerAdapter + FakeWorker | `ctx.jobs`（可选） | contracts/workspace |
| `@mentat/plugin-memory` | 长期记忆 | tools/systemPrompt/sessions | contracts |
| `@mentat/plugin-skill` | 技能 provider | skills | contracts |
| `@mentat/plugin-eval` | 评测/回执/归因 | tools/jobs/telemetry/panel | contracts |
| `@mentat/plugin-evolve` | 制品演化 | jobs/schedule/panel | memory/eval/skill |
| `@mentat/plugin-dream` | 离线整理 | schedule/jobs/sessionQuery/panel | memory/eval/skill |
| `@mentat/plugin-source-*` | 额外来源 | Source 协议 | domain |
| `@mentat/superagent-pack` | bundle | 安装入口 | 上述全部 |

### 9.1 粒度判断

一个功能值得独立插件，至少满足两条：

1. 有独立状态/存储；
2. 有独立生命周期（可加载/卸载/禁用）；
3. 需要自己的面板或设置；
4. 需要被其他插件作为 service 调用；
5. 可以被不同实现替换（capability seam）。

否则它应该是某个插件里的一个 tool、一段 prompt、一条 policy 或一个后台 job。

### 9.2 不要做成插件

- 纯 prompt 文本 → 团队 section / prompt override；
- 简单工具包装 → 对应插件里的一个 tool；
- Policy 规则 → Super-agent Policy 配置，除非新 gate 逻辑；
- 模型适配器 → DSH `ctx.llm`；
- session 存储/搜索/UI → DSH 已有。

## 10. 产品形态

- 安装：`dsh plugin --profile <name> add @mentat/superagent-pack`；
- 启动：`dsh <profile>`，Mentat 作为 bundle 挂载；
- 命令：`dsh mentat status`、`dsh mentat worker list`、`dsh mentat evolve ...`（或 panel 操作）；
- Panel：
  - **Overview**：需要人决策的 Ticket、Worker 健康、Evolution 候选；
  - **Workers**：Worker 列表、能力、负载、最近 Assignment；
  - **Evolution**：候选 Pack、评测证据、接受/拒绝/回滚；
  - **Dream**：上次整理、候选、证据；
  - **Memory**：作用域、来源、版本、冲突；
  - **Settings**：Pack/Worker/Policy/Dream。

原则：只显示"需要人"的信息；健康状态不占空间。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| DSH developer preview，breaking changes | pin 版本；薄适配层；contracts 包；CI 矩阵 |
| 两套 agent loop 打架 | DSH 只跑 Router/Dream/Evolution；Worker 走外部 adapter |
| Worker 能力差异大 | capability negotiation + 显式降级；不做虚假统一 |
| 跨 Worker 能力不迁移 | Worker × Pack 矩阵评测；分 Worker 报告 |
| Super-agent 开源后覆盖功能 | 只做它不做的证据/进化/能力下发；能上游就上游 |
| 安全/授权不一致 | Mandate 在 Assignment 层强制；Pack 含 allowlist/budget；receipt 记录实际权限 |
| 旧 runtime 沉没成本 | 冻结新投入；保留 standalone 作为评测对照 |
| 模型/provider 限制 | spike 阶段验证；用 DSH LLM adapter 接 OpenAI-compatible |

## 12. 路线图

### Phase 0：DSH spike（不改 Mentat）

- 安装并起 `dsh web` / `headless` / `acp`；
- 写最小 Cordis 插件：service + tool + panel page；
- 用 `ctx.agents` 跑 Router Session；
- 用 `transport-acp` 接一个外部 Worker；
- 从插件写 SQLite；
- 验证：session/event、tool 注册、prompt 注入、schedule/jobs、panel、模型 provider。

**验收**：一个最小 Ticket 从触发到 Worker 报告，receipt 能记录 Pack digest 和实际注入。

### Phase 1：控制面

- `@mentat/contracts` + `@mentat/domain`（纯逻辑 + 内存仓储测试）；
- `@mentat/dsh` 插件骨架；
- `@mentat/worker` + FakeWorker + OpenCode/Pi adapter；
- 一个端到端：Source → Ticket → Assignment → Worker → Report → Channel。

### Phase 2：CapabilityPack + 评测

- Pack 构建/ digest/ 下发/ 回执；
- 冻结评测协议；
- Worker × Pack 矩阵；
- 只读评测，不自动进化。

### Phase 3：Dream + Evolution

- Dream：schedule/jobs + session replay + memory consolidation + 候选；
- Evolution：propose/eval/gate/archive + canary + rollback；
- 人工批准高影响变更。

### Phase 4：产品化

- Panel 完整化；
- 更多 Source/Worker；
- 多租户/权限/成本；
- 文档、安装、升级、迁移。

## 13. 验收标准

- DSH 能加载 Mentat bundle，不修改 DSH 源码；
- Router 能创建 Ticket、选择 Worker、记录 Pack digest；
- Worker 能通过 adapter 执行并返回结构化 Report；
- Receipt 能回答"哪个 Worker、哪个 Pack、什么协议、什么信号、是否注入"；
- 同一个 Pack 能在至少两个 Worker 上评测；
- Evolution 能产生候选、评测、人工批准、canary、回滚；
- Dream 只产生候选，不直接改线上；
- `pnpm check`/DSH plugin check 通过。

## 14. 开放问题

1. Super-agent 开源后，domain/panel 复用多少？是否直接扩展它的 bundle？
2. DSH 版本策略：pin 到 rc，还是跟 minor？CI 是否同时测两个版本？
3. 状态存储：Mentat 自己的 SQLite，还是复用 DSH storage？Ticket/Assignment 与 session log 如何关联？
4. Worker 能力协商的最小集是什么？哪些能力必须支持才能接入？
5. CapabilityPack 的签名/审批：是否需要 in-toto/SLSA 式 attestation？
6. 多租户/多用户隔离：一个 DSH profile 一个 Mentat 实例，还是多实例？
7. "Dream" 的命名和产品语义是否保留？是否叫 "Consolidation" 更清晰？
8. 旧 `run/chat/iterate/evolve` 是保留为 standalone，还是逐步移除？

## 15. 参考

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- DSH architecture: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- Super-agent prototype: https://github.com/deepseek-ai/dsh-superagent-prototype
- Super-agent domain model: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md
- Super-agent authorization: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md
- Super-agent execution: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md
- Super-agent prompts: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md
- Super-agent panel: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md
- Super-agent architecture: https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md
- Cordis: https://github.com/cordiverse/cordis
- 本仓库既有制品/回执设计：[artifact-architecture-2026-10-22.md](artifact-architecture-2026-10-22.md)
- 本仓库既有 DSH 相关决策：[ADR-0007](../adr/0007-dsh-hosted-mentat.md)
