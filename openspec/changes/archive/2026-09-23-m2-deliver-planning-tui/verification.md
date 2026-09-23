# Verification

## 验收对象

- Change：`m2-deliver-planning-tui`（`orchestrated-delivery`）
- 输入实现 HEAD：`de630638c6084978bc0f88eb5187e716c0db7cfd`
- 最终验收 HEAD：`de630638c6084978bc0f88eb5187e716c0db7cfd`（验收对象包含当前未提交工作树）
- 验收 Agent：Codex（GPT-6）

## 结论

**PASS。** 14/14 项任务已勾选；10 项 Requirement、36 个 Scenario 与 IP-01～IP-11 已按实现、组件/PTY 测试和限定审计核对。真实 PTY Handoff 在用户指定的一次性隔离仓库、专用 Orca terminal 与 `.env.smoke` 的 MiniMax-M3 配置下实际运行并通过；全量门禁也在最终产品工作树上通过。结论限于当前 Ubuntu 本机、当前未提交工作树及已验证的规划 TUI 范围。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 前台入口与 TTY 门禁：无 TTY 拒绝、无 TTY `status --json`、非法子命令；IP-01、IP-02 | `src/interfaces/cli/{argv,main}.ts`、`src/bootstrap/tui-entry.ts`；`tests/tui/{pty,status-json}.test.ts`；依赖版本见 `package.json` | 三个 Scenario 的本地测试通过；双 TTY 判断先于 Ink 动态导入。 |
| Home Scope 恢复：唯一匹配、无匹配、旧记录迁移、非 canonical worktree；IP-04 | `src/bootstrap/{composition,foreground-planning-runtime}.ts`、`src/interfaces/tui/screens/home.tsx`；`tests/tui/{home,host-wiring}.test.tsx`、`tests/coordination/scope-binding.test.ts` | 四个 Scenario 的本地测试通过；Scope 由 Git common dir、完整 ref 与登记 worktree 解析，旧记录需 Review。 |
| 向导：最小原子创建、不收集预算权限、核验失败、确认前退出；IP-04 | `src/interfaces/tui/screens/wizard.tsx`、`src/bootstrap/foreground-planning-runtime.ts`；`tests/tui/{wizard,host-wiring}.test.tsx` | 四个 Scenario 的本地测试通过；初始化复用受控 Scope 用例。 |
| 主视图：窄屏、工具折叠、普通字符、逐层 Esc；IP-03、IP-05 | `src/application/tui/view-model.ts`、`src/interfaces/tui/app.tsx`、`src/interfaces/tui/state.ts`、`tests/tui/{workspace,input-paths,status-json}.test.*` | 四个 Scenario 的本地测试通过；`status --json` 保持 schemaVersion 1。 |
| 信息分层：维护噪声过滤、语义事件进入 Drawer；IP-07 | `src/interfaces/tui/components/event-drawer.tsx`、`tests/tui/event-drawer.test.tsx` | 两个 Scenario 的本地测试通过。 |
| Sidebar 与显示宽度：CJK resize、折叠保持、窄屏 Inspector；IP-06、IP-10 | `src/interfaces/tui/{components/sidebar,render/width}.ts*`、`tests/tui/{width,pty}.test.ts` | 三个 Scenario 的本地测试通过；PTY 用例覆盖 resize 和终端恢复。 |
| Session Picker 与回答绑定：待答优先、事件不抢焦点、草稿保留、普通消息不回答、stale 拒绝、有效回答；IP-07、IP-08 | `src/interfaces/tui/app.tsx`、`src/interfaces/tui/state.ts`、`tests/tui/{session-picker,interaction-card}.test.tsx` | 六个 Scenario 的本地测试通过；提交携带 interaction ID 与 expected revision。 |
| 会话维护、模型配置与规划交接：compact、能力缺失、上下文耗尽、运行中切换拒绝、审阅/cutover、灾难路径；IP-11 | `src/bootstrap/{doctor,foreground-planning-runtime}.ts`、`src/interfaces/tui/app.tsx`、`tests/tui/{session-lifecycle,host-wiring}.test.*` | 六个 Scenario 的组件与真实本地 store 接线测试通过；真实 Handoff 证据见下行。 |
| 真实 PTY 规划 Handoff；IP-11、任务 4.3 | `ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=/home/joshua/Workspace/Artifact/orca-companion-test ORCA_COMPANION_REAL_IDENTITY=term_201511b8-7eec-4d98-89a5-3e61427e0666 node /tmp/orca-companion-m2-launch.mjs pnpm exec vitest run tests/tui/pty-handoff.test.ts --no-file-parallelism --reporter verbose`；临时 launcher 从 `.env.smoke` 向子进程环境注入凭据，不输出或写入密钥 | **1/1 passed，实际运行 18.878 秒**。前置检查确认项目默认模型为 MiniMax-M3、专用 terminal 是该 worktree 的预期身份；PTY 中完成 prepare、Review、cutover；持久化记录确认规划责任归 Target，Target 仍 `awaiting_user_prompt`。隔离项目 Route Map 为 GitHub issue #1。 |
| Graph Inspector：只读检查、依赖导航；IP-08 | `src/interfaces/tui/components/graph-inspector.tsx`、`tests/tui/graph-inspector.test.tsx` | 两个 Scenario 的本地测试通过。 |
| 零副作用：重挂载、事件批量；IP-09 | `src/interfaces/tui/{app,state}.ts*`、`tests/tui/{no-side-effect,pty}.test.*` | 两个 Scenario 的本地测试通过；验收阶段修复了逐事件更新，将同轮事件合并为一次有界刷新，并过滤近期重复 event ID。 |
| 全量门禁；IP-01～IP-11、任务 4.4 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-planning-tui --strict` | 最终产品工作树退出码 0；115 个测试文件通过、4 个默认门禁跳过，1012 个测试通过、7 个默认门禁跳过；构建成功，OpenSpec strict valid。真实 Handoff 已按上一行独立开启并通过。 |

验收期间修复：`src/interfaces/tui/app.tsx` 与 `state.ts` 将高频事件合并为一次有界展示态刷新，并按 event ID 过滤近期重复投递；`tests/tui/no-side-effect.test.tsx`、`session-picker.test.tsx` 补齐可观察行为断言。`src/bootstrap/doctor.ts` 与 `foreground-planning-runtime.ts` 将前台身份探测限定到当前 canonical worktree，避免从其他项目的活动 terminal 猜调用者。`tests/tui/pty-handoff.test.ts` 增加项目默认模型和预期 Orca 身份的前置核验。相关测试、真实 PTY 用例及最终全量门禁均通过。

## 限定审计

- `zero-side-effect`：核对 `app.tsx` 的 render/effect/resize 路径及 `no-side-effect`、PTY 测试；修复事件逐条刷新后相关用例通过，未发现渲染触发业务 mutation。
- `tty-gate`：核对 `runTuiEntry` 双流门禁与 Ink 动态导入顺序，PTY/非 TTY 测试通过。
- `scope-identity`：核对 Git common dir、完整 ref、canonical worktree 解析及 Home/旧记录用例；前台身份探测改为只查看当前 worktree 的 Orca terminal，真实用例确认所选身份是专用 handle；没有发现隐式 Scope 创建。
- `interaction-binding`：核对 Answer 模式传递 interaction ID、expected revision 与 stale 拒绝测试；通过。
- `session-lifecycle-gate`：核对 compact、Model Picker、Handoff 的本地测试与宿主接线；真实 PTY 用例对模型、专用身份、prepare/review/cutover 与 `awaiting_user_prompt` 的断言全部通过，灾难路径的本地故障用例通过。限定审计已完成。

## 后续注意事项

隔离仓库 `/home/joshua/Workspace/Artifact/orca-companion-test` 已完成一次 Handoff；重复运行需使用新的隔离 Scope 或重建测试状态。该仓库留有未提交的 `orca-companion.json`（不含密钥）、Git common dir 下的本次状态，以及原有 M1 状态备份 `.git/orca-companion.m1-backup-20260923`；Route Map issue #1 保留。验收用专用 Orca terminal 已关闭。Windows、无人值守和执行阶段 TUI 不在本次结论范围内。
