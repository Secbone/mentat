# 使用指南

本文对应 `277a1bd` 的 CLI 和执行契约。命令默认在 Mentat 仓库根目录运行；`/absolute/path/to/...` 和 `<...>` 是需要替换的路径或参数。

## 安装与引擎准备

需要 Node.js >=22、pnpm 11.26.0。普通助手使用不需要 Docker 或评测数据集；`pnpm check` 中的 Python 审计需要 Python 3，CI 使用 3.11。SWE 容器评测另有环境要求，见 [专用说明](../benchmarks/swe-bench/README.md)。

```bash
pnpm install --frozen-lockfile
pnpm dev help
pnpm dev harness list
pnpm dev run "连通性检查" --harness fake
```

| 引擎 | 使用方式 | 准备与边界 |
| --- | --- | --- |
| `fake` | `--harness fake` | 不需要模型凭据，只验证调用流程 |
| `opencode` | `--harness opencode --model <id>` | 本机安装 `opencode`，执行 `opencode auth login`；通过 `opencode models` 查看可用模型 |
| `pi` | `--harness pi --model <id>` | 本机安装 Pi、配置模型；项目支持读取 OpenCode 凭据，需确认对应 provider/model 可用 |
| `acp` | `--harness acp --model <id>` | 设置 `MENTAT_ACP_BIN`；可选 `MENTAT_ACP_ARGS` 覆盖默认 `acp` 参数 |

`opencode` 接入包含专用的系统策略与 MCP 配置；通用 `acp` 仅保证其声明的能力，不能假定具备相同的系统提示替换能力。引擎注册在 `@mentat/harnesses`。

从仓库外调用时使用 `/absolute/path/to/mentat/mentat` 代替 `pnpm dev`，并显式指定 `--cwd`。模型是否可用以本机引擎的配置为准。

## 执行任务与聊天

单次任务使用 `run`，持续交互使用 `chat`：

```bash
pnpm dev run "检查项目，给出下一步修改建议" \
  --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /absolute/path/to/project --permission ask --timeout-ms 600000

pnpm dev chat --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /absolute/path/to/project --permission ask --timeout-ms 600000
```

`chat` 在同一会话内处理多轮输入，使用 `/exit` 退出。`run` 完成一个任务后退出；跨任务长期信息通过记忆或显式启用的历史召回提供，新的 `run` 不会自动继续原聊天会话。

| 参数 | 含义 |
| --- | --- |
| `--harness <id>` | run 默认 fake，chat 默认 pi；真实任务建议显式选择 |
| `--model <id>` | 传给引擎的模型 ID |
| `--cwd <path>` | 工作目录，默认启动 CLI 时的当前目录 |
| `--permission ask` | 经过宿主权限处理器的请求逐次询问 |
| `--permission auto` / `full` | 当前宿主处理器均直接允许请求；run 默认 auto、chat 默认 full，不是风险自动判断 |
| `--timeout-ms <ms>` | run/chat 的启动和每轮超时配置，默认 120000；不是整个聊天会话的总时长 |
| `--memory <file>` | 默认 `<cwd>/.mentat/memory.json` |
| `--experience <dir>` | 默认 `<cwd>/.mentat/experience` |
| `--log-dir <dir>` | 默认 `<cwd>/.mentat/runs`，每次生成独立子目录 |
| `--log-protocol` | 开启经脱敏的引擎协议诊断 |

宿主权限只覆盖经其处理器的请求。OpenCode 原生工具仍受原生权限配置控制；`ask` 不表示已经隔离任意进程或文件访问。

## 记忆、反思与流程知识

显式长期规则应按类型确认。聊天中输入：

```text
/remember-preference 工作汇报先结论，再列证据
/remember-constraint 周末外出必须在11点前回家
/remember-fact 我的常用项目目录是 /work/demo
/remember-method 排查故障时先复现，再缩小范围
/reflect
/exit
```

