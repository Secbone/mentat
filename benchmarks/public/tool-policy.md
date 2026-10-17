# 公开评测的工具、联网与答案隔离

评测前固定每个任务的工具、输入和网络策略，评测后审计实际轨迹。上游没有明确统一网络规则时，不把我们的控制协议冒称为上游规则。规则未核实、隔离未落实或出现未授权工具调用的结果，只能保留为开发记录，不能列为可比正式成绩。

## 各数据集的执行边界

版本均以 `upstream-lock.json` 为准；以下来源为对应固定 checkout 中的文件。尚未跑通的工具集，策略验收也未完成。

| 数据集 | 上游入口与需要保留的能力 | 本轮控制及验收 |
| --- | --- | --- |
| LongMemEval | `src/retrieval/run_retrieval.py`、`src/generation/run_generation.py`：给定历史的检索与阅读 | 本轮自定闭卷控制：助手所有工具拒绝，仅允许宿主检索该题历史。不得使用外部网页、答案标签或其他题资料。每题与裁判新会话隔离。 |
| PersonaMem-v2 | `inference.py`：选定用户历史 + 当前问题 + 随机选项 | 本轮自定闭卷控制。只摄入 `chat_history`，排除 persona/profile、preference、relevant snippet、正确答案标记。MCQ 全部候选选项在作答时可见，这是题面；正确选项映射仅评分端可见。 |
| PersonaMem-v3 | README 及 evaluation 实现：多种历史/记忆方法 | 逐模式核实可见历史与时间边界，未来消息、评价及偏好标签不进入记忆。未完成策略验收。 |
| MemoryAgentBench | `conversation_creator.py`、`utils/templates.py`：先摄入文档，再按原模板回答 | 文档按来源顺序摄入；题目答案、隐藏元数据不用于构建记忆。本轮拟用闭卷工具协议，需运行后审计，不能把文档当当前系统指令。 |
| ToolSandbox | README、`tool_sandbox/roles`：场景指定可见工具、消息角色及世界状态；部分 search 工具调用 RapidAPI | 只开放场景提供的工具，不能另加通用浏览器、shell 或数据库读取。合法搜索工具不应被统一禁用。缺服务时标缺失，替换为 mock 则另列适配成绩。 |
| tau-bench / tau2 | README、`src/tau2`：任务环境工具、用户模拟器及策略 | 保留官方工具调用及状态验证；用户与助手的消息/工具边界分离。不能直接读取后台完整状态、目标动作或最终数据库来作答。网络需按 domain/tool 配置核实。 |
| AgentDojo | `src/agentdojo/functions_runtime.py`、`agent_pipeline/base_pipeline_element.py` | 仅调用上游 runtime 中注册的函数。攻击文本属于不可信数据；不得读取期望攻击目标/成功判定或借外部工具绕过环境。 |
| MemoryArena | `setup_web_search_env.md` 及各环境 setup：环境 API、浏览/搜索语料、FAISS 索引 | 必须区分环境内搜索与公网搜索。BrowseComp-Plus 使用提供语料和索引，ground truth 仅在评分端。其他领域逐环境验收；不能直接挂载整份数据目录给助手。 |
| PAST-Bench | README、`self-evolve-tasks-v2`：Docker sandbox 与任务工具 | 安装依赖、镜像和模型 API 所需联网不能推导为任务可任意联网。逐 family 保留官方测试、工具及持久状态协议，隐藏验证与 oracle 解法单独隔离。 |
| SkillsBench | README：`task.md` + `environment` + `oracle` + `verifier` | 执行环境仅含任务允许的文件/skills；oracle 和 verifier 不能一并挂载给助手。按 task/network 配置核查执行期联网；安装联网单独记录。 |
| RSI-Exam | `docs/network-policy.md`、公开任务各自的 `task.toml` | 安装、agent、verifier 分阶段控制。已下载 35 个公开 task 配置：31 个 agent `no-network`，4 个 `allowlist`，不得按 README 概述一律判断。只允许任务配置及运行时精确模型端点；不得扩大到 GitHub/Hugging Face 等答案来源。评分独立环境；私有 53 题未覆盖。 |

## 统一验收要求

