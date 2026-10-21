# 子包职责与依赖规则

每个包承担一个功能边界。协议、纯领域规则、文件持久化、模型调用策略和命令装配分别管理，跨包只能使用 `package.json` 声明的公开入口。

## 子包职责

| 包 | 职责 | 生产 workspace 依赖 |
|---|---|---|
| `@mentat/assistant` | 通用策略、上下文装配、反思和显式确认 | core、memory、session |
| `@mentat/benchmark` | 纯评测契约、计划校验、配对分析 | 无 |
| `@mentat/benchmark-file` | 上游结果接入、冻结源码、结果发布与报告 | benchmark、evaluation、storage-file |
| `@mentat/cli` | 命令解析、终端交互及应用流程装配 | benchmark、benchmark-file、assistant、core、evaluation、evolution、memory、memory-evolution、memory-file、observability、transport-pi、workspace、session、host、harnesses |
| `@mentat/core` | 统一协议、事件、制品与 harness 契约 | 无 |
| `@mentat/evaluation` | 命令/进程组执行、容器回收与评测器 | core、evolution |
| `@mentat/evolution` | 提案、门、完整指标比较、探索归档与发布选择 | core、kernel |
| `@mentat/harnesses` | 引擎特有策略、MCP 配置与默认注册 | core、transport-pi、transport-acp |
| `@mentat/host` | 宿主装配、访问边界、召回、执行与资源关闭 | core、session、assistant、memory、memory-file、memory-mcp、observability、skills-mcp |
| `@mentat/kernel` | 插件、作用域与服务注册生命周期 | core |
| `@mentat/memory` | 记忆规则、状态、访问策略与上下文选择 | 无 |
| `@mentat/memory-evolution` | 记忆制品、召回代理评估及演化结果应用 | core、evolution、memory |
| `@mentat/memory-file` | 记忆事务日志、审计与恢复 | memory、storage-file |
| `@mentat/memory-mcp` | 记忆工具协议与子进程入口 | core、memory、memory-file |
| `@mentat/models` | 模型目录与成本/上下文选择策略 | core |
| `@mentat/observability` | 轨迹、经验、内容存储、审计与召回归因 | core、session、storage-file |
| `@mentat/session` | 会话执行、超时取消、轨迹与经验契约 | core |
| `@mentat/skills` | 流程知识契约、状态和排序 | 无 |
| `@mentat/skills-file` | 流程知识版本、宿主审查、恢复与持久化 | skills、storage-file |
| `@mentat/skills-mcp` | 流程工具；模型只能保存草稿，不能发布验证状态 | core、skills、skills-file |
| `@mentat/storage-file` | 通用文件锁、死进程恢复与原子 JSON 写入，不承载领域规则 | 无 |
| `@mentat/transport-acp` | ACP 连接、内容翻译、会话与权限 | core |
| `@mentat/transport-pi` | Pi 协议、事件翻译与权限桥 | core |
| `@mentat/workspace` | 隔离 Git 工作区与不可变候选快照 | core、evolution、storage-file |

表中的名称省略 `@mentat/` 前缀。`models` 和 `memory-evolution` 的测试使用kernel验证制品应用，但生产代码不依赖kernel；依赖放在 `devDependencies`，由检查脚本限制用途。

## 必须保持的边界

1. **底层不能反向依赖。** core与memory没有workspace依赖；kernel、evolution、models、memory-evolution的生产代码也不引入Node内置模块。文件读写由专门的包负责。
2. **引擎只依赖协议。** 两个transport包只依赖core。assistant、workspace、evaluation及领域包不绑定具体引擎，host负责默认注册，CLI选择已注册的适配器。
3. **记忆规则共用实现。** MCP和宿主共用MemoryAccess及FileMemoryRepository。Node入口显式注册其运行时依赖tsx加载器；不依赖调用者传入加载参数。
4. **演化与存储分离。** memory-evolution表达如何评价和修改记忆，memory-file负责保存；workspace负责候选版本，evaluation负责执行检查；二者不能互相反向依赖。
5. **只从公开入口导入。** 禁止跨包相对路径、未导出的私有子路径和依赖循环；生产代码不能借用仅声明在devDependencies中的包。测试也不能制造反向循环，跨领域集成测试放在CLI装配层。
6. **不保留聚合大包。** 原 `@mentat/runtime` 已移除。core和memory不转导出已迁走的领域实现，否则物理拆包仍会保留原来的依赖耦合。

CLI的纯函数和领域策略应归相应功能包；命令解析、输出、引擎注册与权限交互留在CLI。单个协议适配器内部文件不按函数数量继续拆包。

## 导入迁移

| 旧入口或位置 | 新入口 |
|---|---|
| core的 `Kernel`、`Context`、`Plugin` | `@mentat/kernel` |
| core的 `SelfIterationLoop`、`Candidate`、`Gate`、`Evaluator`、`Archive` | `@mentat/evolution` |
| core的 `ModelCatalog`、`modelCatalogArtifact` | `@mentat/models` |
| memory的 `JsonFileMemoryStore`、`JsonlMemoryAudit`、迁移工具 | `@mentat/memory-file` |
| memory的 `ExperienceStore`、`SessionRecorder`、经验摘要 | `@mentat/observability` |
| memory的制品、提案、recall评测和演化演示 | `@mentat/memory-evolution` |
| memory的反思解析及CLI的prompt、reflection、remember辅助逻辑 | `@mentat/assistant` |
| CLI私有的 `memoryMcpSpec` 与memory的MCP脚本 | `@mentat/memory-mcp` |
| runtime的 `GitWorkspace`、`JsonStoreWorkspace` | `@mentat/workspace` |
| runtime的命令门、命令评测器、容器运行器 | `@mentat/evaluation` |
| runtime的 `AgentProposer`、`AgentDataProposer` | `@mentat/evolution` |
| runtime的 `JsonlTracer` | `@mentat/observability` |

