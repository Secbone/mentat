# 多维度持续评测

本文记录框架设计和初版验收边界。后续公开集运行状态以 [公开评测报告](research/public-evaluation-2026-10-16.md) 和 [LongMemEval 修复复测协议](research/longmemeval-repair-2026-10-16.md) 为准；下面“没有下载或运行”等描述指初版交付时点。

日期：2026-10-16。目标是持续观察同一项目在不同公开评测集、能力维度和代码版本上的变化，并区分执行完成、评分覆盖和实际学习收益。

本次交付统一计划、原生连续任务执行、外部运行器委托、逐样本结果接入、不可覆盖记录、分维度报告及配对比较。没有下载或运行公开评测集，没有产生新的真实模型效果结论。公开集的 Mentat agent/environment 桥接均仍待逐项实现与验证；结果格式已支持不代表业务环境已接通。

## 社区框架调研与复用决定

| 框架 | 已核查的能力 | 在本项目中的用途 | 边界 |
|---|---|---|---|
| [Harbor](https://github.com/harbor-framework/harbor) | 多 benchmark、agent 接口、沙箱 provider、逐 trial verifier reward | 首选可执行任务后端；RSI-Exam、终端及代码演化 | 单任务默认隔离不能自动替代跨任务记忆与锚点协议；需封装 Mentat agent |
| [Inspect AI](https://inspect.aisi.org.uk/agent-bridge.html) / [Inspect Evals](https://github.com/UKGovernmentBEIS/inspect_evals) | dataset/solver/scorer、日志、第三方 agent 与沙箱 bridge | QA、个性化及自定义评分后端 | 原生 API bridge 会改变模型调用路径；需验证是否忠实保留 OpenCode/Pi 行为 |
| [BenchFlow](https://github.com/benchflow-ai/benchflow) | 统一环境协议、ACP agent、多轮和技能评测 | SkillsBench 及后续有状态环境 | 接口持续演进；当前通过 normalized-v1 exporter 接入，未实现专用结果适配器 |
| [PAST-Bench](https://github.com/Gen-Verse/PAST-Bench) | 顺序任务族、fresh session、持久化开关、anchor 与机制证据 | 个人助手学习主协议与公开任务来源 | 部分初始 fixture 与 telemetry 针对特定框架；改编后标为 adapted |
| [LifelongAgentBench](https://github.com/caixd-220529/LifelongAgentBench) | 连续任务流、经验 callback、技术环境 | 后续方法迁移专项的可选后端 | 不作为当前统一报告层的硬依赖 |

选择复用上游任务环境和评分器，由本项目维护跨版本、跨能力的观测层。不复刻容器调度平台，也不把所有任务降为文本问答。三个接口分别是 Subject（被测 Mentat）、Dataset/运行协议、ResultAdapter（上游结果），互不绑定具体模型。

本次核查了官方说明、[Harbor TrialResult](https://github.com/harbor-framework/harbor/blob/main/src/harbor/models/trial/result.py) 和 [Inspect 日志模型](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/log/_log.py)。适配器带独立版本；仓库契约样本是人工合成相关字段，不宣称已经通过已安装上游版本的端到端验收。本机没有安装这些外部评测框架。

## 确定采用的公开评测集

程序化清单由 `@mentat/benchmark` 的 `BENCHMARK_CATALOG` 提供，`pnpm bench list --json` 可导出来源、优先级、选题规则、运行器与集成状态。清单确定的是评测集和选样策略；每次实际评测仍须固定下载内容、任务选择和 scorer 的 revision/hash，不能用 main/latest 运行后再补版本。

| 批次 | 公开集及来源 | 能力维度 | 首轮选择和判定 |
|---|---|---|---|
| 核心 | [PAST-Bench](https://github.com/Gen-Verse/PAST-Bench) | memory、transfer、adaptation、tool-use | 四类能力各两个任务族起步，保留原有 controls/anchors；分别记录行为与机制 |
| 核心 | [LongMemEval cleaned](https://github.com/xiaowu0162/LongMemEval) | memory、adaptation | cleaned S 按提取、跨会话、更新、时间、弃答分层；oracle 只作诊断 |
| 核心 | [PersonaMem-v2](https://github.com/bowen-upenn/PersonaMem-v2) | personalization、adaptation、safety | text benchmark；按 persona 隔离，覆盖隐式偏好、更新、第三方与敏感信息 |
| 核心 | [ToolSandbox](https://github.com/apple-aiml-research/ToolSandbox) | interaction、tool-use、task-quality | 状态依赖、信息不足、规范化；保留 simulator 和最终状态检查 |
| 核心 | [tau-Bench](https://github.com/sierra-research/tau2-bench) | interaction、tool-use、task-quality | 固定修订后的文本版本与 simulator；先 retail/telecom，禁止混用 tau2/tau3 或评分修订版 |
| 核心 | [AgentDojo](https://github.com/ethz-spylab/agentdojo) | safety、tool-use | 正常任务/注入任务配对，攻击模板留出；一起观察攻击成功率与正常任务误拒 |
| 扩展 | [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | memory、adaptation、transfer | 增量输入、FactConsolidation、长程干扰及冲突 |
| 扩展 | [PersonaMem-v3](https://github.com/bowen-upenn/PersonaMem-v3) | personalization、adaptation、safety、tool-use | 时间遮罩用户世界、偏好生命周期、过度个性化；衍生数据非商业许可需核查 |
| 扩展 | [MemoryArena](https://github.com/ZexueHe/MemoryArena) | memory、transfer、tool-use、task-quality | 多会话依赖任务；先预检 preview 环境与依赖，再按任务深度报告 |
| 扩展 | [SkillsBench](https://github.com/benchflow-ai/skillsbench) | transfer、task-quality、efficiency | 固定 v1.1 roster；办公、财务、工程，区分专家技能与自行学得技能 |
| 扩展 | [RSI-Exam](https://github.com/aiming-lab/RSI-Exam) | self-improvement、transfer、task-quality、efficiency | 先公开 memory/workflow 任务；冻结开发/验证/隐藏测试与提交制品；私有全量需上游访问 |

另保留 Mentat 自建跨职业连续任务（adapted 轨道），不替代公开集。observability 与 efficiency 是跨集维度：每个运行都报告执行状态、评分覆盖、成本覆盖，不能只算答案准确率。LongMemEval-V2 和 Mem2ActBench 留为下一批调查对象，当前不扩大核心接入范围。

## 包边界

- `@mentat/benchmark`：纯契约、运行时数据校验、能力清单、连续任务调度、规则评分、聚合和配对分析；无 Node、host、模型、文件或容器依赖。
- `@mentat/benchmark-file`：上游结果适配器注册、文件与摘要、外部命令委托、Markdown/CSV；依赖 benchmark 与现有 evaluation 执行器。
- CLI：`bench` 命令和 Mentat Subject 装配；从公开 host 入口运行，使用新类型确认接口。
- `@mentat/evaluation`：原有演化门和命令/容器执行职责不变，不承载公开数据集语义。

## 运行计划与数据契约

`RunPlan` 固定以下信息，完整示例在 [native-plan.json](../benchmarks/examples/native-plan.json)：

1. benchmark id/version 与 track：`upstream`（保持上游协议）、`adapted`（改编）、`smoke`（合成连通性）。本地规则执行器禁止 upstream；fake 禁止冒充真实结果。
2. dataset revision、SHA-256、split 与来源。原生执行对实际数据文件字节校验；外部导入中的 dataset 身份是操作者声明，须由上游桥接器核验，不能把输出文件的摘要当作数据集摘要。
3. scorer id/revision/config；原生执行额外记录实际评分函数指纹。修改评分方式后必须换版本，旧结果不能覆盖。
4. protocol id/revision/config、arm、host 调用上限与每轮 timeout。config 应包含输入/prompt 策略、环境、权限、确认、用户模拟器和隔离约定。原生调度器记录自身指纹；宿主策略属于被测制品，用实际代码指纹追踪。
5. subject 的项目 revision、实际代码指纹、harness/model 及版本。原生执行捕获 tracked/untracked 非忽略文件与删除状态；导入结果不能自动核验这些声明，也不能证明提供方实际使用了所声明模型。
6. 指标 id、能力维度、方向、单位、可选边界和上游 score 字段；不能从名称猜测正负方向或把字符串自动转为数值。
7. **预先登记的全部 trial**：caseId、familyId、arm、repetition、sourceId、metricIds。学习任务可以不评分。遗漏、失败和跳过不能从分母中删除；每个计划内未知评分保留 null 和原因。

结果包含逐 trial 状态、各项 measurement、证据位置、耗时与费用；缺失费用是 null，不是免费。规范格式可用 TypeScript 的 `TrialResult[]` 或 JSONL，每行一条。`ResultAdapterRegistry.register()` 增加新来源，无须修改调度器、聚合或存储。

## 可运行入口

```bash
pnpm bench list
pnpm bench validate --plan benchmarks/examples/native-plan.json --dataset benchmarks/examples/episodes.json
pnpm bench:smoke
```

`bench:smoke` 默认创建新的 `.mentat/benchmarks/smoke-<时间戳>`。只使用 fake，运行两次八任务原生序列、导入两种上游契约样本，验证同版本比较、报告与趋势。它不证明个性化收益。

单独运行原生序列：

```bash
pnpm bench run --plan benchmarks/examples/native-plan.json --dataset benchmarks/examples/episodes.json --out .mentat/benchmarks/native-001
pnpm bench report --run .mentat/benchmarks/native-001
pnpm bench arms --run .mentat/benchmarks/native-001 --baseline reset --treatment explicit
```

原生 runner 每任务新建 host/session，同一 arm/family/repetition 复用独立状态；reset 每任务独立。任务内的显式用户确认三组都可使用，重置只改变跨任务保留。`explicit` 不反思，`reflect` 使用完整历史反思且保持生产候选隔离。确认必须提供 kind，不能从评分标签推断用户规则。

被测 subject 只收到 allowlist 后的当前输入；checks、答案和未来任务不会传入 host。原生只支持确定性 exact/includes/json-equals 回归评分与顺序状态分支；自然语言质量、anchor/fork、自适应用户交互和真实工具状态应接上游环境或新增明确版本的插件，不能将 includes 称为语义成功率。

真实模型计划需要改为 adapted，显式指定 harness/model/version 和限额。原生权限固定 deny、记录协议日志，只用于宿主记忆诊断；不会开放 execute 来模拟工具环境。独立目录与权限回调不构成文件系统安全边界，含隐藏答案的正式任务必须交由上游沙箱提供读取限制。host 调用预算不是引擎内部模型请求上限；费用覆盖不全时不声称账单硬限额。

导入上游逐样本输出：

```bash
pnpm bench import --plan benchmarks/examples/harbor-plan.json --adapter harbor-trials-v1 --input benchmarks/examples/harbor-trials.json --out .mentat/benchmarks/harbor-fixture-001
pnpm bench import --plan benchmarks/examples/inspect-plan.json --adapter inspect-json-v1 --input benchmarks/examples/inspect-log.json --out .mentat/benchmarks/inspect-fixture-001
```

- Harbor：读取单步 TrialResult 数组、单个 trial 或 job 目录下的 `*/result.json`。忽略 job aggregate；`trial_name` 显式匹配唯一 sourceId，同时核对 task_name/caseId；reward 字段由 metric.source 指定。官方默认 trial_name 带随机后缀，桥接器应在执行前构造/保存 resolved TrialConfig，固定名称并生成计划；不能看分数后改 trial 绑定或挑选重试。异常记录不能贡献成功分。多步 trial 尚未支持，明确拒绝，不能把 step 平均当作任务成功。
- Inspect：读取保留 samples 的 version=2 EvalLog JSON，其他 schema 明确拒绝；sourceId 为 `sample.id:epoch`。score.source 指定 scorer 名或 `scorer.key`；C/I/P 等符号须显式 valueMap。缺少 score 或 incomplete sample 保持未知。`.eval` 归档先使用上游 `read_eval_log` / `write_eval_log` API 导出 JSON；当前不直接读取压缩归档。
- 其他框架：保留原生 scorer，输出 normalized-v1 的逐样本结果；新增格式可注册 ResultAdapter。禁止仅凭汇总 mean 生成虚假的逐题记录。

委托外部框架运行时，计划与 job 分开：

```json
{
  "command": "harbor",
  "args": ["run", "--config", "/absolute/path/pinned-mentat-job.yaml", "--jobs-dir", "{runDir}/upstream"],
  "cwd": "/absolute/path/upstream-checkout",
  "timeoutMs": 600000,
  "adapter": "harbor-trials-v1",
  "resultPath": "{runDir}/upstream"
}
```

以上是 job 结构示意；Harbor CLI 参数需对安装的固定版本使用 `harbor run --help` 核对，Mentat agent/config 需先完成桥接。没有预置一个可直接运行官方集的 Mentat Harbor agent。

```bash
pnpm bench external --plan /path/to/plan.json --job /path/to/job.json --out .mentat/benchmarks/public-001
```

使用 argv 执行，不提供 shell 字符串；凭据由环境继承，不写进 job/plan。仅替换 `{runDir}`。结果路径必须位于本次新建运行目录，防止旧成绩误充本次输出；同时留存 stdout、stderr、命令元数据与事件。超时或缺少输出也生成失败记录，所有计划任务保持可见。job 指纹参与可比性判断。外部框架负责它自己的模型/token/费用预算；本层只实施进程 timeout，不假称能限制其内部 API 调用。

## 持续观察与比较

每个运行目录保存 `plan.json`、`source.json`、`run.json`、`report.md`、`integrity.json` 与事件；原生运行另存完整输出、轨迹、记忆前后快照和反思操作。独占创建目录，不覆盖、静默续跑或挑最好的一次。文件摘要用于发现意外损坏，不是签名或防篡改安全保证。

```bash
pnpm bench compare --before .mentat/benchmarks/release-a --after .mentat/benchmarks/release-b
pnpm bench history --root .mentat/benchmarks --csv > /tmp/mentat-benchmark-trends.csv
```

history 的 root 直接包含运行子目录；冒烟的外层目录是集合，应将其作为 root 单独查看。无法读取或不完整的运行会报错，不在导出中静默消失。CSV 一行对应 benchmark/arm/metric/run，含能力维度、覆盖与兼容 cohort；不同 cohort 不应连成同一优化曲线。

跨版本比较允许被测项目 revision/code 指纹变化，要求 dataset、任务选择和顺序、scorer、protocol、model/harness/config、结果 adapter 及外部 job 指纹一致。若不一致，返回不可比较及差异项（CLI exit 2），不计算提升百分比。更换模型是新实验 cohort。导入的数据身份仅是声明，自动检查不能代替上游版本与 bridge parity 验收。

每个 metric 先在任务族内平均，再对任务族宏平均；不把大任务族或对话轮次当成更多独立用户。配对差值只使用两侧均有评分的同任务重复，报告 planned/paired/unpaired 和两侧失败覆盖；缺失多时不能把 available-case 差值解释为总体收益。置信区间按任务族 cluster bootstrap；少于两个任务族不出区间，少量任务族仍只适合试点。无需跨 benchmark 混合为一个总分。

## 后续接入验收

每接一个公开集，依次完成：固定任务内容与哈希 → 接入 Mentat subject/tool/environment → 保留原始 scorer → 检查 oracle 能通过、错误输出会失败 → 验证隐藏材料不可读 → 保存完整原生结果 → 转换并校验 trial 覆盖 → 小样本对齐上游结果 → 才把清单状态改为已接入。不能仅因安装成功或 importer 能解析就标记完成。

主对照为 reset / explicit / reflect。反思候选未激活时，先评价候选证据质量、污染和成本；需要验证生效后的潜在收益时另设审核确认组，记入审核成本，并标为辅助确认学习。普通偏好与高风险规则不能共享一个自动激活门槛。代码演化另设冻结开发/验证/隐藏测试、版本制品和回滚；两个以上代际才讨论改进下一轮自改的能力。

主指标分开报告任务可用率/客观错误、配对学习收益、用户纠正负担、近远迁移、更新延迟、例外/恢复、反思精确与覆盖、污染/越权、正常任务误拒、成本与延迟，以及可观测性覆盖。当前框架保存这些独立 measurement，不假称已为每个维度实现业务评分器。新增检查需提供已知正反例，主观项使用盲化复核；模型自评不能成为唯一证据。

## 验证命令

```bash
pnpm test:benchmarks
pnpm check
pnpm -r typecheck
pnpm bench:smoke
```

框架初始冒烟：`pnpm check` 通过19包分层检查、7项架构测试、63个测试文件中的242项行为测试，1项Docker测试默认跳过；19个子包独立类型检查通过。端到端冒烟完成16个 fake host 任务、4条合成上游契约记录、同版本配对比较与趋势导出。该初始冒烟没有执行上游框架或付费模型，不能将这些记录解释为公开评测成绩。

2026-10-16 的预检与首轮真实模型试点见[统一评测报告](research/unified-evaluation-2026-10-16.md)。原生评分新增 `json-criteria`，要求完整 JSON，可核验字段相等、数值边界和顶层字段集合；条件反馈只在先前回答未满足指定结构时执行，`runtime.correctiveTurns` 记录实际纠正轮次。业务评分与 `reflection.status` 独立，反思异常不阻断业务对照。真实 ACP 计划可设置 `isolateOpenCode` 和 `requireModelConfirmation`，逐任务保存请求/实际模型确认与只读原生会话账目；无法核验的费用保持未知。公开 Oracle 试点是独立的 adapted 阅读诊断，公开集主清单的完整上游接入状态没有因此改变。
