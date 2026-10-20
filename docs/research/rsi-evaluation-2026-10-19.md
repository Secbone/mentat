# RSI 能力首轮诊断：PAST 连续任务与原生演化循环

日期：2026-10-19。结论：**本轮尚未观察到可验证的 RSI 收益。现有离线演化循环可以生成、评估、接受和回滚记忆候选，但这次接受的改进没有进入实际助手默认使用的活跃记忆；个人助手路径也尚未接入自主机制改进的多代闭环。**

完成 120 个公开任务试验尝试，其中 118 个产生上游评分，2 个达到单题 180 秒上限；另完成 3 次真实模型演化提案。全程使用 OpenCode 2.0.25 / `opencode-go/deepseek-v4.1-flash`。这是受控诊断，不是完整 PAST 榜单成绩，不是三代 RSI 已实现的证明。机器结果见 [rsi-diagnostic.json](../../benchmarks/past-bench/results/2026-10-19-rsi-diagnostic.json)。

## 1. 本轮到底测试了什么

两条证据链分开：

1. **真实连续任务**：使用 PAST-Bench 的公开原题、实际 mock 服务、原始任务顺序及 anchor/fresh 分支，观察任务执行、记忆写入、反思及后续使用。
2. **现有演化循环**：直接调用 `evolve memory --agent --from-experience --iterations 3`，核对候选接受、回滚和应用到 live memory 后的可见性。

主评测为 `adapted` 协议：本项目维护调度与工具桥，调用上游任务定义、HTTP dispatcher 和原始 grader；不是上游 Hermes agent。上游 revision 为 `f8223517ae7491e776b69793d9f11e9d074ab42e`，Mentat 基于 `834b0b1` 加新增评测脚本。每个运行在首次调用前保存 task/scorer 文件摘要、源码归档、完整 trial roster、模型、预算及协议版本。

PAST 三组均使用相同模型、任务输入和工具权限，每个任务新建引擎会话：

- reset：每个任务清空原生记忆及经验状态；任务内部仍允许使用记忆工具。
- memory：按上游 continue/from_anchor/fresh 规则保留或恢复原生状态，不额外触发反思。
- reflect：在 memory 基础上，学习回合最终正常结束时调用原生反思；不自动激活候选、不使用评分反馈。

**reflect 是现有反思组，不是“允许自主修改代码/提示策略”的完整自改组。** 本轮未开放任意 shell、源码修改或外部搜索；公开任务只允许声明的环境工具与原生记忆工具。它可以评估经验学习链路的现状，不能用“没有发生代码修改”推断系统在允许自改的设置中也不能改进。

## 2. 数据量与覆盖

| 任务族 | 能力 | 每组回合 | 三组试验数 |
|---|---|---:|---:|
| SM01_preference_adoption | 学习并保持格式偏好 | 8 | 24 |
| SM02_constraint_retention | 保持内部分享边界与约束 | 8 | 24 |
| PC03_latent_rule_induction_01 | 从案例中归纳迁移风险规则 | 7 | 21 |
| PC04_failure_to_rule_01 | 从失败中提炼并复用处理流程 | 9 | 27 |
| 合计 | 4 个完整任务族 | 32 | 96 |

每组有 8 个近/远迁移评测回合。另以 SM01 的同 8 题做一次独立三组诊断，共 24 次尝试，统一允许一次纯格式纠正。它是新运行，不拿旧答案择优替换。

原先预选的 PG01、PG04、SM03、SM06 依赖 Hermes 专属 memory/skill/session 预置 fixture，未通过原生映射验收，未运行；不能声称本轮覆盖了完整主动检索、事实更新或临时例外能力。LongMemEval、PersonaMem 和 OpenViking 均未混入本轮被测方法。

## 3. 主评测：96 次尝试

| 组别 | 已评分/计划；超时 | 通过输出契约 | 迁移严格通过/计划 | 学习阶段最大 active 数 | 迁移上下文注入条数 | 原生记账费用 |
|---|---:|---:|---:|---:|---:|---:|
| 每任务重置 | 32/32；超时 0 | 16/32 | 0/8 | 0 | 0 | $0.039062 |
| 保留原生记忆 | 31/32；超时 1 | 9/32 | 0/8 | 0 | 0 | $0.042656 |
| 保留记忆＋学习回合反思 | 32/32；超时 0 | 9/32 | 0/8 | 0 | 0 | $0.038840 |

