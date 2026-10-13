# 架构与包结构评审

> 状态：**档 A + 档 B 已实施**。落地后的分层规则见
> [`docs/dev-rules/layering.md`](dev-rules/layering.md)，由 `pnpm check:layering` 自动校验。
> 下文保留评审时的现状快照与方案，作为决策记录。
> 范围：`packages/` 的代码结构、文件组织、包拆分与依赖方向

## 1. 结论

整体分层方向是对的，应保留：

- `@mentat/core` **保持纯净**（无 `node:` 依赖），只放 engine 抽象；
- `transport-*` 按引擎拆分，配 **共享契约测试**（`@mentat/core/testing`）；
- 依赖单向：`cli → iterate → core`，`transport → core`。

但存在若干"组织债"，其中 **#1/#2/#3 是现在就该修的**，#4/#5 是内聚/命名优化。

## 2. 现状快照

| 包 | LOC | 文件 | 依赖 | 备注 |
|---|---|---|---|---|
| `@mentat/core` | 2472 | 48 | 无 | 纯（无 `node:`）；kernel / loop / adapters / events / artifact，**memory/model 域也在里面** |
| `@mentat/iterate` | 1299 | 26 | core, transport-pi | **杂**：workspaces / evaluators / gates / proposers / trace / experience / memory 持久化 |
| `@mentat/transport-pi` | 836 | 10 | core | 好 |
| `@mentat/transport-acp` | 644 | 5 | core | **CLI 未接线**（不在 cli deps / tsconfig paths / vitest aliases） |
| `@mentat/memory-mcp` | 133 | 2 | 无（MCP SDK） | 好（standalone `.mjs`） |
| `@mentat/cli` | 989 | 3 | core, iterate, transport-pi | **`src/index.ts` 936 行 god-file**（13 个命令 + helper） |

依赖方向（实测）：

- `cli → core, iterate, transport-pi`
- `iterate → core, transport-pi`（**transport-pi 未被 import，陈旧依赖**）
- `transport-pi/acp → core`
- `memory-mcp → 无`

## 3. 问题清单（按真实程度）

1. **`cli/src/index.ts` 936 行 god-file**（`commands` / args 解析 / 权限 / proposer / 路径全挤一起）。
   真问题、低风险、收益高。
2. **陈旧且方向错误的依赖**：`@mentat/iterate` 依赖 `transport-pi`，但从未 import。
   iterate 应保持**引擎无关**（由 CLI 负责接引擎）。一行修复。
3. **`transport-acp` 不可达**：CLI 未接它，也未进 `tsconfig paths` / `vitest aliases`。
   暴露"接新引擎要在 3 处登记、易漏"（acp 已漏）。真问题。
4. **`iterate` 名不副实、内聚低**：混装具体实现 + I/O + 记忆持久化 + 经验 + 追踪。中等。
5. **记忆散落 3 个包**：`core/memory`（逻辑）+ `iterate`（持久化/经验/反射）+ `memory-mcp`（服务）。中等。
6. **package 别名三处手维护**（`tsconfig.paths`、`vitest.aliases`、`cli deps`）。见 #3。

**不要动**：core 的纯净性（`iterate` 的存在正是为了隔离 node/I/O，**不要并入 core**）；
不引入构建步骤（just-in-time TS 对本阶段够用）。

## 4. 优化方案

### 档 A：结构卫生（低风险，建议先做）

```
packages/cli/src/
  bin.ts
  index.ts            # 仅 dispatch
  commands/{run,chat,iterate,evolve,loop,trace,harness}.ts
  lib/{registry,permission,proposers,paths}.ts
```

- 修 #2：删除 `iterate → transport-pi` 依赖，固化"iterate 引擎无关"不变量。
- 修 #3：用**单一来源脚本**生成 `tsconfig.paths` + `vitest.aliases`，并把
  `transport-acp` 登记齐；另加一条**依赖方向检查**脚本。
- 新增 `docs/dev-rules/layering.md` 记录不变量。

### 档 B：内聚重构（中等，建议随后）

```
packages/
  core/            # 仅 engine：kernel / loop / events / artifact / adapters(fake, registry)
  memory/          # 新：core/memory/* + json-memory-store + experience(+digest) + reflection + mcp server
  runtime/         # 由 iterate 更名：git-workspace / data-workspace / command-gate / container / evaluators / proposers / trace
  transport-pi/  transport-acp/  cli/
```

- 记忆收敛到一个包（#5）；`iterate` 更名 `runtime` 且只放"执行 real pieces"（#4）。
- 代价：`core` 的 `loop/demo.ts` 依赖 memory → 需搬到 `memory` 或 CLI；
  导入/依赖/配置大面积机械改动。
- 收益：边界清晰、命名准确，后续加域（skill / plugin）有位置。

### 档 C（不推荐）

- 合并 `iterate` 进 `core`：破坏 core 纯净。
- 把 transport 合成一个包：收益小。

## 5. 依赖方向不变量（建议固化并脚本校验）

1. `@mentat/core`：**零** workspace 依赖，且**不 import `node:`**（纯 engine）。
2. `transport-*`：只依赖 `@mentat/core`；不得依赖 `iterate`/`cli`。
3. `iterate`（→ `runtime`）：只依赖 `@mentat/core`；**不得依赖任何 `transport-*`**（引擎无关）。
4. `cli`：可依赖 core / iterate / transport-*（负责装配）。
5. 未知 → 用脚本 `scripts/check-layering.mjs` 校验，CI 化。

## 6. 验证方式

- 每步改动后 `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 结构类改动不改变行为：测试应保持全绿（必要时只新增）。
- 别名生成后，`pnpm test` 能解析全部 workspace 包（含 `transport-acp`）。

## 7. 我的建议

**先做档 A（尤其 #1/#2/#3）**；档 B 视后续是否继续增长再定。
当前 ~6.4k LOC 下档 B 的收益尚未到"必须"，但 cli god-file 与"接引擎要改 3 处 + 易漏"
是现在就该修的。

## 8. 待决事项

1. 范围：只做 **档 A**，还是 **A+B 一起**？
2. 是否接受 `@mentat/iterate` **更名 `@mentat/runtime`**（机械但面广的改动）？
3. 别名是否用**生成脚本**收敛（可能顺带删掉部分手动 alias）？
4. `transport-acp`：本轮只**登记可达**，还是顺手把 ACP 接进 CLI 成为可切换 harness（功能活）？
