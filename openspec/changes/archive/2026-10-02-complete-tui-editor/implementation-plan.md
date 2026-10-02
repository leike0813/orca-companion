# Implementation Plan

## 1. 实施基线与权威来源
baseline: `predecessor-contract`；直接前驱 `protect-tui-input` 已归档于 `2026-10-02-protect-tui-input`。规划与实施起点 `c1964d4913343265d20c4076ff82c5643c6cd30e`。权威为本 change specs、D-01–06、#46/#42/#45 与本轮用户批准。
冻结接缝：UiInputStore 同步 CAS；submissionId 提交前快照；Session 单活跃提交；generation 防迟到清空；回答以 interaction/revision 身份写 Branch Store。apply 前检查 archive、三份主规格、HEAD、相关符号和 clean 工作区；已核验无漂移。保存保护不得减少。

## 2. 复用与接缝
| IP-ID | 现有符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | UiDraft/createInputProtection/width | 扩展完整 draft 编辑 | 全文载荷 |
| IP-02 | PendingInteractionRecord/answerPendingInteraction | 增加创建和窄查询 | 问题权威 |
| IP-03 | buildCoordinatorGraph/foreground runtime | shared tools 同协议注册 | operation identity |
| IP-04 | submit/Composer/Workspace/reducer | 同一快照管线、底部面板 | 回答业务状态 |
| IP-05 | 现有 Vitest/PTY fixtures | 行为验收与文档同步 | 未验证平台能力 |