“通过输出契约”只表示最终回答非空且没有检测到工具协议文本，不代表业务正确。主评测共 34 次通过输出契约、58 次泄漏工具协议文本、3 次空回答、1 次超时。三组迁移严格通过均为 0/8，其中 memory 的 1 题超时没有上游分数，但仍保留在计划分母。

实际环境工具执行回执共 **197 次**，原生记忆搜索尝试 **167 次**。因此这轮并非没有工具执行；部分任务执行过工具，随后仍输出非法最终回答或未完成任务。不得从 DSML 文本推定工具已执行，也不得从最终回答非法推定整个任务从未调用工具。

反思组实际完成 2 次反思，新增 3 条候选；其余符合学习阶段条件但最终未正常结束的回合没有触发反思。CLI 的普通 `--reflect` 可以处理失败结果，本协议没有完整覆盖该路径，因此不能据此断言失败反思本身无效。

评分采用原始 grader、无 LLM communication judge。上游 task_score 的基础项是 `0.8 × completion + 0.2 × robustness`，随后乘 safety，并有机制门和严格条件。**0.2 不等于完成了 20% 的任务**；没有工具错误也可能得到 robustness 分。PC03/PC04 要求 skill 创建/读取证据，本轮 Mentat 工具面未提供该基质，相关分数同时反映能力/接入边界，不能全解释为业务推理错误。

## 4. 格式纠正诊断：24 次尝试

仅对非法最终回答做一次现有框架的纯格式纠正；不向模型提供正确答案、grader 判断或任务提示重写。

| 组别 | 已评分/计划；超时 | 首答通过输出契约 | 最终通过输出契约 | 迁移严格通过/计划 | 学习阶段最大候选数 | 原生记账费用 |
|---|---:|---:|---:|---:|---:|---:|
| 每任务重置 | 8/8；超时 0 | 4/8 | 8/8 | 0/2 | 1 | $0.018570 |
| 保留原生记忆 | 8/8；超时 0 | 2/8 | 8/8 | 0/2 | 1 | $0.013075 |
| 保留记忆＋学习回合反思 | 7/8；超时 1 | 6/8 | 7/8 | 0/2 | 1 | $0.010232 |

本组发生 12 次格式纠正，其中 11 次最终得到通过输出契约的回答，另 1 题超时。最终 23/24 次通过输出契约，但三组迁移严格通过仍都是 0/2。不能将“格式变正常”当作学习收益，也不能把两次独立运行中的变化全部归因于纠正：本轮没有多次重复。

代表例：memory 组的 `SM01_LEARN_A_001` 实际执行了记忆写入，任务综合分达到 1.0，严格验收仍失败。写入记录是未确认候选；后续默认上下文注入为 0。reset 组也在当前任务中成功写入过候选，但下一任务按协议重置。两者都不能据此声称跨任务学习已成功。

## 5. 三次真实模型提案：离线分数与实际生效错位

输入来自本轮 SM02 的真实交互轨迹，不使用 expectations、参考答案或未来任务。开发侧有 2 个查询及其 expected ID；另外 2 个同事实改写查询只在评测侧使用。调用的是现有 `evolve memory`、`AgentDataProposer`、`memoryGate`、`SelfIterationLoop` 和 `applyEvolvedMemory`。

| 阶段 | 开发 ID 召回代理值 | 额外改写查询召回 | 选择结果 |
|---|---:|---:|---|
| root 空记忆 | 0 | 0 | 基线 |
| 提案 1 | 1 | 1 | 接受 |
| 提案 2 | 1 | 1 | 不优于当前，回滚 |
| 提案 3 | 1 | 1 | 不优于当前，回滚 |

这是 **3 次提案、1 次接受、2 次回滚**，不是 3 代持续提升。ID 召回仅是现有评估器的代理指标，不验证事实正确、来源可信或用户任务质量；改写查询也不是未见任务族。

接受结果通过 `MemoryService` 写入 live memory 后：

