# 执行、记忆与可观测性重构

2026-10-15。以本地 15 包拆分工作树为基线实施；本次新增 session、host，合计 17 个功能包。本文件描述已实现的边界、使用方式及验证范围，不代表通用个人助手效果基准。

## 目标与参考

借鉴 DeepSeek Harness 的能力契约、产品装配、追加式会话历史、持久化检查点和派生视图：

- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session

Mentat 保留外部 HarnessAdapter；不接管 Pi/ACP 内部 agent loop，不承诺获取引擎没有公开的模型输入或内部推理。没有引入 Cordis、远程类型生成或动态插件加载系统。

## 分阶段实施

| 阶段 | 实施内容 | 验证方式 |
|---|---|---|
| 0 基线 | 保留原拆包工作树，运行原检查；追踪文件补丁及含未追踪源码的完整快照保存在 /tmp/mentat-refactor-baseline | 原 134 项行为通过、1 Docker 跳过；7 项架构检查 |
| 1 执行与轨迹 | session 提供 runTurn、runOnce、openSession、统一关闭；追加事件、内容引用和持久化边界 | ack 与 settled 分离、同步输出、重复结束、挂起发送、取消、重叠调用、启动超时、晚到会话清理 |
| 2 记忆一致性 | MemoryAccess、MemoryRepository、条件提交；文件锁、原子发布、可恢复数据与审计事务；MCP 复用领域服务 | 双实例、独立 Node 进程并发、版本冲突、损坏拒绝、审计故障、journal 恢复、迁移批事务 |
| 3 宿主装配 | host 装配 adapter、记忆、经验和轨迹；assistant 仅依赖 core、memory、session | 注入内存服务；CLI 聊天与显式确认回归；分层检查禁止领域包绑定文件实现 |
| 4 决策链 | Prompt 装配清单、上下文选择原因、反思请求和解析、记忆前后版本、命令 stdout/stderr、候选 diff、提交及回滚 | 真实 MCP 进程分片；真实 Git 演化；评测异常回滚；提交/回滚事件检查 |
| 5 查询与闭环 | trace 查询、完整度检查、对比、外部反馈；经验从轨迹派生并补充反馈 | 反馈引用检查、经验摘要读取纠正、端到端宿主轨迹、真实 DeepSeek 冒烟 |

## 包职责与依赖

- core：HarnessAdapter、SessionHandle、AgentEvent、基础 Tracer、制品契约、通用权限类型与纯脱敏函数。
- session：单轮执行和生命周期；轨迹、经验、诊断与接收接口。只依赖 core。
- assistant：稳定策略、Prompt 装配、上下文、反思和显式记忆确认。只依赖 core、memory、session；不读文件，不操作终端。
- memory：记忆规则、上下文选择、MemoryAccess、MemoryRepository；无外部 workspace 依赖。
- memory-file：文件后端、事务、审计及迁移。只依赖 memory。
- memory-mcp：MCP 协议转换，调用同一 MemoryAccess；宿主传入作用域，工具不能声明用户确认身份。
- observability：文件轨迹、内容存储、派生经验、摘要、查询、诊断及保留策略。依赖 core、session。
- host：静态、类型明确的默认装配；允许注入 MemoryAccess、ExperienceSink、Tracer、诊断回调及指定 adapter。
- cli：参数解析、权限交互、终端呈现和宿主调用。具体引擎注册移至 host，原 CLI 公开入口转导出。
- evolution、workspace、evaluation：保留原契约；补齐评测、实际改动、提交和回滚证据。

文件便捷函数 taskContext(path, task)、rememberUserFact(path, dir, text)、saveReflections(path, candidates) 迁至 @mentat/host。后两者现在返回 Promise，调用方必须 await；实验脚本和集成测试已同步迁移。assistant 的同名领域函数接收注入的接口。

## 执行契约

send() 返回仅代表传输完成，最终结果来自 run.settled。runTurn 保留正常、错误、取消和长度截断；失败前部分文本保留用于诊断，不作为正常 proposer 输出。