1. **可见输入**：先构造允许字段，再发送给助手。参考答案、rubric、oracle、隐藏测试与目标状态只进入评分侧，不与 agent 共用可读卷。公开测试是否可见按任务协议决定。
2. **工具与网络**：记录实际工具清单、阶段、精确网络 allowlist、配置和执行日志。模型服务连接单列。允许搜索的任务只使用官方搜索通道；不允许搜索的任务不另开 web 工具。容器规则要做允许/禁止目标的实际探测，单写 prompt 不算隔离。
3. **持久化边界**：按 benchmark 的用户、任务、episode、时间线划分记忆。不得跨用户或向过去传入未来消息。测试答案和裁判反馈默认不回灌；上游明确允许的训练/反馈阶段另标。
4. **评分独立**：作答保存后才调用评分器，评分器可见 gold 不表示助手可见。禁止按得分反复生成并择优。仅基础设施失败可按预先披露规则重试，并保留原始失败、旧答案及全部尝试。
5. **比较条件**：模型、数据、工具、网络、时间/token 预算、scorer 和失败处理都披露。改过官方规则的结果单列 adapted，不直接减论文榜分数。
6. **污染限制**：公开题可能已进入模型训练，工具封锁无法证明不存在参数记忆。闭卷公开分数与未见任务迁移/污染诊断分开报告，不用经过题目调优后的测试集宣称独立泛化。

## 当前文本桥的证据范围

当前 `scripts/public-model-server.ts` 使用旧式 `permission: {"*":"deny"}` 声明，宿主权限回调始终 deny，文本路由拒绝 tools/functions 请求。OpenCode V2 官方配置要求改为 `permissions` 数组，不能把旧字段声明直接当成 V2 有效工具策略的证明：[Permissions](https://opencode.ai/v2/docs/permissions/)。已运行的文本结果依据实际轨迹判定工具使用情况，不追改冻结配置。

V2 MCP 默认采用 Code Mode，拒绝 execute 会隐藏仅通过它提供的工具；直接工具需要 server 配置 `codemode: false`：[MCP permissions](https://opencode.ai/v2/docs/mcp-servers/#permissions)。初期三个无等待诊断分别尝试工具名放行、直接 MCP、V2 permissions 数组，均只有 DSML 文本，实际工具调用与候选保存均为 0。

后续采用直接 MCP、精确权限和 2,000 ms 初始化兼容等待，两次独立运行均真实执行 memory_add/search，候选持久化、新会话读回且未激活；当前代码的无等待对照又出现零调用。证据支持注册时序竞态的判断，但固定等待不是通用就绪保证。`AcpAdapterOptions.startupSettleMs` 为默认 0 的显式兼容选项（上限 10 秒），会记录诊断；每个评测环境仍须通过真实工具契约验收。结果见 [memory-tools.json](results/2026-10-16-memory-tools.json)。不能把该合成诊断当作公开集成绩或自学习效果，也没有解析 DSML 并强行执行。

任务工具桥 `environmentMcpSpec` 使用控制端声明的 schema 和经过认证的本地 Unix socket，不提供通用 HTTP、shell 或 Python 执行能力。它只转发冻结清单内的调用，上游负责参数验证、任务状态与评分。AgentDojo 接入按工具名、最终参数及次数核对 ACP 与上游 runtime 接收记录，执行顺序以实际回执为准。初始空参数会合并后续 tool.update，不能只读取 tool.start。SDK fixture、真实模型烟测及一个公开任务的两种方法预检均通过，但不代替全量验收。已核对上游模拟 web 工具操作的是 `web_content/web_requests` 状态，不访问公网；其他环境仍须分别核查。

ACP 在返回的当前模型与指定模型不一致时，会先调用 `session/set_config_option`，检查返回的有效 model option；选择未确认就终止，绝不发送任务提示。协议测试覆盖被引擎忽略选择的情况，真实工具预检也确认 DeepSeek。已启动旧 transport 的配置保持冻结，旧记录不能因为新适配器已修复而改写。

`audit_text_transport.py` 读取实际 ACP wire 记录与规范化事件，验证大 payload 摘要、事件序列、轨迹完成状态，并检查工具事件及非 deny 权限决定。发现异常返回 2。这是工具轨迹审计，不是操作系统防火墙或抓包证据。当前运行未做 OS 级网络/文件系统封闭，应在报告中披露，不能标为强隔离。

首轮 LongMemEval transport-v1 在评分恢复前审计了 2,034 次请求、35,203 条协议记录，未发现工具事件、权限放行或轨迹缺口。后续恢复产生新请求后须重新审计；不得沿用旧请求计数为新结果背书。
