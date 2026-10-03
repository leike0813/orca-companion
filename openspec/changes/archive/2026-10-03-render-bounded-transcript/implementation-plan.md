# Implementation Plan

## 1. 实施基线与权威来源

Baseline: **predecessor-contract**。Planning commit: `b15ff20d4fe7d42a218c7259fb0ebc793f24d2ae`。直接前驱 `paginate-coordinator-history` 已归档；实施前已检查主规格、HistoryReadPort、appendModelStep、UI schema 2、Coordination schema 14 和 checkpoint schema 2。HEAD 无漂移；用户工件迁移受保护。

权威：本 change specs、D-01–07、六票定稿、CONTEXT 与 IC-04/11/12/13。冻结权威正文/稳定 entry/Wake/原子接受/操作身份、lease/fencing、输入/CAS/submission 语义；扩展只读来源端口和 ephemeral preview，不新建权威历史。

## 2. 复用与接缝

| IP-ID | 复用文件/符号 | 方式 | 不复制 |
|---|---|---|---|
| IP-01 | application/coordinator/history.ts, ControllerService, TuiPorts | metadata/body 分离，预览窄端口 | SQLite/Scope 状态 |
| IP-02 | workflow/coordinator/nodes.ts, graph.ts | stream 替换单次调用，既有重试/接受 | SDK 聚合/工具身份 |
| IP-03 | project-config.ts, checkpoint-store.ts | 默认预算/依赖注入/SQL 界限 | 配置预算 |
| IP-04 | transcript.tsx, width.ts, app/state/workspace | 单个阅读模块替换整页布局 | 输入正文/总行数 |
| IP-05 | foreground-planning-runtime.ts, scope-control-service.ts | 装配/订阅/abort | 业务状态机 |
| IP-06 | 既有行为/PTY 与采集脚本 | 生产验证与新工件报告 | 旧证据/原型 |

## 3. 代码变更映射

| IP-ID | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|
| IP-01 | Bounded local transcript viewport / 折叠工具、失败；Range-aware Markdown and streaming preview / 隔离 | 修改 src/application/coordinator/history.ts、src/application/controller-service.ts、src/interfaces/tui/ports.ts；新增 src/adapters/storage/transcript-preview-store.ts | 来源 DTO、独立 metadata/body/query，stream observer，临时文件/范围/pin/64MiB64项/状态 | 正式历史事务与 authority |
| IP-02 | Streaming model response isolation、Verified streamed usage / 全部 | 新增 src/workflow/coordinator/model-call.ts；修改 nodes.ts、graph.ts；扩展 tests/workflow/coordinator-graph.test.ts、coordinator-tool-loop.test.ts、tests/support/fake-chat-model.ts | 真实 stream+等待 end callback、signal、输出 bytes、preview trusted identity、usage null、有限重试 | 完整接受前不执行工具、恢复身份 |
| IP-03 | Finite output and context read budgets / 全部 | 修改 src/bootstrap/project-config.ts、src/adapters/storage/checkpoint-store.ts；扩展 tests/bootstrap/project-config.test.ts、tests/adapters/checkpoint-store.test.ts | output.maxResponseBytes=8MiB、context.maxReadBytes=16MiB 正整数 schema；store 注入预算；有界 SQL | maxInputTokens/4096项/超限阻塞 |
| IP-04 | Bounded local transcript viewport、Range-aware Markdown and streaming preview / 全部 | 新增 src/interfaces/tui/render/transcript-reader.ts；修改 app.tsx、state.ts、components/transcript.tsx、screens/workspace.tsx；package.json、pnpm-lock.yaml；tests/tui | Marked17、source anchors、局部行/双缓存、键位/回看/resize；去除整页 wrap/count | 六票结构、grapheme/input/focus |
| IP-05 | Streaming model response isolation / 中断、存储不可用；viewport / 固定版本 | 修改 src/bootstrap/foreground-planning-runtime.ts、src/bootstrap/coordinator-runtime.ts、src/bootstrap/startup.ts、src/application/coordination/scope-control-service.ts；扩展 tests/bootstrap/foreground-planning-runtime.test.ts、tests/coordination/scope-control.test.ts | 运行时 preview store 和 observer、独立无效订阅、所有 store 预算、调用 abort 与 close、Cancel hook | Pause 在途、Exit 非取消、Worker 控制 |
| IP-06 | 全部、长历史 p95、原型 | 修改 docs/architecture.md、docs/interface-contracts.md、docs/dev/tui-implementation-handoff.md、配置文档；新增 artifacts/bounded-transcript/ 下的性能/画面报告和采集脚本；更新 AGENTS.md、README.md、docs/dev/tui-workbench.md；必要扩展 scripts/tui-preview.mjs 与 tests/tui/pty.test.ts | 三档两色图标/六票生产对照，生产 reader/workflow 长历史和1/5MiB测试，配置/合同更新 | 旧原型/旧报告不覆盖 |

