# 公开评测接入与运行

目标保持为已选的全部 11 个公开评测集：完成接入、全量运行、展示能力分项及开源项目的可比差距。这里的元数据和预检不是完成证明。私有任务、缺少环境的任务和模型配置差异必须显式记录。

## 当前可执行入口

LongMemEval 的能力声明、最终答案检查、词项检索及真实工具就绪修复，见 [修复与固定 50 题复测协议](../../docs/research/longmemeval-repair-2026-10-16.md)。该组从旧错题中预先固定，不代表全量成绩；工具准备诊断与闭卷检索成绩分列。

- `scripts/public-model-server.ts`：只绑定 `127.0.0.1`，复用已授权的 OpenCode DeepSeek；逐请求保存请求、最终响应、ACP 日志、模型确认与原生账目。文本桥接拒绝 tools、streaming 和多模态请求，不能假称支持工具评测。ACP 不提供精确采样参数与输出 token 上限控制，固定 wall-clock timeout。
- `benchmarks/public/longmemeval.py`：cleaned S 完整 500 题，含 30 道拒答题；两种方法为 Mentat 原始历史检索和上游 session BM25。运行前固定原文件摘要，上游检索、提示与裁判函数按 AST 原样加载并保留源码摘要。所有历史先清除评分标签，原始 session id 也转为不含答案标记的不透明 id。
- `scripts/public-export-longmemeval.ts`：将真实逐题结果导入统一框架，记录缺失/失败、分类指标与完整性摘要；产生 BM25 → Mentat 的差值，正值表示 Mentat 更高。不能只导入一个总体平均分来伪造覆盖。
- `scripts/public-memory-probe.ts <new-out> --warmup-ms 2000`：独立真实模型记忆工具契约，使用直接 MCP 与精确权限，要求真实写入、新会话工具检索、候选保持未激活。失败返回 1，诊断与公开分数分开。
- `scripts/public-environment-turn.ts`、`environmentMcpSpec`、`benchmarks/public/agentdojo_eval.py`：真实任务工具入口，将冻结 schema 经 MCP 暴露，上游状态留在认证 Unix socket 的另一端；AgentDojo 保留原 task verifier，并核对 ACP/runtime 调用。SDK 桥的未知工具/错误凭据拒绝、两种方法的真实工具烟测、一个公开 AgentDojo 任务的两种方法预检均已通过。尚未全量；clean utility 与攻击矩阵必须分开，不能把 clean 阶段当作完整安全成绩。
- `bench compare-subjects`：显式声明共同 study，核对数据、任务、评分器、协议和底层模型配置后，允许比较已声明的方法差异；普通 `compare` 的项目版本回归限制仍保持。

本轮只使用 DeepSeek。LongMemEval 采用原评分提示，但将固定 GPT-4o 裁判换为 DeepSeek，且模型消息经过 OpenCode ACP。因此成绩标记为 `adapted-model-transport`，可以与本轮同配置复现的 BM25 比较，不能直接对论文中其他模型/裁判的数字计算“提升”。上下文预算也须披露：Mentat 检索预算 12,000 字符；上游 BM25 top-10 session、4,000 cl100k_base token。该对照比较的是这两个完整配置，不是等 token 的检索算法消融。

## 历史接入边界

工具、执行期联网、可见输入及 oracle/评分隔离要求见 [tool-policy.md](tool-policy.md)。逐任务遵循上游规则；安装联网与作答联网分开。文本评测禁止助手工具和外部搜索，工具类评测仅开放该任务提供的工具。不得用统一开网或统一关网改变测试含义。完成运行后用 `audit_text_transport.py` 审计实际 ACP 记录；当前文本桥尚无 OS 级网络隔离证据，报告必须保留该限制。

宿主新增 `ingestHistory()`，接收 source/id/timestamp/messages，保留角色与日期；拒绝标签、未知字段和内容变化的重复 id。导入内容进入经验存储，不调用 `remember`，不会自动确认长期偏好。配置 `history` 后，宿主按问题检索原始观察片段并以引用材料交给模型，记录片段选择、遗漏及预算。默认配置不启用此检索。既有经验存储脱敏仍生效，属于被测系统行为。

因此本轮被测方法明确命名为 `mentat-episodic`，不是声称旧版本原生具有该历史接入能力；也没有绕过候选记忆的激活限制。

## 复现

```bash
# 每次服务和运行都使用新的输出目录，禁止覆盖或择优替换。
node --import tsx scripts/public-model-server.ts --out .mentat/public-evaluations/transport-v1 --port 8941 --parallel 4
.mentat/venvs/public/bin/python benchmarks/public/longmemeval.py --out .mentat/public-evaluations/longmemeval-s-full-v1 --workers 4
node --import tsx scripts/public-export-longmemeval.ts .mentat/public-evaluations/longmemeval-s-full-v1 .mentat/public-evaluations/longmemeval-s-full-v1-unified
```

原始数据路径、固定摘要及依赖版本写在运行器与运行 manifest 中。上游源码固定版本见 `upstream-lock.json`；`dataset-metadata.json` 为公开仓库文件体积摘要，详细文件列表留在本机 `.mentat/benchmark-data/metadata/`。预检子集始终标记为子集，不进入完整成绩表。

## 资源与未完成工作

`resources.py` 在任务与数据下载前提供容量检查，默认保留宿主 30 GiB 可用空间。还需单独检查 Docker 数据分区；当前约 27 GiB 可用，不能把宿主约 113 GiB 的余量当作容器余量。仓库文件体积不包含解压、索引、模型权重、镜像及日志。分批使用环境，不删除已有镜像、容器或卷。

使用 `python3 benchmarks/public/disk_report.py` 获取实时只读快照；`--incoming-gib N` 检查主机新增容量，`--docker-incoming-gib N` 检查 Docker 新增容量并保留 5 GiB。超过预算返回退出码 2；指定 Docker 预算但无法查询分区时也返回 2。未提供 Docker 新增容量时，`plannedBatchFits` 为 null，不能视作环境已通过容量验收。快照可保存到 `.mentat/public-evaluations/`，避免把动态日志提交进仓库。

2026-10-16 实测宿主约 110 GiB、Docker 约 26 GiB（`df -h` 显示约 27G）可用。五个已核算数据仓库原始文件共约 9.50 GiB。RSI-Exam 的 35 个公开任务配置已读入容量快照：其中 `clevr_cogent_grpo_qwen2vl` 声明 agent 存储 204800 MB，`teacher_student_math_posttraining` 声明 131072 MB，均高于本机预留后的容量。这些是声明配额，不是已测量占用，仍须核查镜像、构建和实际执行需求；不能据此声称所有环境都能在本机完整运行。未知资源字段保留 null。大型任务须另行确定足够的执行环境，其他任务可按容量分批推进。

其余十个公开集仍需各自的任务桥接、官方评分一致性验收、全量运行和比较基线，不能因源码已下载就标记完成。工具类环境需要真实工具事件与状态校验，不能通过当前文本桥接强行模拟。RSI-Exam 公共 35 题与私有 53 题必须分列；公共完整运行也不能声称覆盖私有全榜。