- 实际保存 2 条，candidate=2、active=0。
- 两个查询按生产 MCP 的 `statuses=["active"]` 搜索，均为 0 条。
- 宿主 `memory.context()` 的选择条数也均为 0。
- 底层 `MemoryAccess.search()` 不传 statuses 时能查到候选，分别返回 2/1 条；这与 MCP 默认仅查 active 的语义不同。底层命中率不能代替生产召回验收。

额外核对发现，这两条 live 记录都被保存为 `method / inference / assistant`，没有 `evidenceSources` 或 `applicability`。现有离线提案提示只要求 id/text/createdAt，agent 写回分支统一使用 method，证据只关联 evolve 存储；不能据此确认原始用户规则的类型、范围和来源。建立自动生效门之前，需要保留这些信息。

因此，本轮可以确认离线提出—评估—选择—回滚—保存的机械流程能工作；**不能确认接受结果已经改善下一次真实任务。** 核心差异是离线 `memoryArtifact` 将提案条目直接放入评估 store，而 live application 将 agent 推断写成 candidate；运行时不会默认使用这些条目。这不意味着应取消候选保护。

`evolve` CLI 没有转发 ACP 模型诊断/协议回调，初始汇总因此拒绝“模型已验证”的声明并退出 1，但三次提案和 live apply 已完成。随后按该实验独占 cwd 定位 3 个原生 session，逐条核对 assistant message 的 provider/model 和记账，确认均为指定 DeepSeek；没有补跑提案。独立分析保留原始产物。首版离线分析把不带 status 的查询称作 visibleResults，后续明确拆为 activeResults / allStatusResults / contextSelected，以 `summary-verified.json` 为准。

## 6. 对 RSI 的判断与优化顺序

本轮支持三个判断：

1. **执行可靠性仍是前置瓶颈。** 原生调用与文本化调用混杂，纯格式纠正只能修复部分交付问题，不能保证任务真的执行；需要同时看工具回执、有效结果、限时完成和首答。
2. **离线接受与线上可用之间存在明确断点。** 用户明确保存请求缺少在本评测自然语言路径中转为受信 typed confirmation 的环节；推导出的流程/技能也缺少经过独立验证后生效的通道。`/remember-preference` 等可信入口是已有能力，不能把本轮结果推广为所有确认路径都不可用。
3. **自主多代机制改进尚未在个人助手路径中验收。** 现有 `iterate` 有候选、门、选择与回滚，但本轮助手/反思运行没有调度它。单独运行的记忆演化也没有改变改进器策略，只得到一轮数据改进。

建议依次处理：

- **P0：让进化评估走真实运行路径。** 验收应包含 active 搜索、上下文注入、实际后续任务及回退；保留 candidate 与 active 的区别，不能只对原始 artifact 算 expected-ID 命中率。
- **P0：建立受信的生效门。** 用户规则用明确来源、类型、作用域和确认；推导出的 method/skill 用独立验证、版本化、回归门及回滚。不能把 assistant 建议、工具文字或全部候选一键提升为用户偏好。
- **P0：稳定工具协议与预算退出。** 只接受真实工具事件，不模拟执行 DSML；限制重复空检索；将任务超时与基础设施失败分开，自动继续未尝试的 roster，保留全部失败。
- **P1：接通自主机制迭代并补齐观测。** 任务失败证据→受限 prompt/检索/skill 候选→开发/验证门→生效→下一轮；记录实际 provider/model、制品版本、接受原因和后续收益。特别补 `evolve` CLI 的原生模型/协议采集。

下一轮正式 RSI 实验应有真正的冻结、仅记忆、允许受限机制自改三组；开发、验证与未见任务族隔离，总预算计入反思和自改成本，多次重复。至少观察多个实际接受的版本及其留出任务表现；“提案次数增加”“记忆数量增长”或“开发 ID recall=1”均不能作为 RSI 成功标准。

## 7. 完整性、费用与限制

