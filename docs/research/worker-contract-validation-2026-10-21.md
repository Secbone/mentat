# 受限执行与结果验收验证

日期：2026-10-21。基于 `87ede96` 后的工作区实现，尚未提交。移交来源为 [商品属性 worker 交接](2026-10-21-product-attribute-workers/HANDOFF.txt)，12 份移交文件摘要均保持不变。

## 实现范围

- core 增加可选文件执行策略和独立 TaskAcceptance 契约。原生终止原因、completion 与验收状态分别保存。
- OpenCode V2 将策略编译为默认拒绝、具体文件 read/edit 例外；替换继承的宽泛主 agent 权限。通用 ACP、Pi 和 fake 不支持时拒绝启动。
- run 增加 `--execution-policy` 和 `--output-contract`；配置与输入快照由宿主冻结，控制目录在任务目录之外。受限模式禁用记忆/流程工具、历史和反思。
- evaluation 提供递归目录审计、标准 JSON Schema 和可选外部业务程序验收；不包含商品字段、颜色、单位或身份规则。Ajv 8.20.0 已在原锁文件中作为间接依赖存在，本次增加同版本直接依赖。
- Host 提供有时限、可取消的 resultEvaluator 扩展点；轨迹、持久化经验、经验重建和反思元数据保留验收状态。失败不重放模型动作、不合并业务结果。

使用方式、边界和接口见 [受限文件任务与结果验收](../worker-execution.md)。

## 真实模型验证

两个隔离探针均使用 OpenCode 2.0.25、`opencode-go/deepseek-v4.1-flash`；原生回执确认 effective model 与请求一致。

| 探针 | 实际观察 | 结论 |
| --- | --- | --- |
| 权限与正确交付 | read 输入成功；修改输入的 edit 返回 Permission denied（seq 48/49）；write 结果成功；读回只写输出被拒（seq 76/77） | Schema 与宿主程序独立检查 token，通过 accepted，CLI 0；前后输入摘要一致，未出现额外条目 |
| 正常执行但空值输出 | 模型实际写入 `{"value":null}` 并正常结束；execution reason 为 done | Schema 报 `/value: must be string`，acceptance rejected，CLI 2；没有把 done 改写成模型错误 |

第一个探针验证的是“原生限制真实生效”和“只写结果由宿主检查”；不是仅观察模型遵守提示词。没有强迫暴露 shell，也没有实际 shell 拒绝事件，不能宣称验证了任意命令拦截或 OS 沙箱。

第一个探针在后续补齐已有输出拒绝、验收开始事件和提示说明之前执行；这些后续改动由回归覆盖。第二个探针使用补齐后的代码执行。两者均不是商品抽取准确率、并发吞吐、SWE/PAST 或 RSI 实验。

原生账目合计约 $0.001551332，仅为本次两个探针的引擎费用字段，不代表订阅实际扣款。

本地证据：

- `.mentat/worker-validation-v1/verification.json`：原生权限拒绝、模型确认、验收和账目。
- `.mentat/worker-validation-v1/control/`：保留原字节的轨迹、输入/输出摘要、验收程序输出与目录审计。
- `.mentat/worker-rejection-v1/verification.json`：正常执行与独立拒绝并存的证据。
- `.mentat/worker-rejection-v1/control/`：第二次控制目录归档。

归档文件中的绝对路径仍指向原始临时 control 目录，不重写原始证据。`.mentat` 不进入代码提交。

## 回归与剩余边界

完整 `pnpm check` 通过：96 个 Vitest 文件，400 passed / 1 skipped；PAST Python 18 项、SWE Python 11 项、子包类型及分层检查、实验与格式检查通过。Docker 实机测试仍按既有开关跳过。

回归覆盖空值/类型错误、原生停止原因与验收分离、输入变更、额外目录、路径逃逸/通配、链接文件、旧输出、验收零退出但无有效 JSON、业务拒绝、挂起验收取消、验收持久化和重建、继承权限替换与不支持引擎拒绝。完整门首次仅因移交原始证据格式不符失败；已精确排除该 evidence 目录的格式化检查，未改写其 SHA 对应原始内容，其余检查保持启用。

仍需调用项目完成 RAW-only 契约、冻结 normalizer、字段全集及身份/角色检查，再复测同 12 商品。checkpoint、失败续跑和有上限的批处理调度未在本轮实现；也未实现 ACP 服务端。

文件前后摘要只能证明最终状态，不能证明过程中从未修改再恢复。权限依赖引擎原生工具，不能提供任意进程的 OS 隔离。Schema-only accepted 仅表示所声明结构契约通过，事实/业务质量仍需领域验证器。Host 的 JS 扩展点需要可信、遵守 signal 的实现；CLI 外部验收程序有独立进程组清理。