`/remember <文本>` 保留兼容，但未指定类型可能得到类型提示；建议使用分类入口，每次确认一条规则。模型在普通对话中自行声称“已记住”，不等于宿主已将其确认为长期有效规则。

单次任务可以在结束后确认规则或启动反思：

```bash
pnpm dev run "整理本次工作记录" \
  --harness opencode --model opencode-go/deepseek-v4.1-flash --permission ask \
  --remember-preference "工作汇报先结论，再列证据" --reflect
```

`run --remember-*` 在本轮执行后保存，供后续任务使用，不会补入本轮已发送的上下文。`--reflect` 显式分析完整交互；`--reflect-auto` 仅在纠正或可复用工具失败等证据出现时触发，正常结束本身不触发。反思会增加模型调用。

模型工具写入和反思提取默认只生成候选，不自动变成有效规则。有效期、自然语言条件及语义冲突尚未全部实现程序化判断，见 [策略与边界](prompt-context.md)。

如需在新任务中召回同一用户/项目过去的原生交互，显式启用字符预算：

```bash
pnpm dev run "结合以往的处理方式安排这次工作" \
  --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --cwd /absolute/path/to/project --permission ask --recall-chars 12000
```

`--recall-chars 0` 禁用该类历史注入；它与默认记忆快照、当前会话历史是不同来源。是否选中、是否进入实际请求和是否影响动作，可通过 `trace --recall` 查看归因证据，未知项不能当作成功召回。

使用 `--skills <file>` 为 run/chat 显式启用单独的流程知识仓库。模型只能保存草稿；经过宿主评估后才可发布为 validated，改写后重新成为草稿。流程知识不会仅因保存成功就成为已验证能力。

## 日志与结果判断

run/chat 启动时打印 `trace: <目录>`，后续查询优先使用该实际路径。默认保存：

```text
<cwd>/.mentat/
  memory.json                记忆数据
  experience/*.jsonl         任务经验与交互摘要
  runs/<traceId>/
    manifest.json            运行配置与采集状态
    events.jsonl             结构化主日志
    artifacts/               大内容与引用
    fragments/               MCP 子进程事件分片（如有）
    summary.json             关闭后的派生摘要
    feedback.jsonl           外部反馈（如有）
```

```bash
pnpm dev trace /absolute/path/to/run --summary
pnpm dev trace /absolute/path/to/run --check
pnpm dev trace /absolute/path/to/run --errors
pnpm dev trace /absolute/path/to/run --context
pnpm dev trace /absolute/path/to/run --recall
pnpm dev trace /absolute/path/to/run --all
pnpm dev trace /absolute/path/to/run --raw

# turn ID 从轨迹中取得；反馈必须引用真实轮次
pnpm dev trace feedback /absolute/path/to/run --turn <turn-id> \
  --score 0 --correction "关键条件未满足：要求11点前，而不是11点整"
```

| 状态信息 | 含义 |
| --- | --- |
| `reason=done` | 执行正常结束，不代表答案正确、动作成功或用户接受 |
| `reason=length` | 引擎报告预算限制，可能有可用的部分结果 |
| `termination` | 终止原因、证据来源及可获得的原始协议原因；缺失或未知不能自行补造 |
| `completion.response` | 是否存在响应文本，不等于已交付文件或完成业务任务 |
| `completion.verification=unverified` | 会话层不作质量裁决，需结合真实结果、独立评测或用户反馈 |
| `assistant-reported-step-limit` | 助手自述步数受限的提示，不是引擎确认的事实 |
| manifest / `trace --check` 正常 | 采集或结构检查正常，不能替代任务验收 |

CLI 对预算受限的部分输出显示终止提示；协议泄漏等 error 响应不作为正常正文显示。run 的零退出码仅表示执行正常结束。系统不会根据工具调用次数推断精确步数耗尽。

日志经过脱敏，但自由文本不保证完全识别所有敏感信息。分享前应复核任务内容和 artifacts；默认不自动删除历史日志。事件字段和反馈契约见 [可观测性说明](refactor-execution-observability.md)。

## 代码演化与记忆演化

