# 架构与恢复边界评审（2026-10-21）

本次以 09ee411 为检查基线，修复正确性、状态恢复、访问隔离和评测契约。当前实现及依赖以 [子包规则](dev-rules/layering.md) 为准；历史评审可从 Git 历史查看。

## 修复与回归对应

| 原问题 | 当前行为 | 回归位置 |
|---|---|---|
| 不同记忆 key 的 32 位哈希相同，后写覆盖前写 | 新条目使用 UUID，更新保留旧 ID；重复 ID 的损坏文件拒绝加载 | memory-file/repository.test.ts |
| 缺失/新增/方向改变的指标被忽略 | 指标集合、方向、有限数值及名称唯一性受校验，非法结果回滚 | evolution/pareto.test.ts、loop.test.ts |
| 拒绝候选仍成为应用目标 | 探索归档保留 stepping stones；best 与正式工作区只选择可发布候选 | evolution/loop.test.ts |
| protected 制品可通过删除或伪造版本绕过 | 要求原可信对象保留，禁止删除或替换 | evolution/loop.test.ts |
| Git 演化吞入用户改动、提案失败残留 | 独立 worktree、提案事务、原目录并发修改检查与快进发布 | workspace/git-workspace.test.ts |
| 续跑 ID 重复覆盖候选，回滚后磁盘仍错误 | 唯一提案 ID、不可变快照、提交指针原子替换和竞争提交检查 | workspace/data-workspace.test.ts |
| 多通道 scope 规则不一致 | 记忆、导入/原生历史和反思绑定宿主命名空间，显式共享只读 | memory-file/repository.test.ts、assistant/history.test.ts |
| Host 超时配置未继承 | 召回与执行共享截止时间；关闭取消活动轮次 | host/host.test.ts |
| 乱序卸载恢复已卸载服务 | 按注册身份管理服务栈，隔离上下文复制栈 | kernel/context.test.ts |
| agent 获得验收查询及预期 ID | training / selection / final-test 三类查询分离；最终测试只在选择冻结后执行 | cli/integration/evolve-holdout.test.ts |
| 流程知识无验证状态、锁崩溃后阻塞 | draft/validated/retired、宿主评估发布、历史恢复、死进程锁恢复 | skills-file/repository.test.ts、storage-file/lock.test.ts |
| 命令超时留下子进程或容器 | POSIX 进程组取消，容器使用独立名称回收 | evaluation/command-gate.test.ts、container.test.ts |
| 经验尾部损坏导致全库不可读 | 有诊断地读取完整行；写入前持锁隔离损坏尾部，保留原始坏片段 | observability/experience.test.ts |
| Python 审计未进入 CI | pnpm check 包含 test:audits，CI 固定 Python 3.11 | package.json、check.yml |

旧个人助理执行器已迁移到当前上下文 API 和统一 runTurn；反思使用完整的带来源交互，按当前证据解析后只写候选，不再把模型提取结果转成用户确认。协议标为 personal-assistant-evidence-v2，旧结果不改写。独立探针通过实验目录内的文件绑定调用公开 assistant/memory 接口，不向 host 加回旧聚合导出。

## 组织与通用接入

保留现有领域包，新增 storage-file 作为共用文件基础设施，避免锁和原子写入实现继续分叉。Host 的协议摄取/召回等待以及 ACP 的连接/内容翻译按职责拆为内部模块，不新增业务聚合大包。

HostOverrides.modelSelector 是可选模型路由接口，兼容 ModelCatalog；显式 model 优先。未知价格不会作为免费模型参与成本上限筛选。MemoryStore/MemoryService 仍作为同步兼容入口，在线调用使用 MemoryAccess/MemoryRepository，共用写入规则和持久化事务，不再新增第三套语义。

## 调用与迁移

- evolve memory --agent 必须提供 --training-queries；--queries 是影响迭代选择的开发集，不能再称为最终验收集。
- 可通过 --test-queries 指定独立终测集。只在候选选择结束后评一次，结果写入该轨迹的 final-evaluation.json，不反馈给 proposer，也不事后挑选候选。查询文本交集会拒绝，语义独立性仍需实验设计保证。
- iterate 在独立 worktree 中运行，依赖需在该环境初始化，可用 --prepare 命令。只有选中结果会快进到原目录；原目录脏或 HEAD 改变时拒绝发布。
- scope 缺省现在表示未分区空间，而非全库。已有多用户混合存储需显式整理归属；不自动移动或猜测旧记录。
- 新流程默认 draft；模型无发布权限。历史 validated 流程改写后重新进入 draft。

## 仍需专项验证的能力边界

召回/noise 仍是代理指标，最终测试报告不能证明实际任务改善。现有模型端会话历史、工具结果与 token 预算仍由 harness 负责；本轮新增的是宿主本轮输入字符上限。文件锁依赖本机 PID，面向本地文件系统，不宣称分布式锁。Git worktree 不是 OS 沙箱；POSIX 进程组取消不宣称 Windows 进程树隔离。

条件/有效期的语义执行、语义检索、多用户授权模型、经验索引及大规模存储压测继续作为独立优化项。它们不通过新增通用接口自动获得，也不以本轮单元测试替代真实模型和公开数据集验证。

## 验证

完整 `pnpm check` 通过：24 包分层校验、8 项架构规则测试、91 个测试文件中的 360 项行为测试通过，1 项 Docker 实机测试按显式开关跳过；18 项 Python 审计通过，24 个子包的独立类型检查、旧实验执行器 7 项回归与其类型检查、格式检查通过。容器清理路径另有模拟 Docker 进程测试覆盖；不将它标为真实 Docker 验证。

本轮未调用付费模型、未产生新的 PAST/RSI 分数，也未修改历史评测结果。依赖变更仅为 workspace 本地连接，第三方依赖版本未变化。
