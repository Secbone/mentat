# 自进化机制研讨：睡眠 / 新陈代谢 / 辨证思维

> 状态：研讨报告（多方辩论后的综合意见）
> 方式：由 3 个"正方"子 agent（各负责一个机制）+ 1 个"反方"红队子 agent 分别基于
> 仓库实际代码独立分析，再由主 agent 综合（正题—反题—合题）。
> 目标：判断这三个类生物机制**该不该建、怎么建、先建哪个**，并给出可执行的最小路径。

## 0. 三方共识（最重要的结论）

1. **三者都不需要新的核心机械**，本质都是 `SelfIterationLoop`（`packages/core/src/loop/loop.ts`）
   的**重新参数化**：换任务、换评测信号、换门、换触发时机。所以问题不是"能不能建"，而是
   **"是否值得建、以及目标函数是否可信"**。
2. **三者的成败几乎完全取决于同一个东西：目标/效用指标是否可信、是否抗博弈。**
   目前仓库里唯一的记忆效用指标 `recallTask`（`packages/memory/src/evolution.ts`）的
   `noise` = "不在 held-out `expectId` 集合里的条目占比"——它是一台"**按今天的考卷出题的碎纸机**"。
3. **在建立"可信的目标 + 机制的自我评测与止损"之前，三者的自动化版本都可能是净负收益。**
   红队的措辞："三者中两个在当前证据（~6.4k LOC）下不值得建。"

因此本报告给出的方案是：**先修"目标卫生"，再按最小 v0 逐个验证，机制必须可被 A/B 证伪并可移除。**

---

## 1. 睡眠（Sleep = 固结 + 遗忘 + 会话轮换）

### 1.1 正方设计（要点）
- **边界**：睡眠不是新算法，而是**离线进化周期的编排层**——把已有 `mentat evolve memory`
  （数据）与 `mentat iterate`（代码）当子程序，再加三件 loop 不做的事：跨经验**固结**、
  按效用**剪枝**、`chat` 的**会话轮换**。产物不是单个候选，而是"新记忆/skill 集 + 回收站 + 新 session seed"。
- **固结 A**：现只有 per-turn `--reflect`（`packages/memory/src/reflection.ts`，`run.ts`/`chat.ts` 触发）
  与 `buildExperienceDigest`；缺**跨全部经验的批量固结**，也**缺 skill**（`ArtifactKind` 有 `"skill"` 却无实现）。
  `ExperienceRecord`（`packages/memory/src/experience.ts`）只存 prompt/outcome/tools，**不含轨迹细节**，固结信息不足。
- **剪枝 B（ablation）**：对条目做"移除评测"——去/留它 `recall`/`noise` 不变 ⇒ 无用。复用 loop：
  给 `evolution.ts` 补 `removeEntry` ProposeStep（现只有 `addEntry`），配 `PruneMemoryProposer`，
  用 `dominates`（`packages/core/src/loop/pareto.ts`）选择。安全网：**不硬删**，移入
  `.mentat/memory-recycle.json` 可 `--undo`。
- **会话轮换 C**：`chat` 全程只建**一个** session 反复 `send`（`packages/cli/src/commands/chat.ts`），
  上下文越聊越满。达阈值时 `dispose()` 旧 session，以 `buildMemoryContext(memory, summary)` 作
  `systemPrompt` 开新 session；sleep 走"显式 rotate（新会话+记忆种子）"而非依赖 Pi compaction
  （引擎无关且真正回收带宽）。
- **三层带宽**：live context（token）、memory store 噪声、experience store 体积（只追加 JSONL，永不 GC）。
- **形态**：`mentat sleep`，编排 排空经验→固结→剪枝→(可选)代码演化→轮转经验日志→写报告。

### 1.2 反方攻击
- **剪枝是危险的一半**：当前 loop **没有任何删除路径**（`RuleMemoryProposer`/`AgentDataProposer` 只追加）；
  而唯一效用指标按 `expectId` 定义 → **"只留考卷答案"就能支配**（recall 不掉、noise→0）＝**prune-to-the-test-set**。
  真正有用但不在考卷里的记忆被判为"噪声"删除。
- **硬删除**：`JsonFileMemoryStore.forget`（`packages/memory/src/json-memory-store.ts`）直接改写文件，
  不像 `JsonStoreWorkspace.rollback` 只移动指针。
- **固结同罪**：`evolve memory` 会把被接受的条目**永久持久化**，而评测只查"对给定查询的 recall"，
  **从不查真值** → **garbage in, forever in**。
- **会话轮换**：红队认为"session 已 per-run dispose，等于 no-op"。（**综合纠偏**：`chat` 是**一次调用内**
  复用同一 session 的**长会话**，轮换指"在一次长 chat 内周期性 rotate"，因此**不是 no-op**，但声明它很便宜、收益待实测。）

