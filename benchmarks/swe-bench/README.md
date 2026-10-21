# SWE-bench Pro V2 小样本接入

使用上游 Harbor 任务和评分器，固定版本 `66f92766bba642462d4bbe5479e83f91f9211862`。
V2 有 642 题；旧 v1 的 731 题结果不能混用。该目录是新增的软件工程能力维度，独立于原先选定的 11 个公开评测集。

## 边界

- `mentat_agent.py` 是 Harbor `BaseAgent`：宿主运行真实 Mentat/OpenCode，模型只有 `environment_terminal`，命令在任务容器内执行。
- `scripts/coding-benchmark-turn.ts` 使用项目统一个人助理 prompt；通用代码任务指令不含实例答案、评分标签或特例。宿主目录为空，不向模型开放本项目源码或评测资产。
- 首轮为 reset：禁用经验检索、记忆工具和反思，不代表 RSI 验收。后续需独立学习集、冻结经验和 held-out 配对比较。
- 容器 agent 阶段禁止联网；setup/verifier 采用原任务策略。执行前记录两个 HTTPS 目标的端到端响应探测，能获得响应或探测执行失败则停止，不放宽限制。透明代理可能接受 TCP 握手后才拒绝访问，因此不使用仅检查 TCP connect 的探测。
- 模型只获得 `instruction.md` 和任务容器工具；不向其提供 `solution/`、`tests/`、官方评分反馈、参考补丁或后续提交。
- 每题先校准参考补丁应为 1、空补丁应为 0。失败则不调用模型。模型提交后保存 `model.patch`，调用上游 `PatchReplayAgent` 在新容器独立评分；原 agent 容器中的验证结果不作为最终分数。
- 默认每题 10 分钟、最多 50 次容器工具请求，低于原版 50 分钟预算，标记为 `adapted-budget-development-sample`。不是全量成绩或官方排名；更改预算必须使用新结果目录。

## 安装与复现

依赖：Node >=22、项目 pnpm 依赖、Python >=3.12、Docker Compose、Buildx。ARM 主机需要可运行 amd64 容器；网络组件使用 Docker 主机架构，不能全局设置 `DOCKER_DEFAULT_PLATFORM=linux/amd64`。运行器逐题显式预拉 amd64 任务镜像。

```bash
.mentat/venvs/controller/bin/uv venv .mentat/venvs/swe-bench
.mentat/venvs/controller/bin/uv pip install --python .mentat/venvs/swe-bench/bin/python harbor==0.24.0
git clone --filter=blob:none --sparse https://github.com/scaleapi/SWE-bench_Pro-os.git .mentat/upstream/swe-bench-pro-sparse
# sparse-checkout 只取 v2/tooling 和 probe.py DEFAULT_IDS 列出的三个任务目录；然后固定上述 revision。
.mentat/venvs/swe-bench/bin/python benchmarks/swe-bench/probe.py --out .mentat/swe-bench/pilot3-new
node --import tsx scripts/swe-bench-export.ts .mentat/swe-bench/pilot3-new .mentat/swe-bench/pilot3-new-unified
pnpm bench report --run .mentat/swe-bench/pilot3-new-unified
```

默认样本在调用模型前固定：NodeBB、Ansible、OpenLibrary 各取官方目录中按名称排序的第一题，选择依据是覆盖不同仓库，非随机代表样本。`--limit 1` 只测第一题；`--start-index 1 --limit 2` 单独运行后两题。分开运行时须报告全部尝试，不能丢弃环境失败的样本再宣称完整三题成绩。

首轮结果见 [2026-10-21 报告](../../docs/research/swe-bench-pro-v2-pilot-2026-10-21.md)。不重叠的分批结果可用 `python3 benchmarks/swe-bench/merge.py --inputs <批次一> <批次二> --out <新汇总目录>` 合并，再用 `swe-bench-export.ts` 导入统一框架。合并拒绝不同模型/预算、重复题和被标记无效的运行，保留环境失败与来源摘要。

