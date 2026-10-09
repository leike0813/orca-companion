# Implementation Plan

## 1. 实施基线与权威来源

baseline mode: `predecessor-contract`；planning commit: `c988b89`。直接前驱 `rework-coordinator-provider-configuration` 已于2026-10-08归档，主规格 configuration/model-settings、coordinator/session-runtime 存在。核验固定协议 adapter、ProviderLibrary/CredentialStore、配置 schema5 与不可变 configurationRef、串行工具 append、IC-04/11/12/13/14；原 doctor 四文件未提交改动保留。此 change 明确解阻塞 active ledger-lab，共享文件只由一个 owner 编辑。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | workflow/coordinator/graph、nodes、model-call；checkpoint-store | 小图与增量历史、独立轮次表、共享驱动 | 不保存第二份正文、协调状态或凭据 |
| IP-02 | foreground-planning-runtime 的 runModelLoop、maintenance、execute | 全入口停止检查与明确恢复 | 不绕过 lease/unknown operation |
| IP-03 | tool-definition、tool-node、原只读 adapters | 固定工具 schema 与取消上下文 | 不使用任意 shell |
| IP-04 | ProviderLibrary、resolveChatModel、capability-probe、checkpoint/context | 独立 debug host/session registry、真实固定 SDK | 不借用 Scope/Graph |
| IP-05 | App、Workspace、Transcript、Composer、transcript-reader、input-protection、commands | 共用对话组件、明确 debug target、命令过滤 | 不创建假 snapshot、不复制编辑器 |
| IP-06 | CLI main、tui-entry；Vitest、tuistory | 真实 CLI/PTY 与 SDK 服务验证 | 不用 preview 代替生产链路 |

## 3. 代码变更映射

| IP-ID | Requirement/Scenario | 文件与精确变化 | 决策 |
|---|---|---|---|
| IP-01 | Trusted configuration and durable turn termination 全部；Classified bounded model retries 全部 | application/ports 新 turn port、workflow 新 turn driver；checkpoint-store 增量迁移；nodes/model-call 必填 binding 与错误分类；graph/tool-node 取消；更新所有 graph callers/tests/preview fixture | D-01/02 |
| IP-02 | Halted turn overrides automatic wake；停止后明确恢复；退出时取消流 | foreground-planning-runtime 装配 binding/driver、停止所有 wake/maintenance、retry核验；controller snapshot 投影 failure；ports 新意图/abort；相关宿主测试 | D-03 |
| IP-03 | Bounded read-only debug tools | workflow 新 debug-tools 与 adapters 新 bounded filesystem tools；代表性路径/配对/取消测试 | D-05 |
| IP-04 | Independent persistent debug conversations | bootstrap 新 debug-runtime、storage debug registry；Scope-free user admission/context；ProviderLibrary 配置快照复用；bootstrap capability probe 和 XDG路径；debug-runtime tests | D-04 |
| IP-05 | Shared conversation and explicit loop controls 全部；Debug input identity isolation 全部 | tui app/workspace 共用 conversation；debug app shell；commands/ports/input target/input-protection/store/input manager 及所有消费者；保留旧 target keys，新增 debug keys；输入与命令测试 | D-06 |
| IP-06 | Real harness end-to-end verification；全部真实行为证据 | CLI --debug、tui-entry；tests/integration 新真实 CLI/SSE/PTY tests；artifacts 新隔离证据；docs architecture/contracts/tui交接/CLI指南、AGENTS关键约束 | D-07 |

## 4. 调用与副作用顺序

read identity/config/history/lease → durable running → 模型调用与append完整step → 串行工具配对及续接 → idle。每次模型调用最多三次尝试。任何故障先停止本地 latch/abort/pending wake/维护，再尝试保存 halted 与结构化原因。running 未落盘不能发送请求。明确retry核验未知操作后才清除停止。退出先abort再输入保存。debug提交先保存完整UiDraft+submissionId，再沿可信Session写入消息；未知提交只核验不重发。

## 5. Schema、状态与持久化落实

checkpoint新增轮次表独立于正文，旧记录不重写。debug session使用真实独立session ID与目录namespace；Wake/user source新增明确debug判别，旧Scope记录保持。UiInputTarget新增debug-message，旧message/answer keys/schema读取稳定。所有新持久JSON运行时校验、有限长度，无secret。错误码和状态做契约断言，文字不做snapshot。

## 6. 验收证据矩阵

| 场景 | IP-ID | 关键断言 | 可运行命令 |
|---|---|---|---|
| 结构化响应、重试分类、工具串行续接/取消 | IP-01/03 | binding正确、最多3次、内部错误1次、配对历史 | `pnpm exec vitest run tests/workflow` |
| 内部故障、轮询/新消息/重启、明确恢复 | IP-01/02 | 请求停止、running恢复闸、原身份不变 | `pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts` |
| 路径逃逸、有界读、search/diff、非Git | IP-03 | 结构化拒绝、无写入、取消 | `pnpm exec vitest run tests/adapters` |
| 普通目录继续与输入恢复 | IP-04/05 | 同Session/配置/UiDraft/提交ID；无Scope | `pnpm exec vitest run tests/bootstrap tests/tui` |
| greeting/tool/错误/取消/重启本地正式SDK | IP-06 | 服务请求数、提交历史、无残留请求 | `pnpm build` 后 `pnpm exec vitest run tests/integration` |
| 类型/风格/构建/规格 | 全部 | 无回归 | `pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate stabilize-agent-harness-core --strict` |
| MiniMax smoke | IP-06 | 新隔离Session、有总请求上限 | 新增受限smoke脚本，实际命令与输出记录于本文件验收段 |

## 7. 文件清单与升级条件

允许新增 turn port/driver、debug-runtime/session registry/tools/app、integration fixtures/tests/artifacts；修改上表既有文件和直接caller/test/exports，以及本change工件和openspec/config。保护ledger-lab现场、四文件doctor改动、上游submodule及用户未提交内容。不得安装依赖、改Git历史或提交。若需改变已批准UI布局、权限、业务身份或新增依赖，回到设计并向用户说明。

## 8. 验收 Agent 授权与限定审计

审计所有模型调用入口/自动重试与维护、未知mutation重放、request前持久闸、exit取消、所有新target判别/keys、真实debug装配。独立审计只读；最终acceptance由主agent负责。Windows、完整Orca业务lab和新IME人工证据不在本change内，跳过必须明确记录。

## 9. 实施核验记录（2026-10-09）

实现与证据见 [Agent harness 核心实施证据](../../../artifacts/agent-harness-core/README.md)。正式 CLI/PTY/SDK/HTTP-SSE 的8项用例已通过，覆盖问候、工具配对与详情、429/400/断连、停止后新输入/重开、明确恢复、探测中Ctrl+C、SSE中Ctrl+C、SIGTERM和SIGKILL。响应提交失败回归进一步验证共享驱动仅请求一次并持久停止；生产探针取消、并发retry、context耗尽和debug单写者有独立回归。

新隔离MiniMax实测命令为 `node artifacts/agent-harness-core/minimax-smoke.mjs /home/joshua/.local/state/orca-companion/ledger-lab/ledger-lab-main-20261009082337625-898346b7/repo/orca-companion.json`，9/12个真实后端请求、配对read_file、退出后活跃请求0。三种终端尺寸及有色/无色共54个最终画面已对照；实际证据目录与检查结果在上述README。原lab未打开或推进。

这是未提交工作区的实施核验；未创建verification.md、未归档。Windows、IME人工验收及完整Orca业务lab保留未验证状态。
