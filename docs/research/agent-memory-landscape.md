# 代理记忆技术调研：现状、可解与不可解

> 目的：调研当前（2026）主流 agent 记忆技术与项目，并**逐条对照**
> [`personal-assistant-optimization-plan.md`](personal-assistant-optimization-plan.md) 中列出的问题，
> 回答"业界现在怎么做、哪些能解、哪些暂时解不了、我们该怎么落"。
> 方法：Web 检索 + 代表性论文/项目。**基准数字多数为厂商自测，见 §6 警告。**

## 1. 全景

### 1.1 通用四阶段框架
学界已把 agent memory 拆成统一四阶段（"Memory in the LLM Era", arXiv 2604.01707）：

1. **Information Extraction**：直接归档 / 摘要式抽取 / 图式抽取（LLM 抽实体关系三元组 + 时间元数据）。
2. **Memory Management**：`Connect`（关联链接/结构边）、`Integrate`（摘要/抽象）、
   `Transform`（分层转移/社区形成）、`Update`（规则或 LLM 驱动）、`Filter`（内容或使用率驱动）。
3. **Storage**：Flat / Vector / **Graph（含 Temporal Graph）** / Hierarchical（树/多粒度）。
4. **Retrieval**：Lexical（BM25）/ Vector / **Structure/Graph traversal**（多为**混合**）。

**领域共识**：严肃 agent 通常需要**两个检索形态**——向量答"用户告诉过我什么"，图（时序）答"什么时候为真/变了"；
把两者塞进一个索引是常见错误（会静默累积矛盾）。混合检索（embedding + BM25 + 图遍历，检索期不调 LLM）是生产首选。

### 1.2 代表项目速览
| 项目 | 形态 | 存储 | 关键机制 | 适合 |
|---|---|---|---|---|
| **Mem0 / Mem0g** | 记忆 API | Vector(+Graph) | 提取→冲突检测→`ADD/UPDATE/DELETE/NOOP`；user/session/agent 三作用域 | 个性化、快速上手 |
| **Letta (ex-MemGPT)** | agent 运行时 | 分层(core/recall/archival) | agent 用工具自编辑记忆；**sleep-time compute**（空闲时第二 agent 重写 core） | 长跑自治 agent |
| **Zep / Graphiti** | 时序知识图 | **Temporal KG** | **双时间轴** `valid_at/invalid_at` + `created_at/expired_at`；矛盾**失效不删除**；episode 级来源；混合检索 | 会变化的事实、审计 |
| **A-MEM** | 研究 | Zettelkasten 链接网 | 新笔记自动建链并**回改旧笔记**，网络演化 | 关系推理 |
| **Cognee** | 库 | Vector+KG | extract-cognify-load，可自托管 Postgres | 数据主权 |
| **LangMem** | SDK | 后端无关 | semantic/episodic/procedural + 后台 manager | LangGraph |
| **MemoryOS / MemTree / MemOS / LightMem / MAGMA** | 研究 | 树/多粒度/多图 | 分层摘要、使用率过滤、多图时序遍历 | 长对话基准 |
| **Mnemosyne** | 本地库 | SQLite | 分层 + 零云依赖 | 单机/自托管 |
| **SCM (Sleep-Consolidated Memory)** | 研究 | 语义图 | 工作记忆上限 + **NREM/REM 睡眠固结** + 价值遗忘 + 自模型 | 生物启发参考 |
| **FadeMem / Oblivion** | 研究 | 分层 | **衰减式遗忘**（按可访问性，不删除）；访问频率/效用调制 | 抗信息过载 |
| **RD-Forget** | 研究 | archive + view | **分离"存什么"与"用什么"**；同槽替换抑制过期值、按意图再激活历史 | 知识更新 |
| **Auto-Dreamer** | 研究 | typed bank | **离线区域重写**：旧条目仅作证据，只有被重新综合的信息存活；反事实掩码估效用 | 跨会话固结 |
| **Agent Zero Memory** | 研究 | 三路并行 | episodic 时间线 + 关系图 + **citation-locked 分层文档记忆**；来源/时点/证据指针 | 引用不编造 |
| **MAP-Graph / PPMF** | 研究 | typed execution graph | **provenance 作为操作信号**：权限过滤 + 路径信任 + 风险门；防"provenance laundering" | 多 agent/安全 |
| **SpeakerMem-R1** | 研究 | 双轨 | **说话人标注**的逐字消息 + 派生状态（人级/群级） | 多方对话 |
| **VeriFin / ProvenanceGuard / LedgerMind / TRACER** | 研究 | — | 对**声明**做来源级/证据级校验（见 §2 P5） | 事实/数值校验 |

