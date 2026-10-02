# Verification

## 验收对象

- Change：`protect-tui-input`，#46 的首批 TUI 输入保护实现。
- 输入实现 HEAD：`e774b5ab97aa103d1f3c160cd9c5e3d34413551e`，以及上一轮实现完成时的未提交工作区。
- 最终验收 HEAD：同上。本次仅补充本报告，没有修改实现或创建 commit。
- 验收 Agent：Codex 主会话，按用户要求复用上下文中的实施检查和限定审计证据，不重新运行验证，也不执行新的独立代码审查。

## 结论

**PASS**，适用于上一轮已检查的工作区实现和本 change 的既定范围。18/18 项 implementation tasks 已完成；实施阶段的类型检查、lint、构建、相关行为测试、真实 PTY 检查及 OpenSpec 严格校验均通过。没有已知的范围内未解决缺陷。

本结论沿用实施阶段证据，不代表本次重新检查了工作区，也不代表上述 HEAD 单独包含尚未提交的实现。真实 Orca 的两项可选测试跳过，Windows 未验证。

## 核验与修复证据

下表中的文件与检查均指实施阶段已有证据。

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| `tui/input-protection`：仓库级持久化；重启恢复多行文本及 paste blocks；Session、回答目标和 interaction revision 隔离。IP-01、IP-03、IP-04 | `src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts`、`src/interfaces/tui/input/input-protection.ts`；`tests/adapters/ui-input-store.test.ts`、`tests/tui/input-protection.test.tsx`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 通过。UI store 位于 Git common dir 的 Companion 私有目录；各输入目标独立保存，宿主恢复沿用目标身份。 |
| `tui/input-protection`：连续编辑合并保存；粘贴立即保存；切换、退出和提交前 flush；加载不能覆盖较新的编辑；render、resize、重挂载不写入或推进运行。IP-01、IP-03 | input protection 行为测试、TUI 无副作用测试及宿主测试 | 通过。用户编辑触发有界 debounce，关键操作立即保存；保存失败保留内存输入。 |
| `tui/input-protection`：稳定 submission identity；重复 Enter 单提交；提交后继续编辑不被旧结果清空；快照失败不发送；accepted 清理、rejected 保留并释放 lane、unknown 保留占用；启动只核验已保存提交。IP-01、IP-02、IP-03、IP-04 | `app.tsx`、input protection、foreground planning runtime；输入保护、Controller 与宿主恢复测试 | 通过。先保存提交快照再 execute；恢复不自动重发，不获取 Runtime Lease 或唤醒模型。 |
| `tui/input-protection`：只读权威核验；相同 ID 不同内容冲突；他人回答不算本次成功；缺少能力或不可读时 unverifiable。IP-02 | `src/application/coordinator/submission-status.ts`；`tests/application/submission-status.test.ts`、`tests/application/controller-service.test.ts` | 通过。核验 scope、Session、目标、revision、稳定身份及内容，结果保留 accepted / not_found / conflict / unverifiable。 |
| `tui/input-protection`：双连接 CAS；删除后拒绝旧 revision；冲突选择保留另一版本；恢复前保护未保存编辑；容量与故障不静默淘汰。IP-01、IP-03 | UI store 27 项测试及 input protection 冲突、恢复、容量、失败路径测试 | 通过。短事务、单调 revision、删除 tombstone 与唯一 pending lane；有效记录上限 256、文本与 paste payload 合计上限 32 MiB；无按时间淘汰。 |
| `tui/input-protection`：有界记录管理；查看、恢复、冲突选择、删除确认及重新核验；损坏记录可见且可删除。IP-03 | `src/interfaces/tui/components/input-record-manager.tsx`；`tests/tui/input-record-manager.test.tsx` | 通过。列表至多 20 行，选中正文至多 10 行；恢复和核验不会自动提交。 |
| `coordination/scope-control`：统一 Controller 查询、命令与事件合同；stale answer 拒绝；提交必需稳定 ID；状态查询只读。IP-02 | Controller、pending interaction 与 submission status 实现；Controller、user message 和 submission status 测试 | 通过。UI 提供 submission ID，回答绑定 owner 和 expected revision，查询不产生 mutation。 |
| `coordinator/session-runtime`：已提交步骤与恢复身份；部分响应不当作已提交消息；损坏记录 fail closed；模型或工具等待期间的新用户消息不能被旧快照覆盖。IP-02 | `src/adapters/storage/checkpoint-store.ts`、runtime guard、Coordinator model/tool nodes；`tests/adapters/checkpoint-store.test.ts`、`tests/workflow/coordinator-tool-loop.test.ts` 及既有 workflow 测试 | 通过。追加操作在事务中读取最新 core，验证稳定身份与 replay，保留已提交消息、Wake Batch 和 Context Capsule；没有新增工作流状态机。 |
| `tui/execution-control`：Exit / Ctrl+C 保持 Scope 语义；原有危险操作确认；退出立即保存；保存失败默认停留并显式确认丢弃；退出后不继续推进。IP-03、IP-04、IP-05 | TUI exit、输入保护与生命周期测试；`tests/tui/pty.test.ts` | 通过。退出不隐式 Pause / Cancel；真实 PTY 验证 shell 返回状态与终端模式恢复。 |
| `tui/planning-workspace`：主视图与折叠工具记录；普通字符不触发全局操作；Esc 分层关闭；未知命令、带参数或多行 slash 不误发；粘贴只插入。IP-03、IP-05 | command metadata、slash parser、TuiApp；`tests/tui/input-paths.test.tsx`、既有 workspace 和 overlay 测试 | 通过。命令元数据为单一事实源，原始换行在 trim 前检查，拒绝路径保留输入。 |
| `tui/session-interactions`：待答优先级与焦点；新事件不抢占；切换及重启保留草稿；普通消息不满足待答问题；stale revision 拒绝；有效回答完成。IP-02、IP-03、IP-04 | Session / answer state、TuiApp、Controller、pending interaction；Session Picker、interaction 与宿主恢复测试 | 通过。回答草稿按 Session、interaction ID、revision 隔离；旧提交结果不能清空其他 Session 或后来编辑的文本。 |
| IP-04：真实宿主、preview 与生命周期接线；现有 Composer、tui-entry 接口复用；合同与文档一致 | foreground planning runtime、TUI composition、`scripts/tui-preview.mjs`；`AGENTS.md`、`CONTEXT.md`、architecture、interface contracts、development workbench 文档；bootstrap 测试 | 通过。宿主负责打开和关闭 UI store，preview 使用内存 store；IC-13 明确 UI 输入 owner，IC-04 / IC-11 / IC-12 同步相应合同。无需另建 Composer 或入口层。 |
| IP-05：任务完成度与规格完整性 | `tasks.md` 18/18 已勾选；`openspec validate protect-tui-input --strict` | 通过。planning artifacts 与实现任务完整，严格校验通过。 |