单会话禁止并发运行。超时或取消后，执行 interrupt 和有界关闭，禁止复用；重复终止事件不重复完成。runOnce 管理创建和释放，聊天借用会话。启动也有时限，超时后晚到会话会关闭。没有自动重试可能产生副作用的整轮任务。

### 2026-10-19 基础执行修复

- Assistant Host 默认启用 `requireFinalAnswer: true`、`correctiveRetries: 1`。直接调用底层 `runTurn` 仍保留显式配置。代码或文档任务确需引用 DSML 调用块时，可设置 `requireFinalAnswer: false`；评测可以显式设置纠正次数，但必须记录协议变更，不能混合旧成绩。
- 空回答或 DSML 调用块不能直接作为正常最终回答。只有本轮没有任何工具活动时，才允许在原会话中做有限次数的回答纠正；纠正指令要求基于已有证据回答，不能把生成的协议文本解析成真实调用。观察到工具开始、更新或返回后，即使工具报告失败，也不自动纠正或重放任务，避免结果不确定时重复写入或分享。
- 纠正请求等待上一轮 `send()` 返回，共享原始超时预算。超过预算后不发送排队请求；原始任务、模型输出和纠正事件保留在轨迹中。
- ACP 仅将 `end_turn` 映射为 `done`；`max_tokens`、`max_turn_requests` 映射为截断，取消和拒绝分别处理，未知或缺失停止原因报错。工具开始前的讲述保留为 delta 轨迹，最终回答仅取最后一次工具开始之后的文本。若工具仍缺少终态结果，则失败并关闭会话。
- CLI 的 `run`、`chat` 不再逐字显示未经校验的回答片段，在轮次完成且通过校验后输出最终文本；工具进度仍可见，原始片段留在日志中。
- 助理策略升级至 `personal-assistant-v5`，明确真实动作、结果核对、工具缺失和不确定副作用的处理要求。

以上检查验证的是执行与输出契约，不能代替业务验收。合法的“无法完成”回答仍表示回答轮次完成，并不代表用户任务成功。此次未补齐 skill 工具接口，未更改候选记忆确认规则，也未重跑 PAST；旧分数不代表修复后效果。ACP 停止原因依据 [官方 v1 协议](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx) 核对。

kernel 保留插件服务共享语义，提供 isolate() 隔离任务级服务覆盖；显式任务上下文不存入共享容器。插件返回的 disposer 与 effect 统一清理；失败不阻止其他清理，且不重复执行已释放资源。

## 记忆提交与恢复

MemoryAccess 提供 search、context、propose、confirm。确认入口仅供可信宿主处理实际用户指令；MCP 只暴露查询和候选提交。候选不能通过声明 basis/speaker 获得用户身份。配置 scope 后限制查询并覆盖写入作用域；无 scope 的旧条目作为该文件内的公共条目，文件路径本身仍是用户隔离边界，不应把不同用户的文件混用。

FileMemoryRepository.snapshot 返回条目和不透明内容版本；commit 可以指定 expectedRevision，冲突在写入和审计前拒绝。JSON 文件仍为数组，兼容现有读取和迁移。

每次文件变更独占锁，重新读取当前状态。先持久化 journal，再原子发布数据和审计，最后清除 journal。审计写入失败报告 MEMORY_COMMIT_PENDING 和事务 ID，明确表示已进入恢复流程；下一次访问在锁内恢复，不当作未发生的失败盲目重试。审计通过 transactionId/operationIndex 幂等恢复。迁移使用同一批事务保存数据和审计，快照在变更前生成。

损坏文件不再静默视为空库。锁回收会检查持有进程，并串行化死进程锁恢复；活锁超时明确报错。文件方案面向同一台机器上的本地文件系统；跨主机共享存储需要独立后端。文件后端目前采用同步 I/O，并在短临界区内加锁，异步领域接口允许后续替换数据库实现。

## 轨迹与内容

默认 .mentat/runs/<traceId>/：

