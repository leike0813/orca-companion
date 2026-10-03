# Implementation Plan

## 1. 实施基线与权威来源

Baseline mode: `predecessor-contract`。Planning commit: `8af15029d22ba364985abcf2cb8edbf30cc85bf2`。直接前驱 `align-tui-with-approved-prototypes` 位于 `openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/`，归档及主规格存在；第二批 `complete-tui-editor` 也已归档。实施前核验 HEAD、工作区和主规格：保留用户交接报告的归档移动。

冻结接缝：IC-13 UiDraft全文/grapheme/CAS/稳定submission/generation；IC-03 Scope权限、lease/fencing、回答owner/revision和Wake admission；IC-02 operation三值与对账；MOD-06 continuous/composer/项目/弹窗/图定稿布局。允许扩展IC-04历史读写与IC-11/12查询，禁止第二份正文、调度队列或业务状态机。权威为proposal/specs/design D-01–04、#37/#41/#46/#53与当前代码。

## 2. 复用与接缝

| IP-ID | 现有符号 | 复用方式 | 禁止复制 |
| --- | --- | --- | --- |
| IP-01 | CheckpointStore、parseCoordinatorSessionState、commit/append | 单一关联权威记录及有界查询 | 正文、provider对象、Orca事实 |
| IP-02 | runtime-guard、pendingWorkFromHistory、nodes/tool-node、foreground host | 按目的读取，保留准入/配对/消费 | 业务状态、Wake admission |
| IP-03 | ControllerTranscriptPage、projectTranscriptPage、Transcript、TuiAppContent | 有界分页/范围，复用编辑与布局 | UI历史镜像、回答管线 |
| IP-04 | Vitest、checkpoint/Wake/workflow/host测试、tuistory/PT Y | 稳定边界与实际工作量/三档画面 | 旧原型资产、模拟真实性 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
| --- | --- | --- | --- | --- | --- |
| IP-01 | 1.1 | Incremental authoritative conversation records 全部；Effective context 两场景 | application/coordinator/history.ts、runtime-guard.ts、storage/checkpoint-store.ts、domain/coordinator/session-state.ts | history DTO/schema/limits、purpose read、chunked权威正文、关联step/Wake、精确entry、metadata更新与原子追加 | Session/operation身份、压缩产物独立 |
| IP-02 | 2.1 | 上述两requirement所有scenario | application/coordinator/{submission-status,compact-session,model-config-switch,actionable-work}.ts、workflow/coordinator/{nodes,tool-node,state}.ts、bootstrap/foreground-planning-runtime.ts | 全部生产调用替换完整读改写，精确提交核验/工具恢复，有效上下文、待处理来源与回答引用 | 真实准入、unknown/fencing与Scope控制 |
| IP-03 | 3.1 | Authoritative history paging and full original text 三场景 | controller-service.ts、application/tui/view-model.ts、interfaces/tui/{ports,app,state}.tsx/ts、components/transcript.tsx、screens/workspace.tsx；scripts/tui-preview.mjs | 真cursor、范围与片段身份；页内/跨页导航/oldest/latest；失败/迟到/新内容；有界假端口可复现 | continuous与input保护、其他六票布局 |
| IP-04 | 4.1–4.3 | 全部8场景与前驱回归 | tests/adapters/checkpoint-store.test.ts、application/{wake-admission,user-message,compact-session,model-config-switch,submission-status,actionable-work}.test.ts、workflow/coordinator*.test.ts、bootstrap/foreground-planning-runtime.test.ts、tests/tui/{harness,workspace,no-side-effect,pty,input-paths}.*；必要既有port fakes；docs/{architecture,interface-contracts}.md、docs/dev/tui-implementation-handoff.md、AGENTS.md、artifacts/coordinator-history/* | 意义明确的原子/恢复/计量/分页/UTF8测试与PTY证据，文档合同一致 | 原型只读；无Git/依赖/Orca操作 |

## 4. 调用与副作用顺序

写入：外层原fencing/准入 → checkpoint短事务读取控制/精确身份 → schema核验本次载荷 → 插入entry/body/step/Wake/处理关联 → 更新graphPosition → 必要回读 → commit → 原应用层source admission与事件。异常rollback，重放同身份，不盲换operation。查询：宿主绑定Scope/Session → 校验游标/范围 → 索引读取metadata/必要块 → 返回有界DTO。UI只读并检查Session/request generation，失败保留旧页/草稿。

## 5. Schema、状态与持久化落实

见 D-01–03。CHECKPOINT_SCHEMA_VERSION=2；16KiB块、metadata100条/64KiB、body64KiB、context4MiB/4096条。旧整体库明确拒绝且保留，不升级/双读；LangGraph和其他SQLite文件不变。原entry关联处理响应只索引已提交事实，调度投影仍由Application拥有。更新metadata不回写history。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试/前提 | 关键断言 | 命令 |
| --- | --- | --- | --- | --- |
| 长历史中追加与核验；原子提交失败与重放 | 01/02/04 | checkpoint/user/Wake，临时SQLite | 实际工作量有界、双连接不丢消息、原子失败/幂等/冲突 | `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts tests/application --maxWorkers=8` |
| 精确工具恢复 | 01/02/04 | workflow/runtime fake model+真实store | 原call/operation、配对已完成不重做、100工具 | `pnpm exec vitest run tests/workflow tests/bootstrap --maxWorkers=8` |
| 压缩后继续对话；上下文读取无法安全完成 | 01/02/04 | capsule+历史、超限/损坏 | 读取跳过旧正文、历史可读、关闭无模型 | 上述storage/application/workflow命令 |
| 全历史与巨大正文；游标稳定与最早直达；失败与切会话 | 03/04 | 正式host/临时库/可延迟fake、真实PTY | keyset无重复遗漏、UTF8完整、草稿/迟到/失败、三档原型 | `pnpm exec vitest run tests/tui --maxWorkers=8`、`node artifacts/coordinator-history/capture.mjs` |
| 全部合同/冻结回归 | 04 | 当前Ubuntu | 类型/lint/build/全套行为及限定审计 | `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`、`openspec validate paginate-coordinator-history --strict`、`git diff --check` |

## 7. 文件清单与升级条件

新增history DTO、change planning、history专属工件；修改上表生产/测试/文档。必要mock适配限已有受影响consumer测试，不扩依赖。IP-02/04 的范围内审计修复还涉及 `src/workflow/coordinator/context.ts` 和 `tests/workflow/context-maintenance.test.ts`：压缩摘要覆盖完整交错区间，保留完整最新 step。既有补采脚本 `artifacts/tui-prototype-alignment/repair-20261003/capture-post-review.mjs` 删除未使用函数与 import，使仓库 lint 可运行；不改画面和原型。无需删除文件。保护references/orca、provider/Worker/调度规则、其他changes、原型与用户归档移动。公开合同变更须先同步design/IC文档，权限/依赖/迁移/批次扩张问用户；缺证据不能勾任务。

## 8. 验收 Agent 授权与限定审计

主代理完成产品实现/PTY/画面对照。只读审计核验：HIST-INCREMENTAL 全部生产调用与底层实际读写；HIST-ATOMIC Wake/响应/结果及恢复；HIST-UI 迟到/失败/草稿。可在以上文件修复范围内缺陷；不得弱化场景。apply不创建verification；完成后固定HEAD+工作区diff供独立审计，再记录验证结论。用户授权起草并实现，不含commit/archive。

## 9. 实施验收记录（2026-10-03）

实现 HEAD 保持规划基线 `8af15029d22ba364985abcf2cb8edbf30cc85bf2`；最终产品补丁固定为 [implementation.diff](../../../artifacts/coordinator-history/implementation.diff)，不含用户已有交接报告归档移动。IP-01–04 实施完成，证据见 [README](../../../artifacts/coordinator-history/README.md) 与 [限定审计](../../../artifacts/coordinator-history/audit.md)。

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；`pnpm test --maxWorkers=8` 145 文件/1392 项通过，6 文件/12 项条件跳过，覆盖 IP-01/02 指定的 storage/application/workflow/bootstrap 集合。
- 最后翻页边界修复后 `pnpm exec vitest run tests/tui --maxWorkers=8` 27 文件/184 项通过，2 条件跳过；范围内修复没有增删依赖、变更权限或修改原型。
- 两个 history 工件脚本完成真实文件 SQLite 的 1,000/10,000/100,000 条计量及 45 对正式 TUI PTY 画面；六组尺寸/配色加连续 resize、向新跨页。原型层级与草稿/光标返回由主代理核对。
- `openspec validate paginate-coordinator-history --strict`、`git diff --check` 通过。尚未同步本 change 主规格、提交或归档；3B 虚拟视窗/缓存/Markdown/流式/p95 保留下一批。