实施阶段的命令结果：

| 命令 / 检查 | 已记录结果 |
|---|---|
| `pnpm typecheck && pnpm lint && pnpm build` | 全部通过，最终执行退出码 0。 |
| `pnpm exec vitest run tests/tui tests/application tests/adapters` | 69 个文件、622 项测试通过；2 个文件、2 项真实 Orca 测试跳过。 |
| `pnpm exec vitest run tests/application tests/adapters tests/bootstrap tests/workflow` | 60 个文件、629 项测试通过，覆盖宿主重启恢复及 workflow 行为。与上一行有重叠，不能累加为独立用例数。 |
| 其中 `tests/tui/pty.test.ts` | 11 项通过；覆盖 120 / 80 / 50 列中文多行 bracketed paste、resize、退出状态和终端恢复。 |
| `openspec validate protect-tui-input --strict` | 通过。 |
| `git diff --check` | 通过。 |

验收阶段修复：无。本次仅撰写报告。实施阶段已修复并通过上述检查的问题包括：旧快照覆盖 checkpoint、冲突恢复丢失未保存文本、旧提交结果清空新输入、缺少 schema metadata 的既有数据库误接纳，以及提交身份 replay 核验不足。

## 限定审计

复用 IP-05 实施阶段限定审计结果；本次未重新审查实现。

| 范围 | 结论与已有证据 |
|---|---|
| 持久化 owner、schema、CAS、容量及故障保留 | 通过。独立 `ui.sqlite` 不承担协调权威；UI store 和 input protection 测试覆盖并发、删除、损坏记录、容量及保存失败。 |
| stable identity、unknown lane 与权威查询 | 通过。提交快照先落盘，unknown 不自动重试；查询校验精确身份，Controller 和重启恢复测试通过。 |
| checkpoint 追加与原 workflow 语义 | 通过。最新 core 上原子追加，等待期间的新消息保留；既有恢复、Wake Batch 和工具循环行为测试通过。 |
| 输入分流、焦点、退出与 UI 副作用 | 通过。严格 slash、paste 只插入、退出失败保留输入；TUI 行为测试与 11 项真实 PTY 检查通过。 |
| 有界显示、模块复用与宿主接线 | 通过。记录管理限制列表及正文投影；复用 Composer、tui-entry 与既有端口生命周期，preview 不接真实 backend；类型检查、lint 和构建通过。 |

没有遗留的范围内审计问题。长 transcript 的分页、虚拟化、懒加载及完整编辑器不在本批范围内。

## 后续注意事项

- `pty-execution.test.ts` 与 `pty-handoff.test.ts` 的真实 Orca 用例未启用；需要显式选择隔离项目、专用身份及 `ORCA_COMPANION_REAL_HARNESS=1` 才能验证，不能将本报告理解为真实生产 Orca 验收。
- 平台证据限于当前 Ubuntu；Windows 未验证。
- 完整编辑器、paste block 展示偏好及长 transcript 性能机制留待后续 change；本批落实输入保护和有界记录管理。
- 实现尚未提交，本报告绑定上一轮已检查的未提交工作区。之后若实现发生变化，应更新证据与结论；本次未提交、同步主规格或归档 change。