先运行不调用真实模型的确定性演示：

```bash
pnpm dev loop demo
pnpm dev loop memory
```

实际 Git 项目的代码演化：

```bash
pnpm dev iterate --target /absolute/path/to/git-project \
  --task "修复问题并补充必要验证" \
  --check "pnpm typecheck && pnpm test" \
  --prepare "pnpm install --offline" \
  --harness opencode --model opencode-go/deepseek-v4.1-flash \
  --permission ask --iterations 1
```

目标项目应有提交且工作区干净。修改在独立 detached worktree 执行，依赖需要单独初始化；上例适用于依赖已缓存的 pnpm 项目，其他项目按需替换 `--prepare`。只有接受且通过发布条件的候选会快进到目标目录；原目录并发变化会阻止发布。默认保护 `packages/evolution/src/**`，可用重复的 `--protect <glob>` 设置保护路径。worktree 是版本隔离，不是 OS 沙箱。

iterate 的日志默认写在启动目录的 `.mentat/runs/<runId>`，包含 `events.jsonl`、`run.json` 及可获得的 `iter-<n>.diff`，可用 `--log-dir` 指定根目录。旧 `trace.jsonl` 仍兼容读取，新运行使用 `events.jsonl`。

记忆演化需要分开训练、选择和最终测试查询：

```bash
pnpm dev evolve memory --agent \
  --training-queries /absolute/path/to/training.json \
  --queries /absolute/path/to/selection.json \
  --test-queries /absolute/path/to/final-test.json \
  --harness opencode --model opencode-go/deepseek-v4.1-flash --iterations 1
```

查询文件是 `[{ "query": "查询文本", "expectId": "预期记忆ID" }]` 数组。训练查询可提供给 proposer，selection 影响多轮选择，final-test 只在选择结束后评一次；不同 split 的完全相同查询会拒绝，语义泄漏仍需人工检查。recall/noise 是代理指标，不能直接宣称任务能力或 RSI 提升。

## 统一评测

```bash
pnpm bench list
pnpm bench list --json
pnpm bench validate --plan benchmarks/examples/native-plan.json \
  --dataset benchmarks/examples/episodes.json
pnpm bench:smoke

pnpm bench report --run /absolute/path/to/evaluation-run
pnpm bench compare --before /absolute/path/to/before --after /absolute/path/to/after
pnpm bench history --root /absolute/path/to/evaluation-runs --csv
```

清单登记不代表完成实际接入。`bench:smoke` 使用 fake 和合成记录，只验证框架；公开评测需要固定数据、任务、上游评分器及运行协议。report 的执行完成、评分覆盖、成本覆盖应分别阅读；不兼容的 compare 会返回退出码 2，不输出有效提升结论。

SWE-bench Pro V2 的模型接入、校准、网络隔离、容量检查和独立补丁重评见 [SWE 使用说明](../benchmarks/swe-bench/README.md)。NodeBB 最新验证见 [复验报告](research/nodebb-swe-bench-validation-2026-10-21.md)。缩短预算的开发样本不能作为官方全量排名或 RSI 证据。

## 常见问题

- 找不到 `mentat`：仓库内用 `pnpm dev`；其他目录用本仓库启动器的绝对路径。
- 模型不可用或无凭据：检查所选引擎的认证和模型列表；OpenCode 使用 `opencode auth list`、`opencode models`，需要时重新登录。
- 启动或长任务超时：查看 `trace --errors` 和引擎诊断，必要时为新运行显式增加 `--timeout-ms`；不要自动重放有副作用的任务。
- 记忆似乎未使用：先确认 `--cwd`、`--memory`、条目是否有效以及上下文是否遗漏；反思候选不会自动激活，历史召回另需 `--recall-chars`。
- 必要约束超出上下文预算：本轮会在发送前停止，应先整理所绑定空间中的约束，不能默认所有规则都已进入上下文。
- 清单里有评测集却无法直接运行：查看 bridge 状态和专用接入说明，确认环境与 scorer 已完成验证。