## 3. 代码变更映射与文件 allowlist
- **IP-01 / D-01,02,06**：修改 `src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts`、`src/interfaces/tui/input/input-protection.ts`、`src/interfaces/tui/render/width.ts`；新增 `src/interfaces/tui/input/composer-editor.ts`。新增 `tests/tui/composer-editor.test.ts`，调整 `tests/adapters/ui-input-store.test.ts`、`tests/tui/input-protection.test.tsx`、`tests/tui/width.test.ts`。映射“有界完整 composer 编辑”所有场景、“光标插入与原子粘贴块”所有场景。
- **IP-02 / D-04,06**：修改 `src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`、`src/application/coordination/pending-interaction.ts`；调整 `tests/coordination-store.test.ts`、`tests/coordination/scope-control.test.ts`。映射“可信身份与可重放用户提问”全部场景、“有界问题读取/页面与精确详情”。
- **IP-03 / D-04,05**：新增 `src/workflow/coordinator/interaction-tools.ts`，修改 `src/workflow/coordinator/graph.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`src/application/controller-service.ts`、`src/interfaces/tui/ports.ts`。新增 `tests/workflow/interaction-tools.test.ts`，调整 `tests/workflow/coordinator-tool-loop.test.ts`、 `tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/application/controller-service.test.ts`、`tests/tui/harness.ts`。映射两种模式、重放、可信身份与有界读生产接线。
- **IP-04 / D-01–03**：修改 `src/interfaces/tui/app.tsx`、`state.ts`、`screens/workspace.tsx`、`components/composer.tsx`、`interaction-card.tsx`、`command-palette.tsx`、`input/keymap.ts`；新增 `components/answer-panel.tsx`、`paste-viewer.tsx`。调整 `src/interfaces/tui/composer-prototype.tsx`、`workspace-prototype.tsx`、`project-panel-prototype.tsx` 内现有 composer/Workspace 调用者，修改 `scripts/tui-preview.mjs`。调整 `tests/tui/workspace.test.tsx`、`input-paths.test.tsx`、`interaction-card.test.tsx`、`no-side-effect.test.tsx`、`control.test.tsx`、`session-lifecycle.test.tsx`、`host-wiring.test.ts` 受影响 fixtures。映射当前 Session 面板所有场景及 editor/paste UI 场景。
- **IP-05 / D-01–06**：调整 `tests/tui/pty.test.ts`，同步 `AGENTS.md`、`docs/architecture.md`、`docs/interface-contracts.md`、`README.md`。限定审计：键位优先级、CAS/unknown 不丢输入、精确 owner、重放、渲染无写入、viewport 与查询边界。

## 4. 调用与副作用顺序
编辑纯计算 → 完整 draft 投影 → protection 合并保存；paste/switch/Esc/exit/send flush。发送先持久完整 snapshot，再原用例，最后只结清原 generation。提问验证 → 可信 ID → 精确重放查询 → writer/CAS 事务 → 回读 → 事件/result。写入或核验不确定保留输入与原身份，不换 ID 重试。详情查询只读，迟到结果按目标丢弃。

## 5. Schema、状态与持久化落实
按 D-01 与 D-06 修改 UI schema；Branch Store 采用原迁移新增可空问题字段与 options。owner/Fence/CAS 仍由 store 验证；不增加业务模式。Panel selection 与 viewer offset 为进程展示态，问题正文来自 Branch Store。

## 6. 验收证据矩阵
| Requirement/Scenario 范围 | IP-ID | 命令与证据 |
|---|---|---|
| grapheme/中间编辑/resize/阈值/原子块/非法草稿 | IP-01,04 | `pnpm exec vitest run tests/tui/composer-editor.test.ts tests/adapters/ui-input-store.test.ts tests/tui/input-protection.test.tsx tests/tui/workspace.test.tsx` |
| 重放/无效选项/分页与精确详情 | IP-02,03 | `pnpm exec vitest run tests/coordination-store.test.ts tests/coordination/scope-control.test.ts tests/workflow/interaction-tools.test.ts tests/workflow/coordinator-tool-loop.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/application/controller-service.test.ts` |
| 直接回答/Esc恢复/失败或后来编辑/上下文键位 | IP-04 | `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/no-side-effect.test.tsx tests/tui/session-lifecycle.test.tsx` |
| Ubuntu PTY尺寸120x40/80x24/50x40，粘贴、ShiftLeft、无色、退出恢复 | IP-05 | `pnpm exec vitest run tests/tui/pty.test.ts`，记录实际终端结果 |
| 真实 IME | IP-05 | 目标终端人工中文预编辑/提交验证；字节注入不充当证据 |
| 总体与合同 | IP-05 | `pnpm typecheck`、`pnpm lint`、`pnpm test --maxWorkers=8`、`pnpm build`；`openspec validate complete-tui-editor --strict`；`git diff --check` |

## 7. 升级条件
上述 allowlist 之外的新公共合同、依赖、状态机或权限须回到设计。保护用户未提交改动、不改上游、不提交/切分支、不启动开发服务器、不操作真实主项目数据库。没有人工 IME 证据时该任务不勾选，不伪造 PASS。

## 8. 验收授权与限定审计
主 agent 实施与验证；只读独立研究可委派。修复仅限上述行为与文件。apply 不创建 verification.md，不归档。先交付固定工作区 diff、测试结果和剩余人工证据。

## 9. 本轮验收记录（2026-10-02）

实现保留为工作区 diff，HEAD 为 `c1964d4913343265d20c4076ff82c5643c6cd30e`。

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test --maxWorkers=8`：145 个测试文件通过、6 个条件跳过；1369 项通过、12 项条件跳过。覆盖真实问题创建/重放/窄查询/回答、取消后拒绝新提问、原工具身份恢复、输入保护及交接回归。
- Ubuntu 真实 PTY：120×40、80×24、50×40，CJK、多行粘贴、resize、回答面板、Esc 草稿/光标恢复、无色、折叠查看、退出确认及终端模式恢复通过；直接读取 PTY 原生光标验证中文插入位置。
- 真实 IME：用户完成请求中的人工验收并反馈交互正常，原话与证据边界记录在 tasks.md。
- `openspec validate complete-tui-editor --strict`、`git diff --check`：通过。

UI schema v2 保留并拒绝打开旧格式输入库；本轮未操作用户的真实输入数据库。平台验收范围为当前 Ubuntu。
