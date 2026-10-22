# 可迭代制品架构：身份、适配器与证据链

日期：2026-10-22。状态：设计已记录，第一阶段已落地（见第 7 节）。配套决策：[ADR-0006](../adr/0006-artifact-identity-and-adapters.md)。

## 1. 问题

项目宣称"一切皆可迭代"，但 `@mentat/core` 原有的 `IterableArtifact` 只在名义上成立：

- 只有 memory 和 model catalog 两个实现，model catalog 还没有生产调用方；
- `snapshot(): JsonValue` 丢失类型，调用方只能用 `as unknown as`；
- `apply(runtime)` 假设所有制品都装进服务容器，而代码迭代走 `GitWorkspace`，从不经过它；
- `evalSpec()` 没有消费者，且让被评测对象自己声明评分方式；
- `version` 是手拼字符串，不是内容地址；
- `protected` 用对象身份比较，重载后的候选会被误判、内容篡改反而可能漏判。

根因不是"类型不够多"，而是**把载荷、物化方式和生命周期压进了同一个接口，同时漏掉了唯一该统一的东西：身份与证据**。

## 2. 目标与边界

目标不是"九种 kind 都能改"，而是：

> 任意一种制品，都能被同一条证据链证明"它变了、变好了、而且这次变好不是测量方式变了"。

四个层次：

| 层次 | 能力 | 判据 |
|---|---|---|
| L0 可寻址 | 任何制品有稳定、内容相关的身份 | 内容不同 ⇒ 身份必不同 |
| L1 可变更 | 任何制品能被提出、应用、回滚 | 变更可序列化、可审计、可撤销 |
| L2 可验证 | 任何变更能被外部冻结协议评价 | 同一协议下可重放、可比较 |
| L3 可递归 | 改进管线本身也能被改进 | 改进者不能绕过自己的证据链 |

**边界**：模型权重不在本设计范围内。DGM、Harness²、HyperAgents 都固定权重；综述把 foundation model improvement 与 scaffolding improvement 分成两条路径。本项目迭代的是 **harness 组件**（memory / skill / prompt / model routing / policy / adapter / core / pipeline），以及 agent 产出的 **deliverable**（补丁、报告等，另行管理）。

## 3. 六个平面

```
┌─────────────────────────────────────────────────────────────┐
│ Loop Plane      内层 artifact loop / 外层 harness loop       │
│                 + population archive（niche + lineage）      │
├─────────────────────────────────────────────────────────────┤
│ Trust Plane     digest + attestation + policy（不是 boolean）│
│                 + 人工批准（constitution 层）                │
├─────────────────────────────────────────────────────────────┤
│ Eval Plane      verifier / metric / contrastive 三模式       │
│                 + protocol digest + judge 校准 + holdout     │
├─────────────────────────────────────────────────────────────┤
│ Change Plane    Change + 结构化 diff + 事务                  │
├─────────────────────────────────────────────────────────────┤
│ Schema Plane    per-kind adapter（数据 / 代码两种物化）      │
├─────────────────────────────────────────────────────────────┤
│ Value Plane     CAS + digest + manifest + receipt            │
└─────────────────────────────────────────────────────────────┘
```

关键：**纵向分层，横向用同一个 digest 贯穿。** 从提出、物化、评测、注入到归因，不允许任何一层重新发明身份。

## 4. 核心契约