```text
manifest.json       版本、进程、采集状态、代码版本/dirty、请求模型及配置
events.jsonl       单写入者、连续序号的事件主日志
artifacts/          经脱敏的完整大内容，SHA-256 引用
fragments/          MCP 子进程的独立事件分片
summary.json        关闭时生成的派生摘要
feedback.jsonl      用户在关闭后追加的反馈（如有）
```

事件包含 schemaVersion、eventId、traceId、seq、时间、类型及可用的会话/轮次/跨度。MCP 分片保留原事件 ID、来源顺序和时间；宿主在轮次检查点与关闭时合并。无法可靠关联到某一轮的外部事件不伪造 turnId。

任务主链持续记录消息、工具参数及结果、权限、错误、用量、上下文压缩；Prompt 保存具名策略、动态上下文和选中/遗漏原因。反思保留请求、响应、解析状态、引用证据和写入结果。演化保留评测命令完整输出、signals、候选实际 diff、接受决定及实际提交/回滚。

大内容超过 4096 字符时写内容文件，不因终端展示而丢弃。主日志与内容文件默认单轨迹容量上限 256 MiB，MCP 分片每进程上限 32 MiB；超限追加 capture.gap 并标记 incomplete。flush 同步事件及内容文件；关闭生成并同步摘要和 manifest。检测损坏尾部、序号缺口、孤立工具结果、缺少结束事件、接受但无成功提交、回滚失败。运行中进程退出后，读取时标记 interrupted；manifest 的 complete 表示采集完成，不等同于业务成功。

认证头、常见密钥字段和文本凭据模式在采集入口脱敏。自由文本没有通用、完美的敏感信息识别保证；需要按部署数据补充脱敏规则。原始 RPC 仅在 --log-protocol 开启后记录，仍经过脱敏。子进程 stderr 与协议解析故障归为 adapter.diagnostic。

普通 observer 故障不改变已提交记忆的成功结果，宿主报告诊断；关键记忆事务审计必须成功或保留可恢复 journal。引擎内部工具调用之前的强制落盘，仅在适配器提供该边界时才可保证。

pruneTrajectories(root, cutoff) 提供显式保留期清理，默认不自动删除日志，不删除 running 轨迹。部署方可调用该接口配置自己的维护任务。

## 使用

```bash
pnpm dev run "安排周末上午" --harness fake --reflect --log-dir /tmp/mentat-runs
pnpm dev chat --harness pi --log-dir /tmp/mentat-runs --timeout-ms 120000
pnpm dev trace /tmp/mentat-runs/<traceId> --tree
pnpm dev trace /tmp/mentat-runs/<traceId> --all
pnpm dev trace /tmp/mentat-runs/<traceId> --follow
pnpm dev trace /tmp/mentat-runs/<traceId> --errors
pnpm dev trace /tmp/mentat-runs/<traceId> --context
pnpm dev trace /tmp/mentat-runs/<traceId> --memory
pnpm dev trace /tmp/mentat-runs/<traceId> --tool <callId>
pnpm dev trace /tmp/mentat-runs/<traceId> --summary
pnpm dev trace /tmp/mentat-runs/<traceId> --check
pnpm dev trace compare <before-dir> <after-dir>
pnpm dev trace feedback <run-dir> --turn <turnId> --score 0 --correction "遗漏截止时间"
```

--raw 输出解析内容后的完整事件；默认隐藏 token 级增量，--all 展示。旧 trace.jsonl 仍可读取。日志摘要中的未知成本不填写为零；usageComplete/costComplete 表示是否具备全量用量依据。

反馈必须引用真实轮次；score 范围 0..1。ExperienceStore 读取时关联轨迹内和外部反馈，buildExperienceDigest 加入来源、纠正及 trace/turn 引用。没有反馈时明确 quality=unverified。历史事件的重读和经验重建不调用模型或工具，不自动重放副作用。

### 执行终止与任务验证（2026-10-21）