这些私有workspace包的旧聚合导出已移除，调用方需更新导入。CLI命令、记忆文件结构、权限行为及harness契约保持不变。实验执行器同步改用公开入口，不再导入CLI私有源码。

自迭代命令默认保护路径随代码迁移为 `packages/evolution/src/**`，帮助信息同步更新；CLI集成测试验证真正修改该路径时会拒绝候选并回滚。

## 增加功能包

在 `packages/<name>/package.json` 声明入口和实际依赖，并在 `scripts/check-layering.mjs` 规定允许的依赖方向。运行 `pnpm install` 更新workspace链接和锁文件，再运行 `pnpm gen`。TypeScript与Vitest别名都由manifest的exports生成，不能手动另建映射。

职责目录、实例化或依赖聚合不是增加新包的理由。新增包应有独立用途与明确的允许依赖；跨包能力通过小接口注入，避免让领域包导入CLI或transport。

## 验证

`pnpm check` 验证实际导入、公开入口、纯包Node边界、依赖声明与循环，并执行架构规则回归、类型检查、行为回归和格式检查。分层检查使用语法树读取静态导入、转导出、动态导入、require及import类型，避免把注释当作依赖。

```bash
pnpm check:layering
pnpm test:architecture
pnpm -r typecheck
pnpm --filter @mentat/memory typecheck
pnpm check
node --import tsx --test experiments/personal-assistant/runner.test.ts
node_modules/.bin/tsc --noEmit -p experiments/personal-assistant/tsconfig.json
```

真正的MCP子进程测试使用公开的 `memoryMcpSpec` 启动；CLI集成测试覆盖引擎策略装配与Git演化回滚，避免只靠类型检查判断迁移成功。Docker真实运行仍由显式开关启用，普通检查默认跳过该项。

2026-10-15验证：15个子包各自的类型检查通过；`pnpm check`包含7项架构规则测试和134项通过的行为测试，1项Docker测试默认跳过；实验执行器7项测试与类型检查通过。真实CLI冒烟覆盖引擎列表、通用及记忆演化演示、fake任务与显式记忆确认、旧记忆迁移和快照。第三方依赖锁定版本及快照未变化，未调用真实模型。

## 执行与可观测性重构

执行与可观测性重构阶段形成17个功能包；上面的2026-10-15验证记录是此前15包拆分基线，重构实现和验证见 [执行、记忆与可观测性重构](../refactor-execution-observability.md)。assistant禁止依赖文件实现和终端，session只依赖core，observability实现session契约；host负责默认装配。不要让领域包反向导入host。

2026-10-16新增 benchmark 与 benchmark-file 后为19个功能包。benchmark 保持纯契约与分析，benchmark-file 负责运行文件和外部执行；Mentat Subject 的 host 装配在 CLI，两个新包均不依赖 host 或 transport。公开评测集环境和 scorer 留在上游框架，接入说明见 [评测框架](../benchmark-framework.md)。

## 2026-10-21 正确性与恢复边界

当前为 24 个功能包。新增 storage-file 仅抽象跨模块共用的文件锁与原子 JSON 写入；锁的原生 JavaScript 入口可供不加载 TypeScript 的 Node 子进程使用。memory-file、skills-file、workspace、observability、benchmark-file 复用该层，领域策略仍留在各自子包。

Host 的协议片段摄取移入 capture.ts，召回等待移入 recall.ts；ACP 的连接与内容翻译分别移入 connection.ts 和 content.ts。HostOverrides.modelSelector 可注入 ModelCatalog 或其他宿主路由策略；显式 model 优先，选不到模型时报错，不隐式改用其他模型。

未绑定 scope 只访问未分区记忆；跨 scope 只允许显式 sharedMemoryScopes 读取。导入历史和反思同样受 Host 的 scope/cwd 边界约束。旧 ID 不重写，新记忆使用 UUID；旧数据缺少 scope 时不会自动猜测归属。

演化实验采用完整且固定的指标集合。Archive.best 仅表示探索排序；LoopResult.best 是已接受且不使已发布指标退化的候选。protected 制品必须保留可信原对象，不能由提案自报相同版本替换。候选快照不可覆盖，当前指针只在提交时原子更新；重启不会恢复正在评估的候选。

iterate 默认使用独立 detached worktree，开始时拒绝脏目录，发布时再次检查原 HEAD 与工作区，只允许快进。依赖不会从原目录共享；需要时用 --prepare 'pnpm install --offline' 初始化独立环境。它是工作区隔离，不是进程文件权限沙箱。

pnpm check 同时运行 TypeScript 行为测试和 PAST Python 审计测试。历史验证记录保留其日期及包数量，不能替代当前检查。

2026-10-21 验证：24 包分层检查、8 项架构规则测试、360 项行为测试及 18 项 Python 审计通过；Docker 实机测试按原开关跳过。全部 24 包独立类型检查及旧个人助理实验的 7 项回归/类型检查通过，格式检查通过，无真实模型调用。故障复现现已进入持续回归，详见 [当前架构评审](../architecture-review.md)。
