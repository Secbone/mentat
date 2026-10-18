# PAST-Bench 与 RSI-Exam 接入预检（最小桥 + 冒烟）

日期：2026-10-17/18。范围：为两个此前仅登记、`upstream-bridge-required` 的公开集
建立最小 Mentat 桥并冒烟。PAST-Bench 完成真实模型冒烟；RSI-Exam 完成预检、
`nop` 管线冒烟与桥接加载验证，真实执行受阻于沙箱供给。两次运行均为本机
DeepSeek（OpenCode/Pi），非公开榜单成绩。

## PAST-Bench

- 上游：`Gen-Verse/PAST-Bench`，26 family / 204 episode。已克隆并用 uv 建 3.11
  venv（`.[mock,sandbox,dev]`），`past-bench list-agents` 正常。
- 桥接（Mentat 侧）：`scripts/past-bench-agent.ts`——跑一次 Mentat 助理 host turn，
  输出 `{final_output, usage, reason}`。
- 桥接（PAST-Bench 侧）：`benchmarks/past-bench/{mentat_adapter.py,agents.mentat.yaml,run.py}`，
  用 `_OneShotCliAdapter` 包一层，并通过 `run.py` 把 `mentat_cli` 注入 `_ADAPTERS`
  （不改上游 checkout）。适配器保留真实 `HOME` 以复用 Mentat 的 OpenCode 凭据。
- 冒烟：`memory_ability/SM01_preference_adoption`（8 episode）、`runtime=local`、
  `--no-judge`。
  - baseline 0.600 / learn 0.560 / evaluation 0.400 / control 0.800，`family_delta=-0.200`。
  - 第 5 题（eval_far）触发 300s 单题超时，按 infra 规则记 0；control 有 1 题满分。
  - 产物：`benchmarks/past-bench/results/2026-10-17-sm01/`。
- 关键发现：`dispatches=0 / memory_calls=0 / search_calls=0`——PAST-Bench 靠
  dispatch（memory/skill/search）证据归因跨会话收益，而当前适配器不把这些暴露出来，
  因此 delta 为负不代表 Mentat 记忆无效，而是**桥接未上报基质使用**。下一步给适配器
  加 dispatch 归因与多轮协议。

## RSI-Exam

- 预检：HF 数据 571MB/2694 文件已按固定 revision 下载（`download.py`）；`uv tool
  install harbor` 成功；逐任务 `task.toml` 资源清单已读（最轻
  `finscope_dcf_valuation` 2GB/2CPU/512MB；部分任务 8CPU/32GB、100–200GB 存储、12h）。
  少数 `legal_matter_caseload_regulatory/world_corpus` 文件 TLS 间歇失败，下载器可续；
  该任务另需 task 侧 API key。
- 管线冒烟（`nop` agent）：1 trial、0 异常、reward≈2e-6、7m12s——镜像可建、任务可跑、
  sealed verifier 可打分。产物：`benchmarks/rsi-exam/results/2026-10-17-nop-finscope/`。
- 最小 Mentat 桥：`benchmarks/rsi-exam/mentat_agent.py`——`BaseInstalledAgent` 子类，
  Harbor 用 `module.path:ClassName` 本地导入即可识别（`harbor agent schema
  mentat_agent:MentatAgent` 通过；`--print-config` 接受该 agent 与 job 计划）。
- 阻塞：真实执行在 **agent setup** 阶段失败——`Agent setup timed out after 360s`，
  卡在 `apt-get update && apt-get install curl git ca-certificates`。原因是 RSI-Exam
  任务 agent 为 `network_mode="no-network"` 且基础镜像无 Node/curl/git，**无法在 setup
  期安装 Mentat**。证据：`benchmarks/rsi-exam/results/2026-10-18-mentat-agent-blocked/`。
- 解除方向（择一）：预烘 `mentat-agent` 镜像；用 Harbor model-connection bridge 让
  Mentat 内层 harness 在沙箱内直连模型端点；或薄封装 Harbor 的 `pi` agent（Mentat 的
  基质就是 pi/opencode），复用其安装与模型桥，仅叠加 Mentat 的记忆/助理层。

## 结论

PAST-Bench 的桥接链路已跑通（单题 + 整 family），待补 dispatch 归因与多轮协议。
RSI-Exam 的桥接在 Harbor 中可加载、可规划，真正运行待解决沙箱供给（预烘镜像或模型桥）。
两项均属"最小桥"而非完整公开评测；分数不进入正式榜单。