```ts
type Digest = `sha256:${string}` | `git:${string}`;

interface ArtifactRef {
  kind: ArtifactKind;
  id: string;
  version: string;
  digest: Digest;
  form: "code" | "data";
  trust?: "constitution" | "trusted" | "reviewed" | "candidate";
  protected?: boolean;
}

interface Artifact {
  ref: ArtifactRef;
  payload: JsonValue;   // 已校验的规范 JSON，不含闭包
}

interface ArtifactAdapter<P> {
  kind: ArtifactKind;
  form: ArtifactForm;
  parse(raw: unknown): P;          // 边界校验
  snapshot(payload: P): JsonValue; // 规范序列化，用于哈希
  restore(snapshot: JsonValue): P;
  materialize(payload: P, host: ArtifactHost): MaybePromise<Disposable>;
  diff?(before: P, after: P): ArtifactDiff;
}

class ArtifactRegistry {
  register<P>(adapter: ArtifactAdapter<P>): this;
  validate(artifact: Artifact): void;
  materialize(artifact: Artifact, host: ArtifactHost): MaybePromise<Disposable>;
  diff(before: Artifact, after: Artifact): ArtifactDiff;
}
```

`ArtifactAdapter` **不包含评测**。评分属于 Eval Plane 的外部协议：

```ts
interface EvalProtocol {
  id: string;
  version: number;
  mode: "verifier" | "metric" | "contrastive";
  dataset?: { id: string; revision: string; digest?: Digest };
  scorer?: { id: string; version: string; digest?: Digest };
  model?: string;
  budget?: { wallMs?: number; steps?: number; costUsd?: number };
  environment?: string;
  policy?: { retries?: number; abstention?: "required" | "allowed" };
  digest: Digest; // 协议本身内容寻址
}
```

## 5. 关键决策

### D1 制品是不可变值，不是带方法的对象

理由：可序列化、可跨进程、可回放、可去重、可审计。代价是需要 CAS 与 GC；这是唯一不能省的成本。项目里 `ArtifactRebuilder`、三处 `as unknown as`、归档不可恢复，全部源于闭包。

### D2 Artifact / Change / Candidate 是三个东西

`Candidate` 只存引用与谱系；`Change` 记录 base/target/diff/provenance；回滚是"切回旧 manifest"，不是反向执行闭包。

### D3 两种物化，统一事务，不统一 `apply`

- data：`host.provide(service, value)`，幂等、可并行；
- code：workspace 的 `prepare → patch → build → reload → commit | abort`。

统一的是事务协议，不是动作。`FunctionEvaluator` 只物化 `form: "data"`；代码制品由 workspace 事务物化，并作为 `form: "code"` 的 artifact 记录在候选上。

### D4 评测外置、冻结、按 kind 绑定

- 制品不能声明自己怎么被评测；
- 协议变更 = 新协议 id + 新 digest，不能把新旧分拼在一起（70.295 被作废、SWE-bench 分批评分都是现实教训）；
- 评测绑定属于受保护面。

### D5 `kind` 开放，schema 必须注册

`core` 不 import 领域包。新增制品 = 一个 adapter + 一行注册；loop 不变。代价是失去编译期穷尽性，用启动期 fail-fast 补偿。

### D6 信任分层

`constitution`（评测协议、gate、loop 本身）只能走外循环 + 人工批准；`candidate` 是模型刚提出的。类型 brand 防误用，运行时 gate 防对抗，二者缺一不可。

### D7 双层递归

内层改制品，固定协议；外层改编排，由冻结的"宪法协议"评价。DGM 把元层固定、HyperAgents 打开元层、Harness² 明确两层；本项目取中间路线：**允许自改，但必须换一层证据**。

### D8 事件日志/回执是唯一事实源

每次迭代产出 `IterationReceipt`：subject 是候选 digest，predicate 是测量方式、信号、结果、成本、环境。没有回执，"有没有真注入/真执行/真提升"只能靠人肉考古。

### D9 归因以 digest 为主键

注入、读取、写入、召回全部记 digest；否则同一 id 的两个版本会被合并统计。

### D10 可重放

给定 `(manifest, protocol, environment fingerprint, model id)` 必须能重跑。非确定性要显式记录。

## 6. 研究依据