### 1.3 合题 / 最小 v0
- **不要先做 sleep 子系统。** 先做：**held-out 记忆效用协议**（剪枝用的查询集与优化用的查询集**不相交**）+
  **软遗忘（回收站）** + **语义门**（固结产物过 gate）。三者就绪前，睡眠只 = "手动跑现有 `evolve memory`"。
- **验收（可证伪）**：跨 N≥20 次运行，**不相交 held-out recall 不下降**且 token 成本下降，才允许开启 `--prune`。
- 会话轮换可独立小步验证（token 节省 vs 上下文丢失的有损程度），先手动 `mentat sleep --rotate`。

---

## 2. 新陈代谢（Metabolism = 行为保持的重构）

### 2.1 正方设计（要点）
- **目标反转、机制复用**：`iterate` 保留"更优"候选（`dominates`）；metabolism 把**质量信号设为
  `lower-better`**（Pareto 原生支持），行为不变由 `commandGate` 变成硬门槛。拒绝的候选仍进 `archive`
  （`loop.ts` 早于 accept），`parentSelection:"archive"` 下可作垫脚石。`scoreOf` 仅用于父代选择，**不参与接受**。
- **质量信号**（全 `lower-better`）：廉价可立即做 `loc.total`、`loc.max_file`（直接打击评审点名的 god-file）、
  `file.count`、`dep.count`、`layer.violations`（复用 `scripts/check-layering.mjs`）、`exports.count`；
  需依赖的 `dup.tokens`（jscpd）、`complexity`（ts-morph）、`dead.exports`（knip）。
  统一脚本 `scripts/quality-signals.mjs` 打印 `Signal[]`，由现有 `--eval` 走 `JsonCommandEvaluator` 消费。
- **形态**：`mentat iterate --profile refactor`（复用 180 行装配），每轮一个 target，靠经验里
  `toolErrors`/`error` 高的热点优先。

### 2.2 反方攻击
- **"行为保持"在现有门下不可证伪**：行为 = `--check` 退出 0。薄覆盖下，agent 可以**删代码+删测试**
  来缩小 LOC 而 `pnpm test` 依旧绿。
- **Goodhart**：`scoreOf`（`pareto.ts`）**求和原始未归一化**的信号 → 上千的 LOC 会淹没 0/1 的通过率，
  `Archive.selectParent` 也按这个原始和加权父代 → **压缩/内联"打高尔夫"**，可读性变差却无信号捕捉。
- **规模小 + 高频变动**的代码库上，重构 churn 通常净负；应先补 differential/property 测试。
- 另注：`loop.ts` 的 `touchesProtected` 依赖 `parent.artifacts`，而 `GitWorkspace.current()` 返回
  `artifacts: []` → **代码循环里 artifact 级 `protected` 是空转**，代码保护**全靠 `pathGuardGate`**。

### 2.3 合题 / 最小 v0
- **先做一次性手动实验**：在**丢弃式分支**上跑一次
  `mentat iterate --task "减少重复/降低复杂度，行为不变" --check "pnpm test && pnpm lint"`，
  **人工看 diff**；不自动化。
- 只有当**覆盖率下限**（低于则拒绝）与**归一化质量指标**就绪后，才谈自动化。
- 防护清单：保护 `**/*.test.ts`、快照、`vitest.config.ts`、`packages/core/src/loop/**`、
  `scripts/check-*.mjs`、`package.json`、锁文件；加"测试/断言数不得下降"门；每轮 `maxIterations:1` + hard reset 回滚。

---

## 3. 辨证思维（Dialectics = 多视角 + 反臃肿 + 机制自评）

### 3.1 正方设计（要点）
- **反臃肿作为一等 Pareto 信号**（`lower-better`）：LOC、重复、依赖数、包数、`candidate.artifacts.length`、
  trace 体积/事件数、diff 增删行。因 `dominates` 要求"任一共享指标更差即拒"，把这些塞进评测向量就**自动**约束膨胀，
  **无需改选择逻辑**（`noise` 就是先例）。需要注意：`SelfIterationLoop` 只接**单个** evaluator → 需新增
  `CompositeEvaluator` 合并子评测器的信号（名字唯一）。
- **正/反/合：Critic**：在 `dominates` 判真、`workspace.commit(child)` **之前**插入（只审"将要接受"的候选，省一半开销）。
  第二个 agent session 读 proposal+diff+before/after signals，列反对意见。**硬 `criticGate`（可否决）** vs
  **顾问式（写 tracer + 交人工）**；Archive 本就保留非支配变体＝多元性，Critic 只是再加一条判断轴。
- **机制自评（最重要）**：把反射/sleep/metabolism 建模为**可开关 feature/artifact**，在 **held-out 任务集**上
  A/B（with vs without），信号含 `overhead`（tokens/延迟，lower-better）；净增益不超成本就删。
  并**漂移检测**：扫 trace/archive 的 before/after，拟合"复杂度↑/测试↓/依赖↑"的趋势斜率，越阈则 pause/rollback。