- 主评测 96/96 个计划试验均已尝试，95 个有评分，1 个超时。诊断 24/24 均已尝试，23 个有评分，1 个超时。没有 missing，没有重跑已有题后择优替换。
- 主评测在 `V2_F07_I04 / memory` 超时后保留原行，按冻结 manifest、状态 anchor、模型和 180 秒预算，只继续剩余 13 个未尝试任务。诊断超时在最后一题，无剩余任务。
- 两份审计均通过：主评测 98 个原生 session、197 条环境执行回执、5,846 个协议 frame；诊断 26 个 session、24 条回执、1,797 个 frame。诊断中另有 1 次 native failed 调用没有上游回执，明确标为执行前失败，不算成功调用。
- 所有模型可见 query 与原始 task prompt 相等，工具 schema 与任务清单相等；reset 空状态、from_anchor 恢复内容、固定 task/scorer 和被测执行代码摘要均核对通过。诊断源码归档中的独立离线分析脚本在运行期间完善，变更单列；它没有被 subject/controller 导入，被测执行文件未变。
- 模型侧只开放声明工具，禁止外部搜索和文件/shell 工具。没有 OS 级网络隔离或训练污染排除的证明。任务内含今天/固定日期，而实际引擎日期为 2026-10-19；部分模型因此对四月 fixture 提出合理澄清。原题和评分未修改，不将这类歧义全部归为记忆错误。
- 每组仅一次运行，任务族少；反思只对正常结束的学习回合触发、额外消耗预算，并非等总预算的完整 RSI 因果实验。本轮不与论文/其他模型或项目的成绩直接计算提升。
- 原生记账：主评测 $0.120558792，格式诊断 $0.041877054，三轮提案 $0.002464992，全部预检 $0.004249416，合计 **$0.169150254**。这是 OpenCode 账目，不是独立供应商账单或订阅边际成本；含两个超时试验，覆盖完整。
- 完整 `pnpm check` 通过：8 项架构检查、286 项测试通过、1 项跳过，类型与格式检查通过；新增 Python 文件编译通过。结束时宿主约 73 GiB 可用，高于 30 GiB 预留线；没有删除原有数据、模型或缓存。

## 8. 复现与证据

入口：[rsi_probe.py](../../benchmarks/past-bench/rsi_probe.py)、[受限任务 subject](../../scripts/past-rsi-turn.ts)、[继续未执行试验](../../benchmarks/past-bench/resume_rsi_probe.py)、[分析](../../benchmarks/past-bench/analyze_rsi_probe.py)、[审计](../../benchmarks/past-bench/audit_rsi_probe.py)、[三轮演化](../../scripts/rsi-memory-loop-probe.ts)、[独立核验](../../scripts/analyze-rsi-memory-loop.ts)。

已安装、固定 revision 的上游源码与 Python 环境是前置条件；所有运行使用新目录，不覆盖既有结果。示例：

```bash
.mentat/venvs/public/bin/python benchmarks/past-bench/rsi_probe.py --out .mentat/public-evaluations/past-rsi-new --timeout 180 --port-offset 12000
# 仅在已知任务超时导致中断后继续未尝试项目，禁止重试原失败题：
.mentat/venvs/public/bin/python benchmarks/past-bench/resume_rsi_probe.py --run .mentat/public-evaluations/past-rsi-new
# 单独生成格式纠正对照的受控源码副本；已有文件只核对，不覆盖：
python3 benchmarks/past-bench/prepare_corrective_probe.py
.mentat/venvs/public/bin/python .mentat/past-rsi-corrected.py --out .mentat/public-evaluations/past-rsi-corrective-new --families memory_ability/SM01_preference_adoption --timeout 180 --port-offset 13000
```

本机原始证据目录：

- `.mentat/public-evaluations/past-rsi-20261019-v2/`：冻结计划、完整结果、任务前后记忆、anchor、工具回执、原生轨迹、审计及恢复回执。
- `.mentat/public-evaluations/past-rsi-corrective1-20261019-v1/`：独立格式诊断及超时原记录。
- `.mentat/public-evaluations/rsi-memory-loop-20261019-v1/`：三次原始候选、选择/回滚、live memory、原生记账及 `summary-verified.json`。
- `past-rsi-smoke-20261019-v1/v2/v3` 和 `past-rsi-20261019-v1`：路径预检失败、两次真实冒烟、启动探针失败，均保留；首次路径预检没有模型调用。它们不进入正式任务分数。

原始历史、完整源码归档、运行 token 和全量 trace 仅留在忽略目录；仓库保存精简结果与本报告。
