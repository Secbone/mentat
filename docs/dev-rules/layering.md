# 子包职责与依赖规则

每个包承担一个功能边界。协议、纯领域规则、文件持久化、模型调用策略和命令装配分别管理，跨包只能使用 `package.json` 声明的公开入口。

## 子包职责

| 包 | 职责 | 生产 workspace 依赖 |
|---|---|---|
| `@mentat/core` | 统一协议、制品契约、事件、JSON工具、harness注册与测试契约 | 无 |
| `@mentat/session` | 会话执行、轨迹与经验契约、统一超时取消 | core |
| `@mentat/host` | 默认装配与资源关闭、可替换服务注入 | core、session、assistant、memory、memory-file、memory-mcp、observability、transport-pi、transport-acp |
| `@mentat/kernel` | 插件生命周期、服务容器和作用域 | core |
| `@mentat/evolution` | 提案、门、评测接口、选择、归档及演化循环 | core、kernel |
| `@mentat/models` | 模型目录、选择与模型制品 | core |
| `@mentat/memory` | 记忆类型、查询、写入规则、状态转换和上下文选择 | 无 |
| `@mentat/memory-file` | JSON记忆文件、写入审计与旧数据迁移 | memory |
| `@mentat/memory-mcp` | 记忆MCP协议与服务进程启动配置 | core、memory、memory-file |
| `@mentat/memory-evolution` | 记忆制品、记忆提案与演化评测、结果应用 | core、evolution、memory |
| `@mentat/observability` | 文件轨迹、内容存储、派生经验、摘要与查询 | core、session |
| `@mentat/workspace` | Git与JSON候选工作区、提交、恢复与回滚 | core、evolution |
| `@mentat/evaluation` | 本地命令与容器执行、命令门、外部评测器 | core、evolution |
| `@mentat/assistant` | 个人助理策略、每轮上下文、完整交互反思与显式确认 | core、memory、session |
| `@mentat/transport-pi` | Pi RPC协议、事件翻译、权限bridge | core |
| `@mentat/transport-acp` | ACP协议、事件翻译和会话管理 | core |
| `@mentat/cli` | 参数解析、终端交互、命令与引擎装配 | 按实际使用声明以上包 |

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

当前为17个功能包；上面的2026-10-15验证记录是此前15包拆分基线，重构实现和验证见 [执行、记忆与可观测性重构](../refactor-execution-observability.md)。assistant禁止依赖文件实现和终端，session只依赖core，observability实现session契约；host负责默认装配。不要让领域包反向导入host。