### 3.2 反方攻击
- **Critic 是未计量的额外开销**，且它自己会膨胀——**框架在宣称反臃肿的同时自己臃肿**。
- **元评测无穷递归**：如果没有**成本/止损预算**（cost-per-prevented-regression），"评测评测的评测"会无限退。
- **隐喻误导**：生物睡眠是**随机遗忘**而非按效用；代谢是热力学驱动而非优化；进化没有 Critic、没有目标、没有 held-out。
- **两个真实代码约束**：(a) loop 单 evaluator；(b) `scoreOf` 原始求和会被大数量级 regularizer 主导父代采样。

### 3.3 合题 / 最小 v0
- **先加一个静态反臃肿信号**（如重复/死代码）进现有 Pareto，**先验证 Pareto 本身是否已能挡住膨胀**；
  过了这一步，再考虑 Critic。
- Critic **默认顾问式**（记录 + 人工），高风险路径升级人工裁决（`permission.ts` 三档已存在）；用**更便宜的模型**；
  上线前必须**自评**其 net value。
- 元评测必须有**预算/止损判据**（明确：多少成本、多少 prevented-regression 才继续），否则只保留"廉价反臃肿信号"这一层。

---

## 4. 贯穿三者的"目标卫生"问题（必须先修）

子 agent 在代码层面发现若干会**让任何机制失效或走偏**的具体问题：

1. **`noise` 可被"只留考卷"支配**（prune-to-test-set）→ 需**不相交 held-out** + 工作/评测集分离。
2. **`scoreOf` 原始未归一化求和**，大数量级信号（LOC）会主导父代采样；regularizer 不应进 `scoreOf`/
   `selectParent` 权重 → 建议给 `Signal` 加 `weight` 或标记 regularizer 只在接受阶段生效。
3. **`dominates` 只比较"共享指标"**：若候选**删掉了产生某指标的东西**（删文件/删测试），该指标在两向量中不一致
   → **逃过比较**。→ 质量指标应**repo-global**（分母固定），并显式处理"指标缺失＝回退"。
4. **代码 artifact 级 `protected` 空转**（`GitWorkspace.current()` 的 `artifacts: []`）→ 代码保护实际只靠
   `pathGuardGate`。需明确并在文档/测试中固化。
5. **删除路径的持久化语义不一致**：`forget` 硬删；`rollback` 只移指针 → 记忆/经验/代码需要**统一的回收站语义**。
6. **`ExperienceStore` 只追加、永不 GC**；`buildExperienceDigest` 只限读不限存。
7. **loop 单 evaluator** → 需要 `CompositeEvaluator` 才能"任务信号 + 反臃肿信号"并存。

---

## 5. 建议的推进顺序（最小、可证伪、可回退）

1. **目标卫生（先做）**：① `CompositeEvaluator`；② `Signal.weight` + regularizer 不进 `scoreOf`；
   ③ repo-global 质量指标 + "指标缺失＝回退"处理；④ 记忆 held-out 工作集/评测集分离。
2. **辩证法廉价版**：把一个反臃肿信号接入现有 `iterate`/`evolve`，验证 Pareto 是否已能挡膨胀；**不做 Critic**。
3. **睡眠最小版**：`evolve memory` + **软遗忘（回收站）** + **语义门**；剪枝仅在"不相交 held-out 不降"时开启。
   会话轮换作为独立小实验。
4. **新陈代谢最小版**：一次性手动 `iterate` 重构实验 + 人工看 diff；覆盖率下限与归一化指标就绪后再自动化。
5. **机制自评**：为 1–4 每个机制建立 A/B + overhead 信号 + **止损预算**；不达标即移除。Critic 最后再议。

---

## 6. 写代码前必须回答的问题

- 记忆效用如何在**与优化集不相交**的数据上度量？被剪枝条目的**恢复路径**是什么？
- 质量指标如何在 `scoreOf` 中**归一化/加权**？regularizer 是否进父代采样？
- `dominates` 如何避免"候选删除自己的质量信号"逃逸？质量指标是否 repo-global？
- metabolism 的**覆盖率下限**是多少（低于则拒绝重构）？
- 无人值守运行的**预算/速率**上限是多少？**止损判据**是什么？
- 一个"元机制"如何在不陷入无穷递归的前提下证明自己？
- `skill` 是否独立 artifact，还是用 memory tags 表达？其评测信号是什么？

---

## 7. 一句话合题

**三个机制都值得保留为"方向"，但当前只应实现"目标卫生 + 廉价反臃肿信号"，其余以最小 v0 逐个做 A/B 验证；
任何不能证明自己在 held-out 上净增益的机制，必须能被移除。** 否则，自进化框架会先把自己进化臃肿。