| 来源 | 借鉴点 | 差异/限制 |
|---|---|---|
| [DGM](https://arxiv.org/abs/2505.22954)（ICLR 2026） | archive 保留所有变体；父代选择按分数正比、子代反比；只接纳可编译且仍能自改的候选 | 元层固定、不可自改，作者留作 future work |
| [HyperAgents](https://arxiv.org/abs/2603.19461) | task agent + meta agent 合成一个可编辑程序；元层改进可跨域迁移 | 元层可编辑后必须另有评价机制 |
| [Harness²](https://arxiv.org/abs/2610.14224) | 任务级 Propose–Probe–Compose；harnessing 级写回 improvement harness；8 个可编辑组件 | 开放世界没有 ground-truth verifier；默认不限制网络、Codex 关闭沙箱 |
| [AlphaEvolve](https://arxiv.org/abs/2506.13131) | 评测函数外部提供；validation→verification→evaluation 级联；program DB + 状态机 + lock token | 假设机器可评分 |
| [SICA](https://arxiv.org/abs/2504.15228) / [Gödel Agent](https://arxiv.org/abs/2410.04444) | 代码制品是最小自改单元 | 缺少 archive、证据链与跨任务泛化度量 |
| [自改进 agent 综述](https://arxiv.org/abs/2607.13104) | 两条路径：权重更新 vs scaffold 更新；评测章节区分 metric/judge 与过拟合风险；critic as governed infrastructure | — |
| [自演化 agent 分类](http://lsl.zone/blog/2026/a-taxonomy-of-self-evolving-agents/) | model / harness / artifact 三层；"what evolves, what feedback, where the loop closes" | 其 "artifact" 指产物，与本项目语义相反 |
| [Inspect AI](https://inspect.aisi.org.uk/eval-logs.html) | `status` 区分 started/success/error/cancelled；分数编辑有 provenance；append-only log updates；retry 复用样本；export-config 可重跑 | — |
| [in-toto](https://github.com/in-toto/attestation) / [SLSA](https://slsa.dev/spec/v1.2/) | Statement = subject(digest) + predicateType + predicate；attestation 不可变 | 解决构建可信，不解决改进是否有效 |
| [OCI Referrers](https://oras.land/docs/concepts/reftypes/) | 证明/签名作为 referrer 挂在 subject digest 旁 | — |
| [W3C PROV](https://www.w3.org/TR/prov-overview/) | Entity / Activity / Agent；derivation；provenance of provenance | 词汇标准，不含执行机制 |
| [Nix CA store](https://nix.dev/manual/nix/2.18/command-ref/new-cli/nix3-store-make-content-addressed) | 内容寻址带来去重、可复现、可缓存 | [哈希只证明完整性，不证明可信](https://lobste.rs/s/8nyk1p/stop_trusting_nix_caches) |
| [Voyager](https://arxiv.org/abs/2305.16291) | skill library 存可执行代码，可组合/验证 | 文本 skill 无法自动验证 |
| [DSPy](https://dspy.ai/) | 以 metric 编译 prompt；训练/验证分离 | 仍是单层优化 |
| [MLflow](https://mlflow.org/docs/latest/ml/model-registry/) | run → params/metrics/artifacts；registry alias 分级 | 面向 ML 模型，不含自改 |

## 7. 本次落地（2026-10-22）

已实现：

- `@mentat/core`
  - `digest.ts`：`canonicalJson` + `digestOf`（sha256，排序键）。
  - `artifact.ts`：`ArtifactRef` / `Artifact` / `ArtifactAdapter` / `ArtifactRegistry` / `createArtifact` / `sameArtifact` / `manifestOf`。
  - 移除 `IterableArtifact`、`EvalSpec`、`EvalResult`。
- `@mentat/evolution`
  - `Candidate.artifacts: Artifact[]`；`Proposal.artifacts?: Artifact[]`。
  - `FunctionEvaluator(tasks, registry)` 只物化 data 制品。
  - `touchesProtected` 改为 `kind:id + digest + protected` 比较。
  - `IterationRecord.outcome`；`protocol.ts`（外部冻结协议）；`receipt.ts`（回执）；`@mentat/observability` 的 `ReceiptStore` 追加写入 `receipts.jsonl`。
  - `Archive` 支持 `niche`，先按 niche 均匀采样，再在 niche 内按分数/子代加权。
- `@mentat/memory-evolution`
  - `memoryAdapter` + `memoryArtifact` + `memoryEntries` + `memoryArtifactRegistry`。
  - 校验逻辑收敛到 `parseMemoryEntries`，adapter/gate/磁盘加载共用。
- `@mentat/models`
  - `modelAdapter` + `modelCatalogArtifact`。
- `@mentat/workspace`
  - `ArtifactStore`（内容寻址、读取校验）。
  - `JsonStoreWorkspace` 只存 refs，payload 存 `<dir>/artifacts/<sha256>.json`；`load(dir, registry)` 直接重建，无 rebuild 回调。
  - `GitWorkspace` 为每个提交附加 `form: "code"` 的 artifact（`digest: git:<commit>`）。
- `@mentat/cli`
  - `evolutionArtifacts()` 组合 adapter；`evolve memory` 走新 workspace / evaluator，删除 `ArtifactSnapshot` 与 rebuild。
- `@mentat/memory-evolution`：`memoryEvalProtocol()` 把查询集纳入协议 digest；CLI `evolve` 写入协议与回执。
- `@mentat/cli`：`iterate` 为命令评测生成协议并持久化回执；`run.json` 记录协议 digest 与回执路径。
- 测试：新增 digest、adapter、CAS、receipt、niche、代码制品身份、磁盘篡改检测；全仓 `pnpm check` 通过（96 个测试文件，392 passed / 1 skipped）。

## 8. 尚未落地

| 项 | 原因 | 建议时机 |
|---|---|---|
| 真正的跨进程 CAS 服务 | 当前 CAS 是本地目录 + 内联 payload 的运行期表示 | 多机评测前 |
| PROV/in-toto 导出与签名 | 回执已持久化，但仍是本地 JSONL，未做签名/策略验证 | 对接外部审计前 |
| `contrastive` 评测执行器 | 需要探测/差分运行基础设施 | PAST/个人助手评测前 |
| 协议注册表与 holdout 强制 | 需要 config + gate | 外层循环启用前 |
| `constitution` 层运行时强制 | 现在只有 `protected` 与 `pathGuardGate` | 外层循环启用前 |
| code artifact 的 build/reload 物化 | 当前由 workspace 事务隐式完成 | 接入 adapter/policy 自改时 |
| skill/prompt artifact 适配器 | `skills-file` 已有存储，未接 loop | 第三个 data kind 落地时 |
| 模型权重迭代 | 明确不在范围内 | 不计划 |

## 9. 验收

- `pnpm typecheck` 通过，无 `any`/`as unknown as` 新增在调用点（adapter 边界除外）。
- `pnpm exec vitest run packages/core packages/evolution packages/memory-evolution packages/models packages/workspace` 全绿。
- 候选 JSON 只含 refs，payload 在 CAS；篡改 payload 会被 digest 校验拒绝。
- 受保护制品：删除、改写、剥离 `protected` 均被拒绝；内容相同的重载引用被接受。
- 回执包含候选 digest、协议 digest、信号与 outcome。

## 10. 迁移说明

- `IterableArtifact` → `Artifact` + `ArtifactAdapter`。
- `artifact.snapshot()` → `artifact.payload`（domain 代码用 `memoryEntries(candidate)` 等类型化 helper）。
- `new FunctionEvaluator(tasks)` → `new FunctionEvaluator(tasks, registry)`；memory 路径用 `memoryArtifactRegistry()`。
- `JsonStoreWorkspace(dir, root)` → `JsonStoreWorkspace(dir, root, registry)`；`load(dir, rebuild)` → `load(dir, registry)`。
- `ArtifactSnapshot` / `ArtifactRebuilder` 删除。