### 1.3 三个范式
- **Vector-first**（Mem0、Vertex Memory Bank）：便宜、快、强于"用户偏好"。
- **Graph/Temporal-graph**（Zep/Graphiti、Cognee）：贵、强于"何时为真、如何变、审计"。
- **Runtime/tiered**（Letta）：不是库而是运行时，agent **自编辑**记忆 + 空闲固结。

---

## 2. 对照本文档的问题清单：SOTA 怎么做、能解到什么程度

> 下表把 `personal-assistant-optimization-plan.md` 的问题逐条映射到业界做法与落地建议。

| # | 文档问题 | 业界做法 | 能解？ | 对我们的建议 |
|---|---|---|---|---|
| P1 | 区分**材料事实/推断/建议行动/已完成行动** | 类型分层是核心原则：Agent Zero 的 **P1 Layering**（原始源 / 蒸馏记忆 / 推断经验**类型隔离**）；RD-Forget 分离 stored vs used | **可解**（靠 schema + 类型纪律） | 记忆加 `kind/basis`（用户明确/工具观察/推断）；"已完成行动"必须绑定**工具结果证据**，否则降级为建议/待办 |
| P2 | **证据定位到说话者与具体消息；区分用户确认 vs 助手建议** | 这是 2026 最成熟的方向：Agent Zero **citation-lock**（只能引用真正打开过的证据）；Mnemoverse/PROV-O **typed source link**（agent/principal/evidence/derivation，且冲突后仍保留败方）；SpeakerMem-R1 **说话人标注**；MAP-Graph 操作化 provenance；MemMark/PPMF 处理"provenance 洗白" | **可解**（写时记来源，读时锁引用） | 每条记忆带 `evidence{消息 id, 说话者, 片段, 工具调用}`；**主机校验来源存在性与角色**，不许模型自称"来自用户"；用户确认与助手建议分 `status` |
| P3 | **语义重复合并、按稳定规则更新** | Mem0 的 `ADD/UPDATE/DELETE/NOOP` 冲突检测；Zep **边去重 + 实体消解**（LLM 判 duplicate/contradicted）；A-MEM 回改已链接笔记；Auto-Dreamer 区域重写 | **可解** | 引 `key`（稳定规则键，措辞变不新建）+ 新写入前"检索相似→LLM 判 merge/update/contradict"；与我们 `mem-<hash>` 文本去重互补 |
| P4 | **必要约束的预算保障 + 主机补查** | Context engineering 已成独立学科：**lost-in-the-middle**（U 形注意力）、**context rot**（远未到上限就退化）；Gamage 2026：**省略型约束随深度衰减**（turn5 73%→turn16 **33%**）；对策=**constraint pinning**（每次调用从持久层取回、注入**系统提示顶部**）+ JIT 检索 + 压缩 + 子代理 | **可解**（且有量化依据） | 必要约束单独集合、单独预算、**顶部注入**；预算不足由**主机**补查/缩减/澄清（文档已要求）；用 `constraint_adherence@depth` 做信号 |
| P5 | **专业正确性 vs 偏好遵循分别验证** | 有专门"验证器"线：LegalMind/**LedgerMind**（结构化证据账本 + 实体/数值包含校验，防"引用却编造"）、**VeriFin**（XBRL 事实 + Z3 求解，**零误收** + 弃权）、**ProvenanceGuard**（来源级归因校验，防 cross-source conflation）、**TRACER**（句级 provenance，Quotation/Compression/Inference + 反事实去证） | **部分可解**（可客观化的可解） | 分两条：确定性规则（计算参数绑定来源、单位/舍入、排程校验）先行；模型复核**按需**（业务承诺/复杂口径），并计量其"防错 vs 成本" |
| P6 | **`recallTask` noise 不能作自动遗忘依据；优先软归档** | 遗忘已有强 SOTA：**FadeMem/Oblivion**（按**可访问性衰减**，不删，可再激活）、**SCM**（价值阈值 + NREM/REM）、**RD-Forget**（分离存储与使用，同槽替换）、**Auto-Dreamer**（反事实掩码估效用 + 区域重写） | **部分可解**（机制可解，"最优遗忘"未解） | **不硬删**：decay/软归档 + 回收站；效用用**反事实/消融**而非"是否在考卷里"；工作集与评测集分离 |
| P7 | **并发/原子写入、损坏恢复** | 工程问题，非热点研究；Graphiti/Zep 走事务；常见做法=锁 + 版本比较重试 + 临时文件原子替换 | **可解** | 已在文档要求；实现为 MemoryService 的统一持久化策略 |
| P8 | **作用域/有效期/时序** | **Zep/Graphiti 双时间**（`valid_at/invalid_at` + `created/expired`），**失效不删除**，可"as-of date"查询；Mem0 三作用域；RD-Forget 同槽替换 | **可解**（成熟） | 记忆加 `scope/condition/validity(起止+时区)`；冲突时**关闭旧条有效期**而非删；临时覆盖到期解除 |
| P9 | **检索（关键词→向量）+ 长会话轮换** | **混合检索**是标准（embedding + BM25 + 图遍历，检索期不调 LLM，Zep P95 300ms）；长会话=compaction + **会话轮换**（种子含任务态/未完成项/有效约束） | **可解** | 先补中文/改写/作用域过滤测试，**证明不足再上向量**；轮换种子**必须**含任务上下文（文档已要求），别只带画像 |
| P10 | **统一写入 MemoryService** | Mem0/LangMem/Vertex 都走统一写入 + 后台固结；Agent Zero P1 值类型纪律 | **可解** | CLI/MCP/反思/演化**共用一个服务**（文档已要求），MCP 退化为薄包装 |

---

## 3. 能解决 / 部分能解决 / 暂时无法解决

**能解决（有成熟范式或工程实践）**
- 来源/说话者/确认状态（P2）：写时 typed provenance + 读时 citation-lock。
- 时序与作用域（P8）：双时间轴 + 失效不删 + scope/condition/validity。
- 去重与稳定更新（P3）：Mem0 式冲突检测 + 稳定 `key`。
- 必要约束保障（P4）：constraint pinning + 顶部注入 + 主机补查（有量化依据）。
- 关键词→混合检索（P9）、原子持久化（P7）、统一写入（P10）。

**部分能解决（机制在，但质量依赖目标/模型）**
- **遗忘（P6）**：机制成熟（decay/软归档/RD-Forget/Auto-Dreamer），但**"什么该忘"的效用度量仍是开放问题**——SOTA 要么用"衰减+访问频率"的粗糙代理，要么用需要训练/奖励的 learned consolidator。
- **专业正确性校验（P5）**：可客观化的（数值/单位/排程/来源）能做强校验甚至零误收；**主观质量/风格仍靠模型评判**，有偏。
- **可靠 provenance（P2 的"真实性"层）**：来源字段能记；但"内容是否真被原文支持"需要 NLI/抽取模型 + 抽样评测，**无法廉价保证**；且存在 **provenance laundering**（固结时把外部观察洗成用户历史）——PPMF/MAP-Graph 缓解，未根治。

**暂时无法解决（开放问题）**
- **可辩护的遗忘目标函数**：没有 held-out 就无从判断"删对了没有"；纯代理（频率/时间）会误删罕见但关键的记忆。
- **冲突裁决的"权威"**（谁的断言该赢）：Mnemoverse 明确"authority half remains open"；AGM 信念修正/TMS 有理论但业界未落地。
- **记忆投毒与洗白**：攻击面成立，防御（PPMF/MAP-Graph）是缓解而非保证。
- **可靠的评测**：厂商自测基准互相矛盾（Mem0 在 LongMemEval 上厂商报 **94.4**、独立复现报 **49.0**，差 45.4 分）；现有基准偏"逐字召回"，**不测**程序性记忆质量、跨 agent 一致性、抗投毒；Letta 甚至主张"纯文件系统就很能打"。→ **唯一可信的基准是你自己在自己对话上跑的那个。**
- **图式抽取的可靠性**：强依赖模型遵守 JSON schema；小/本地模型常失败（Graphiti 文档明说）。

---

## 4. 对 Mentat 的具体建议（映射到现有代码与阶段）

结合我们现状（关键词 `MemoryStore` + 精确去重 + `recall/noise` + `reflect/evolve`），优先级：

1. **可信目标（先做，与 [自进化研讨](evolution-mechanisms.md) 一致）**：工作集/评测集分离；`Signal` 加权/归一化；质量/约束指标 repo-global。
2. **P2/P8/P10 一起落地**：`MemoryService` 统一写入 + 每条记忆的 `basis/scope/validity/status/evidence/revision`（**证据=消息id+说话者+片段**）→ 直接对治文档的"助手建议被写成用户偏好"。
3. **P4 constraint pinning**：必要约束单独集合、**顶部注入**、主机补查；用 `constraint_adherence@depth` 当信号。
4. **P6 软遗忘**：先"**分离存储与使用**"（RD-Forget 思路：历史保留、按查询条件控制使用），再加**衰减式软归档 + 回收站**；**绝不以 `recallTask.noise` 硬删**。
5. **P5 校验层**：确定性规则（数值/单位/排程绑定来源）先行，模型复核按需并计成本；采纳 LedgerMind 的"**证据账本 + 实体/数值包含**"与 TRACER 的"**句级 provenance + 反事实去证**"作为蓝图。
6. **P9 检索**：先把现有关键词检索补测（中文/改写/作用域），**证明不足再引向量**；长会话轮换种子含任务上下文。
7. **P1 类型纪律**：`kind/basis` 固化"事实/推断/建议/已完成"，"已完成行动"必须有工具证据。

> 存储范式选择：我们当前是 **flat/keyword（Mem0-lite）**。短期够用；一旦需要"会变化的事实"，应借鉴 **Zep 双时间失效不删**，而非自己造图数据库（Graphiti 的嵌入后端 Kuzu 已被弃用，服务端图库优先）。

---

## 5. 关键参考
- 统一框架：*Memory in the LLM Era* (arXiv 2604.01707)。
- 时序图：Zep/Graphiti (arXiv 2501.13956), getzep/graphiti。
- 运行时/睡眠固结：Letta/MemGPT, sleep-time compute (arXiv 2504.13171), SCM (arXiv 2604.20943)。
- 遗忘：FadeMem (arXiv 2601.18642), Oblivion (arXiv 2604.00131), RD-Forget (arXiv 2609.10263), Auto-Dreamer (arXiv 2605.20616)。
- 来源/校验：Agent Zero Memory (arXiv 2608.29606), MAP-Graph (arXiv 2608.10509), PPMF (arXiv 2607.29167), MemMark (arXiv 2605.25002), SpeakerMem-R1 (arXiv 2609.26780), ProvenanceGuard (arXiv 2606.18037), LedgerMind (arXiv 2607.28374), TRACER (arXiv 2605.09934), VeriFin (arXiv 2608.10213)。
- 上下文工程：Anthropic context engineering (2025)，Gamage *Omission Constraints Decay…* (2026)，Lilian Weng *agentic context engineering*。
- 基准：LOCOMO, LongMemEval(-V2), MemoryArena, DMR, GroupMemBench/EverMemBench。

## 6. 关于基准的警告（务必内化）
- 绝大多数分数由**在被测系统上获益的厂商**自跑，harness 各异；存在**同一基准相差 45.4 分**的实例。
- 现有基准偏"逐字召回"，**不测**程序性记忆、跨 agent 一致性、抗投毒、成本/时延权衡。
- 结论：**不要把别人的排行榜当作你选型或验证的依据；只信你在自己对话/任务上跑出来的数字**——这与我们 `personal-assistant-optimization-plan.md` 里"优化集与保留评测集分离、以未见任务验证"的要求一致。