NodeBB 后续已在独立 VZ/Rosetta 环境完成，原始补丁及仅源码补丁均通过官方新容器重评，见 [NodeBB 复验报告](../../docs/research/nodebb-swe-bench-validation-2026-10-21.md)。该次环境和源码快照与首轮不同，单独报告，不合并为同一批次解决率；合并器也拒绝不同运行环境。

`probe.py` 拒绝已存在的输出目录，依次执行每题；记录上游 revision、题目文件摘要、镜像 digest/内容层、Mentat revision、脏工作区 diff 和接入文件摘要。宿主保留 30 GiB、Docker 数据分区保留 5 GiB；未缓存镜像额外要求 8 GiB 余量，已加载镜像额外要求 2 GiB 写入余量并验证 linux/amd64，不再次拉取。运行期每 2 秒检查主机余量、每 30 秒检查所选 Colima 数据分区，越线中止本轮进程组并保留未评分状态。这些检查不能保证未知镜像一定适配；大规模执行仍须先核算镜像大小。运行器不会自动删除镜像、容器或卷。

`--calibration-from <旧试跑目录>` 可复用已通过的参考/空补丁校准：核对上游 revision、完整任务文件摘要、镜像 digest、Docker/虚拟机环境指纹、结果路径和题目身份，再重新读取两份官方逐题结果确认 1/0。更换虚拟机、Rosetta 设置或内存后不复用旧校准。复用记录保留来源与结果摘要；不会把旧 subject 的分数复用到新模型运行。每次真实主体启动还会在控制器一侧存档完整的 tracked/untracked 非忽略源码，并在 Host 响应中记录实际源码指纹。

`results.json` 单列评分缺失和基础设施失败；未完成全体计划题时总解决率为 null。统一框架导入也保留缺失分母。真实工具命令/输出在 `tool-calls.jsonl`，原始 Host/ACP 轨迹和可用的模型确认/账目在 `agent/host/`；没有精确费用时保留 null。重评分过程本身不消耗模型。

## 本机环境兼容记录

本机没有 Buildx。首轮仅为构建 Harbor 网络组件，在 `.mentat/swe-bench/sidecar-legacy` 将官方 Dockerfile 的 `COPY --chmod=755` 等价改为 `COPY` 后 `RUN chmod 755`，用 legacy builder 构建；网络策略源文件、任务和评分器未改。缓存镜像 tag 沿用 Harbor 预期值，因此 tag 本身不能证明原版 Buildx 构建；该基础设施差异必须随本轮报告披露。正式复现应安装 Buildx，重建原版网络组件。

ARM/QEMU 可能让上游测试内部固定超时触发。参考补丁校准失败必须标为环境阻塞，不能当模型 0 分，也不能通过放宽官方测试超时掩盖。本地失败并不说明题目在 x86_64 官方环境不可用。

NodeBB 复验使用独立 Colima profile `mentat-nodebb`，配置根目录在 `.mentat/nodebb-runtime`，通过 [Colima 支持的 VZ/Rosetta 配置](https://github.com/abiosoft/colima/blob/main/embedded/defaults/colima.yaml) 运行原版 amd64 镜像。启动使用 `--activate=false`，不切换默认 Docker；控制器同时设置 `COLIMA_HOME`、`LIMA_HOME`、`COLIMA_PROFILE` 和 `DOCKER_HOST`，容量检查也指向该 profile。结束时停止本次虚拟机。

`diagnostic_agent.py:DiagnosticOracle` 只用于控制器侧诊断：应用参考补丁，用透明 timeout 包装器记录原命令退出码，不改 120 秒限制或测试内容；其结果不作为模型成绩。正式运行不安装该包装器。为恢复空间，本次在审批后移除了默认 Docker 内三个无引用的 SWE 镜像缓存，保留独立环境的 NodeBB 副本；清单和结果在 `.mentat/swe-bench/nodebb-diagnostics/cache-cleanup-*.json`，历史补丁/成绩/日志及原有业务资源均保留。