`reason=done` 只代表执行正常结束，CLI 的零退出码也不代表任务质量通过。`run.settled`、`TurnResult` 和经验记录新增以下可选字段，旧记录缺失时保持未知，不回填推断：

- `termination`：`cause`、`source`、可选 `rawReason`，区分正常结束、token/request 上限、取消、主机超时、错误和未知。ACP 原生原因原样保留；其他旧 transport 没有精确证据时标为 unknown。
- `completion`：是否存在响应文本（不等于交付物）、`verification=unverified` 和带来源的 warnings。会话层不根据最终文本、工具数量或测试命令名称自动认定任务成功。

部分 OpenCode 运行只返回 `end_turn`，却在最终文本开头自述达到步数上限。ACP 兼容层仅识别已观察到的固定开头，将其标记为 `assistant-reported-step-limit`；不改写原生终止原因，不当作确定的预算耗尽，也不宣称覆盖所有版本/语言。结构化 `max_tokens`、`max_turn_requests` 则分别记录为对应上限，保留 `reason=length`。CLI 展示预算受限的部分响应并输出终止提示；协议泄漏等 error 响应继续不作为正常正文输出。

这些字段进入轨迹、持久化经验、反思元数据及 SWE 统一导入。反思不将 warning 当成用户认可或能力提升证据。SWE 主体遇到 length 时仍允许收集补丁并独立评分，运行错误继续阻止发布模型分数。官方 reward 与执行状态并列保留：预算耗尽仍可能通过验证，正常结束也可能验证失败。没有增加重试、修改预算或重新解释既有成绩。

验证：`pnpm check` 通过，93 个 Vitest 文件、376 passed / 1 skipped，PAST Python 18 项、SWE Python 11 项。新增覆盖原生终止原因、未知值、助手自述与引用文本、超时、部分输出、持久化经验和预算受限但独立评分通过。首次沙箱执行的 Unix socket 测试报 EPERM，授权后完整重跑通过。另对 NodeBB 原始协议帧和最终文本作离线分析，结果在 `.mentat/swe-bench/nodebb-rosetta-2g-v2/termination-analysis.json`，保留原响应摘要和事件 ID；未重放工具或调用模型，原始成绩未改。

## 复现实验与验证范围

```bash
pnpm check
pnpm -r typecheck
node --import tsx --test experiments/personal-assistant/runner.test.ts
node_modules/.bin/tsc --noEmit -p experiments/personal-assistant/tsconfig.json
node --import tsx experiments/personal-assistant/refactor-smoke.ts
node --import tsx experiments/personal-assistant/refactor-smoke.ts --real
```

真实模式使用本机已授权 OpenCode ACP、opencode-go/deepseek-v4.1-flash，可用 MENTAT_SMOKE_MODEL 覆盖。任务在新临时目录中执行，限制工具权限，仅验证一小段交互和日志链路；不是盲测，也不是学习提升统计证明。

已运行三轮真实冒烟：记录 160 条事件、3 轮正常结束、无采集缺口或契约错误。默认中文简洁格式、单轮段落例外及下一轮恢复均可观察。模型把“11 点前”安排到 11:00 边界，虽然执行正常，严格约束质量仍有问题；后续应作为独立质量回归案例。不能以本次重构验证替代记忆检索、偏好生命周期及长期学习效果的专项实验。

Docker 检查沿用项目显式启用机制。通用 ACP 和 Pi 均有协议子进程契约测试；本次真实模型仅使用 OpenCode ACP，不宣称真实 Pi 模型或 Docker 已验证。

最终验收记录：`pnpm check`通过，行为测试171项通过、1项Docker跳过，7项架构规则通过；17包各自类型检查通过；实验执行器7项通过、实验TypeScript检查通过。真实DeepSeek共运行先前三轮与最终一轮冒烟，最终引擎诊断确认实际模型为请求的DeepSeek型号。第三方锁定包及依赖快照与重构基线相同，仅workspace依赖装配变化。详细报告见[重构验证](research/refactor-validation.md)。
