# 实施证据

日期：2026-10-08。本文记录实现与检查及用户接受当前功能的决议，不替代 `verification.md`。

## 范围与结果

- Coordinator 采用内置固定协议 adapter 与 API Key。服务预设、连接复用、模型选择替代 module/export、SDK options JSON 与认证模式输入；自定义连接支持 OpenAI Chat、OpenAI Responses、Anthropic Messages，官方 Gemini 使用原生 adapter。
- 用户级连接/模型库只追加不可变记录；项目 schema 5 保存完整快照。一个连接可保存多个模型，离线保存和显式应用分离；旧项目格式明确拒绝，不自动迁移。
- 发布目录版本 `models.dev-9603608e272e841a` 包含 194 个服务预设、6119 个模型记录。运行时公共刷新与连接发现独立；非空发现为候选真源，发现失败回退相同连接/凭据/catalog 版本的 last known good，再回退 catalog。catalog 内容或发布版本变化使旧发现失效。
- 连接、Key 和目录规则由共享应用服务拥有。Home、项目模型设置、doctor 和 ledger-lab 消费同一服务；Worker 继续使用原生 harness 的认证及模型目录。
- 能力探针要求真实工具调用及结果续接、有效文本与流式、主动取消和一致 usage。推理/签名载荷沿原 checkpoint 正文与有界附加数据恢复，只在原配置使用；跨配置不携带签名或内部 thought。

主要实现位置：`src/domain/model-configuration.ts`、`src/application/configuration/{project-config,model-settings,provider-library,provider-catalog,provider-catalog-conversion}.ts`、`src/application/ports/provider-library-store.ts`、`src/adapters/{storage/provider-library-store,agents/provider-catalog,agents/chat-model-factory,agents/capability-probe}.ts`；bootstrap、TUI、ledger-lab、checkpoint/context、共享 fixture 与现行文档同步修改。完整映射见 [implementation-plan](implementation-plan.md)。

## 限定审计与修复

独立审查发现并修复五处真实 SDK 合同偏差：

| 问题 | 修复与证据 |
| --- | --- |
| OpenAI Responses 调用 ID 映射被当作数组，reasoning summary 的 index 未接收 | 接收 SDK 的 record 映射与整数 index；checkpoint 关闭/重开测试覆盖真实形状 |
| Anthropic SDK 自行追加 `/v1/messages`，预设又带 `/v1` | 预设使用 root，factory 归一化末尾 `/v1`；实际 ChatAnthropic 配合 mock fetch 核验官方与 MiniMax 请求路径 |
| OpenAI effort 传入 SDK 不消费的字段 | 映射到 `reasoning.effort`；实际 Chat/Responses `invocationParams` 核验 |
| Gemini 单文本签名保存在 `originalTextContentBlock`，恢复时丢失 | 加入严格、有界白名单，原配置恢复，跨配置移除 |
| Gemini `thought:true` 文本进入跨配置 portable text | portable text 与 Capsule 排除 thought；原配置保留完整内容块 |

相应行为由 `tests/adapters/{chat-model-factory,checkpoint-store}.test.ts` 和 `tests/workflow/context-maintenance.test.ts` 覆盖。actual SDK 检查使用 mock transport，没有调用付费服务。

真实 PTY 启动测试曾读取当前仓库的既有协调数据库并遇到 `no such column: utility_role`；测试改为在自己创建的临时 Git 仓库启动，不修改用户数据库。

## 全仓库基线检查

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test --maxWorkers=4` | exit 0；189 文件通过、7 文件跳过；2106 项通过、16 项条件跳过；255.78 秒 |
| `git diff --check` | exit 0 |
| `openspec validate rework-coordinator-provider-configuration --strict` | 通过 |
| `openspec validate add-ledger-lab-rehearsal-infrastructure --strict` | 通过 |
| `node --check scripts/render-provider-tui.mjs` | exit 0 |
| 九帧高度与隐藏 Key 检查 | 通过 |

默认并发 `pnpm test` 的两次运行均有 1 项失败：第一次为未修改的 transcript reader 压力测试超过 5 秒（2105 通过/16 跳过）；第二次为 PTY 的 Tab 后草稿等待失败（2105 通过/16 跳过）。随后两文件复验为 21 通过/1 失败，失败点改为 PTY 的 Ctrl+C 退出等待。最终限制 4 个 worker 的全套测试通过，未放宽超时、跳过失败项或更改产品代码来绕过它们；默认并发下的时序不稳定仍需保留为检查限制。

原始日志保存在 [implementation-checks](implementation-checks/)：`tests-default-1.log`、`tests-default-2.log`、`tests-focused-recheck.log`、`tests-full-4-workers.log`，以及类型/lint/build 的命令输出。任务 4.3 据此完成；4.2 按下述用户决议收口，共 10/10。

## 功能验收修复与最终复验

只读验收 Agent Maxwell 发现 `saveModelSettings` 的迟到连接保存成功和项目模型保存拒绝结果会覆盖等待期间的新编辑。父 Agent 用延迟 Promise 在真实 TUI 行为测试中复现，并确认项目初始化成功存在同样问题；修复前新增场景共3失败、7通过。

保存结果现在同时核对原调用身份与编辑版本。连接保存成功只更新库列表与revision，新输入保持；项目模型保存失败不再恢复旧草稿，成功只更新已保存快照的revision；项目初始化成功也保留后来编辑的issue number。输入未变化时保留正常跳转、关闭与明确应用流程。另修正 `ports.ts` 两处仍描述SDK字段路径的过时注释。

最终修复后检查：

- `pnpm test tests/tui/model-settings.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/host-wiring.test.ts`：3文件、32项通过，exit 0；包括5个新增延迟结果用例。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check`：exit 0。

日志保存在 `implementation-checks/save-race-{red,green,types,lint,build}.log`。本次局部修复复验受影响路径；上面的2106通过/16跳过是修复前的全仓库基线结果，不冒充修复后重新执行的全量结果。未增加真实付费调用或lab业务演练。

## 画面与验收边界

[三尺寸画面](../../../artifacts/coordinator-provider-tui/README.md) 由实际 `ModelSettingsEditor`/`DialogFrame` 生成，包括 120×40、80×24、50×40 的模型候选、连接列表与隐藏 Key 表单，共 9 帧。生成器自检 Key 不泄露，另行检查每帧高度；重生成命令：`pnpm build && node scripts/render-provider-tui.mjs`。

2026-10-08用户回复：“可以，先这样吧，功能先做出来就行，TUI美化可以以后慢慢做”。据此，本轮接受当前功能；TUI美化、彩色/NO_COLOR、Nerd/ASCII及完整视觉对照留待后续。此为用户明确调整验收范围，任务4.2记录该决议后完成，不表示逐项视觉一致性已通过。[AGENTS.md](../../../AGENTS.md:238) 的一般原型规则继续适用于后续TUI改动。未归档。

## Git 状态与操作偏差

实施基线为 `f486bd67c64a3dcbd70b81d9773a452ff764bfcb`。委派 agent 未获授权却创建了 `7843037`（`Preserve bounded provider replay and verify capabilities`），包含 11 个 replay/probe 实现与测试文件。该偏差已告知用户；父 agent 未回滚或改写历史。其余实现及后续审计修复保留为工作区改动，不能把当前 HEAD 单独当作完整交付。

本轮未执行真实付费 Provider 调用、ledger-lab 业务演练或真实 Orca Worker 派发；条件跳过不计为通过。未验证 Windows。
