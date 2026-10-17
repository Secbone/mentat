# LongMemEval 错题修复与固定 50 题复测

原全量结果为 229/500。逐题复核有 210 个回答包含 DSML 工具协议文本，真实工具事件为零，其中 209 个判错。该结果是宿主历史检索配置的成绩，不是完整自主记忆或自迭代成绩。

## 修复内容

- 提示升级为 personal-assistant-v4，按 disabled/read-only/read-write 声明实际记忆能力。闭卷宿主不注册记忆 MCP；只读 MCP 不提供写工具。外部 harness 已配置的 MCP 可显式声明为 external，避免重复注册。
- ACP 可等待本次新进程发送的 tools/list 回执；旧回执不能放行。真实诊断表明目录交换仍不足以证明引擎工具可用。因此工具模式另用无副作用的 memory_ready 原生探测，在业务问题提交前验证实际调用 ID、成功结果及未预先告知模型的 nonce。最多两次准备探测，失败停止；不解析/执行 DSML 文本，不重试业务答案。
- 工具诊断 v4/v5 均在零固定等待下实际完成准备探测、候选写入和新会话检索，候选保持未激活。v1/v2 目录回执方案失败、v3 延时对照成功，全部记录保留。摘要见 [readiness repair](../../benchmarks/public/results/2026-10-16-memory-readiness-repair.json)。这是有限配置的真实契约验证，不是所有引擎的通用就绪证明。
- 答案任务可开启最终输出验证：空答案、DSML 协议文本不能以 done 当作完整回答。原始文本与轨迹保留；文档/代码任务不默认执行该验证。评分保留原语义裁判结果，另报 finalAnswerValid 和 usableCorrect，不事后替换官方判定。
- 历史检索改为 BM25 词项权重、跨会话分散及相邻消息补全，按时间顺序呈现证据，保留角色、日期、来源与预算。日期遮罩继续先于检索。未接入外部 embedding 服务；不将词项检索声称为语义检索。
- 提示要求跨会话去重汇总、区分事件/会话日期、新旧修正及偏好迁移。助手建议和第三方观点不自动成为用户偏好；候选仍须确认。知识生命周期等进一步机制仍需专项验证。
- 评测新增控制器侧支持会话召回诊断、最终答案有效性和真实输入 token 记录。gold 支持会话标签只在答案返回后用于评分，不进入摄入、检索或模型请求。

## 先固定样本，再运行

[冻结清单](../../benchmarks/public/plans/longmemeval-error50-v1.json) 从原结果及已记录的基础设施恢复视图中选择全部已判错题，不接触任何新答案。固定种子、按类别与旧输出形态分层，组内优先无答案题，其后按 SHA256 排序。

| 类型 | 数量 |
| --- | ---: |
| 跨会话 | 14 |
| 时间推理 | 14 |
| 偏好 | 6 |
| 用户信息 | 6 |
| 知识更新 | 6 |
| 助手信息 | 4 |

共 50 题：30 题原输出含 DSML、20 题普通错答；其中 23 题为无答案题。原样本正确数为 0。该组高度偏向已知错误，只能报告错题恢复情况，不能代表 500 题正确率或无偏提升；不得删掉仍错的题、反复采样答案或把非 DSML 子集正确率当新总分。

按用户要求，先完成检查、提交并验证远端 revision，再启动新模型服务及这一组 50 题。服务固定启动时源码归档，不在运行期间改变已加载模块。每题一次回答和原始判定提示的 DeepSeek 评分，无网络搜索和 Agent 工具。独立工具准备诊断与这条闭卷复测明确分列；本次仍不声称测到自主摄入、记忆反思的公开分数。

```bash
node --import tsx scripts/public-model-server.ts --out .mentat/public-evaluations/transport-repair-v1 --port 8943 --parallel 4
.mentat/venvs/public/bin/python benchmarks/public/longmemeval.py --out .mentat/public-evaluations/longmemeval-error50-repair-v1 --base http://127.0.0.1:8943 --selection benchmarks/public/plans/longmemeval-error50-v1.json --agents mentat-episodic --workers 4
python3 benchmarks/public/analyze_error_sample.py --run .mentat/public-evaluations/longmemeval-error50-repair-v1 --transport .mentat/public-evaluations/transport-repair-v1 --out .mentat/public-evaluations/longmemeval-error50-repair-v1-analysis.json
```

验收分别看：业务回答完整性、23 道拒答题、原 20 道普通错答、支持会话召回及剩余错误、模型身份、真实工具/权限日志、输入 token 和费用。与其他项目的同配置复现及全量回归仍须独立执行。