## 4. 调用与副作用顺序

读取：Scope/Session 核验→有限 metadata→可见正文→局部 parse/layout→frame；请求代际失效丢弃，错误保留旧 frame。刷新只通知 selected reader，不写输入或恢复模型。

生成：可信 step/attempt→preview started→stream chunk 预算与 signal/fencing→bounded preview append→SDK 完整 end→现有 parse/appendModelStep 原子接受→preview committed→工具节点。失败/interrupted 不进入历史，预览失败不阻止模型。Cancel 先 durable intent，再 abort 当前 Scope 模型，再 Worker stop；close abort 后清理临时资源。

## 5. Schema、状态与持久化落实

Application 拥有来源/query/stream observer；preview adapter 仅存 runtime 临时文件，append revision 固定前缀，引用 pin 不复制正文。持久 schema 保持。配置 schema version 1 增加可缺省预算，bootstrap 将默认值传至所有 store/model；不做旧格式 migration。Usage 不明确时 null，输出超限/abort/fence 非重试。诊断与性能日志不进入 transcript/recent semantic events。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试/前提 | 断言 | 命令 |
|---|---|---|---|---|
| 预算默认/非法/上下文超限 | IP-03 | config/store 已有 tests | 正整数、配置生效、原文可读 | pnpm exec vitest run tests/bootstrap/project-config.test.ts tests/adapters/checkpoint-store.test.ts |
| 流式隔离/工具/失败/usage | IP-02,05 | 真 streaming fake、真实 graph/store | 零部分写入、正确 call 身份、信号/次数/usage | pnpm exec vitest run tests/workflow tests/bootstrap/foreground-planning-runtime.test.ts tests/coordination/scope-control.test.ts |
| viewport/缓存/Markdown/返回 | IP-01,04 | 生产 reader、fake range port | 来源边界、稳定位置、缓存有界、失效不抢输入 | pnpm exec vitest run tests/tui |
| 1千/1万/10万与1/5MiB p95 | IP-06 | 实际 reader/存储、≥100采样 | input/cached-nav p95≤100ms、其他成本分列 | node artifacts/bounded-transcript/benchmark.mjs |
| 三档两色/图标六票 | IP-06 | 生产 preview/真实 PTY，无外部 backend | 截图/文本/操作、原型对照/输入返回 | pnpm exec vitest run tests/tui/pty.test.ts；node artifacts/bounded-transcript/capture.mjs |
| 全项目 | 全部 | Node24/pnpm11 | 类型/lint/测试/build/strict/diff | pnpm typecheck；pnpm lint；pnpm test；pnpm build；openspec validate render-bounded-transcript --strict；git diff --check |

## 7. 文件清单与升级条件

仅 §3 中新增/修改文件，reader 必要行为测试可置 tests/tui/transcript-reader.test.ts；preview store 测试可置 tests/adapters/transcript-preview-store.test.ts；共享测试读取夹具置 tests/support/transcript-reading.ts，App 接线测试复用 tests/tui/harness.ts；不删除用户文件、不提交/切分支、不修改 references/orca。所有既有文件以 apply_patch 修改。依赖仅安装已批准 Marked17。如果公共合同、前驱、原型或 scope 必须改变，先报告并回到设计；常规实现细节沿 D-ID自主处理。

## 8. 验收 Agent 授权与限定审计

可在上述文件/测试范围直接修复复验。重点审计：真实生产接线/唯一正文、局部读取与布局、source anchor/版本、双缓存及巨大结构、取消/fencing/重试、IC-13 输入与 overlay 返回。主代理完成 TUI 原型对照，子代理只负责独立非 UI 工作，模型统一 minimax-cn/MiniMax-M3.1-Flash-Preview。verification 仅在任务完成并固定实现 HEAD 后创建。
