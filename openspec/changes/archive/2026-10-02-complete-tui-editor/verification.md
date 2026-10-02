# Verification

## 验收对象

- Change：`complete-tui-editor`，#46 第二批完整编辑、原子粘贴及当前 Session 异步提问/回答闭环。
- 输入实现 HEAD：`c1964d4913343265d20c4076ff82c5643c6cd30e`，加上 2026-10-02 最终实施检查时的未提交实现工作区。
- 最终验收 HEAD：同上。HEAD 单独不包含本 change 的实现；本报告沿用最终全量测试及 PTY 验收时的工作区对象，此后仅补充原型纠偏规划、交接文档与 AGENTS.md 指针，未改本 change 的产品实现。
- 验收 Agent：Codex 主会话。按用户“凭借你的记忆”要求，复用本会话的实施检查、IP-05 限定审计、落盘记录和人工反馈；本次没有重新运行产品测试或开展新的独立代码审查。
- 依据：[proposal](proposal.md)、四份 delta specs、D-01–06、[implementation-plan](implementation-plan.md) 与 [tasks](tasks.md)。直接前驱 `protect-tui-input` 已归档，其输入保护接缝在实施前已核验。

## 结论

**PASS**，限于本 change 用户批准的完整编辑、原子粘贴、输入保护接续与当前 Session 问答功能，以及最终已检查的未提交实现工作区。7/7 实现任务完成；5 个 Requirement、13 个 Scenario、IP-01–05 与 D-01–06 均有实施和验证证据，范围内未留待补的必需审计。

用户已将当前聊天、composer 与回答的原型呈现纠偏另立为 `align-tui-with-approved-prototypes`。该项仍待实施及逐项画面对照；本报告的功能 PASS 不构成生产 TUI 已忠实迁移定稿原型的确认，也不扩大为完整历史、跨 Session 回答或真实 Provider/Orca 集成验收。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| `tui/planning-workspace`：“有界完整 composer 编辑”；中文与 emoji 中间编辑、多行与 resize、提交与上下文键位。IP-01、IP-04 | `src/interfaces/tui/input/composer-editor.ts`、`app.tsx`、`components/composer.tsx`、`screens/workspace.tsx`；`tests/tui/composer-editor.test.ts`、`workspace.test.tsx`、`input-paths.test.tsx`、`pty.test.ts` | 通过。Intl.Segmenter 保持完整 grapheme；任意位置插入/删除及上下移动、行首尾正确；Enter/Alt+Enter 与 overlay 分流；正文视窗有界，resize 保留光标，真实终端光标位于可见编辑位置。 |
| `tui/input-protection`：“光标插入与原子粘贴块”；中间粘贴保留原文、阈值与原子操作、查看与持久恢复、非法草稿失败关闭。IP-01、IP-04 | UiDraft、UI store、input protection、editor、paste viewer；`tests/adapters/ui-input-store.test.ts`、`tests/tui/composer-editor.test.ts`、`input-protection.test.tsx`、`input-paths.test.tsx`、`pty.test.ts` | 通过。CRLF/CR 规范化，保留缩进、tab 和尾空行；1000/1001 code points 阈值正确；块按身份和范围原子操作，全文唯一且容量计量一次；查看/Esc/恢复保护完整草稿和光标；非法范围/身份/光标拒绝写入，不以占位标签发送。 |
| `coordinator/user-questions`：“可信身份与可重放用户提问”；响应丢失后重放、无效选项拒绝。IP-02、IP-03 | `src/application/coordination/pending-interaction.ts`、Branch Store、`src/workflow/coordinator/interaction-tools.ts`、graph、foreground runtime；`tests/coordination-store.test.ts`、`tests/workflow/interaction-tools.test.ts`、`coordinator-tool-loop.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 通过。可信 operation identity 派生稳定问题身份；同载荷重放复用原问题，异载荷拒绝冲突；输入限额与唯一选项验证；持久化并回读后发布结果。两种模式和恢复注册接通，恢复沿原 callId/operationId，不重新创造身份。取消后拒绝新提问。 |
| `coordinator/user-questions`：“有界问题读取”；页面与精确详情。IP-02、IP-03 | Branch Store、Controller/TuiPorts 窄查询；`tests/coordination-store.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` 及问题/回答行为用例 | 通过。列表按 owner 与稳定 keyset 每页至多 20 条，详情核验 Scope/Session/InteractionId；问题正文由 Branch Store 拥有，Scope snapshot 只投影摘要，不读全库载荷或泄漏其他 Session。 |
| `tui/session-interactions`：“当前 Session 异步回答面板”；选项直接回答、退出恢复聊天、失败或后来编辑保留输入。IP-04 | `components/answer-panel.tsx`、app/state/workspace、原回答管线；`tests/tui/input-paths.test.tsx`、`interaction-card.test.tsx`、`input-protection.test.tsx`、`session-lifecycle.test.tsx`、PTY 及 bootstrap 闭环 | 通过。Shift+Left、`/answer`、Palette 同入口；选项 Enter 提交标签、Tab 切自由回答；绑定原 interaction/revision/submissionId；Esc 保存回答并恢复聊天全文/光标/块；新问题和迟到结果不抢焦点，未知/拒绝/过期不推进问题，旧受理不清空新编辑。 |
| D-01、D-06 的 schema 与恢复；IP-01、IP-02、IP-05 | `src/application/ports/ui-input-store.ts`、`src/adapters/storage/ui-input-store.ts`、`schema.ts`、`coordination-store.ts`；UI store/coordination store 行为测试 | 通过。UI schema v2 保存全文、grapheme 光标和唯一非重叠块范围；不支持的旧格式库保留并拒绝打开，不自动重建。Coordination schema 14 沿现有迁移增加可空 question 列与查询索引，旧交互不补造问题。 |
| IP-03、IP-05 生产接线与模型闭环 | graph、共享 session tools、Controller 与 foreground Bootstrap；`tests/workflow/coordinator-tool-loop.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 通过。FakeToolModel 经真实工具/存储/Controller 用例创建并读取问题，回答后继续原 Session；普通注册与恢复注册同协议。该证据不使用真实 Provider，不能记为真实 Provider/Orca 端到端通过。 |
| IP-05 三档 PTY、输入及终端恢复 | `tests/tui/pty.test.ts` 与实施期额外 Ubuntu tmux 检查 | 通过。120×40、80×24、50×40 的 CJK、多行 bracketed paste、resize、回答、Esc、NO_COLOR、粘贴查看与退出恢复已检查；额外读取 PTY 原生光标验证“首中尾”插入位置。 |
| IP-05 人工中文 IME，任务 3.3 | [tasks 中的用户反馈](tasks.md)；本会话验收请求与用户回复 | 用户反馈已完成：“我已完成人工验收，交互似乎是正常的。”按该反馈完成任务 3.3；终端及输入法名称未提供，没有独立候选窗截图，PTY 字节注入未充当真实 IME 证据。 |
| IP-05 工件、合同和总体检查 | README、AGENTS.md、architecture、interface-contracts；实施记录和最终测试日志 | 通过。公共 owner/查询/输入/工具合同同步，严格 OpenSpec 和 diff 检查通过；总体结果见下表。 |

以下为实施阶段已执行的结果，本次没有重跑这些产品检查。永久摘要见 [implementation-plan 第 9 节](implementation-plan.md#9-本轮验收记录2026-10-02)。最终全量测试临时原始日志为 `/tmp/complete-tui-editor-vitest-20261002-final-cancel.log`，本次读取其末尾，计数与记录一致；临时文件不作为唯一长期证据。

| 命令 / 检查 | 已记录结果 |
| --- | --- |
| `pnpm typecheck` | 通过。 |
| `pnpm lint` | 通过。 |
| `pnpm build` | 通过。 |
| `pnpm test --maxWorkers=8` | 145 文件通过、6 文件条件跳过；1369 项通过、12 项条件跳过。最终运行开始于 2026-10-02 19:47:48（Asia/Shanghai），耗时 184.24 秒。跳过项不计为通过。 |
| `pnpm exec vitest run tests/tui/pty.test.ts` 与三档额外 PTY 检查 | 实施阶段通过，覆盖中文、粘贴、回答、无色、resize、原生光标和终端恢复。 |
| `openspec validate complete-tui-editor --strict` | 实施阶段通过。 |
| `git diff --check` | 实施阶段通过。 |

验收阶段修复：无。本次仅补充报告和相关进度描述，不修改产品实现、任务勾选或规格来隐藏差异。

实施阶段已修复并复验的问题包括：Unicode 插入/删除后的 grapheme 与粘贴范围边界、overlay 输入优先级回归、问题切换详情迟到及随后编辑的焦点保护、取消后新增问题准入，以及 Ink native cursor 的 setter 在 effect 发布时落后一帧。光标修正改为当前 render 填入位置并由 Ink commit 发布，随后相关测试和真实 PTY 插入检查通过。

## 限定审计

复用 IP-05 实施阶段的主会话限定审计及最终回归结果；本次不宣称新增独立审查。审计覆盖全部 D-01–06 与下列接缝。

| 范围 | 结论与已有证据 |
| --- | --- |
| 完整载荷、schema、容量与保存失败 | 通过。全文只存一份，折叠范围严格验证；UI store/editor/protection 测试覆盖非法数据、恢复、CAS 与输入保留，旧库失败关闭不删除。 |
| 提问身份、owner、重放与恢复注册 | 通过。运行时提供 operation identity、scope 和 owner；问题持久回读后返回；store、工具 schema、coordinator tool loop 与 bootstrap 回归覆盖同身份重放和恢复。已有 pending `ask_user` 恢复用例断言原 callId 派生的 operationId，未以新身份重建。 |
| 回答绑定、单活跃提交与迟到结果 | 通过。继续走原完整快照、submissionId、CAS 与 generation 管线；input paths/protection 回归覆盖失败、unknown、后来输入、迟到详情、原聊天恢复和 Session 隔离。 |
| 键位分流、viewport 与 native cursor | 通过。grapheme/多行/粘贴边界行为测试与三档真实 PTY 核对；overlay 优先，Ctrl+A/E 行首尾，真实光标在当前帧发布，提交/换行不混用。 |
| 查询边界、生产接线及无副作用渲染 | 通过。列表≤20、精确详情、Scope 摘要；shared tools/Controller/Bootstrap 实际接线；既有无副作用与生命周期测试覆盖 render、resize/remount 不发送、不持久写入或推进模型/Worker。 |

本 change 批准功能范围内没有待补的必需审计或已知未解决缺陷。定稿原型一致性另由后继纠偏 change 验收，仍明确保留未完成状态。

## 后续注意事项

- 报告绑定已检查的未提交工作区，不能把 `c1964d4` 单独标为第二批实现提交。提交、主规格同步及归档尚未进行；后续产品实现变化需要更新验收对象、证据和结论。
- 用户人工 IME 反馈仅覆盖其实际验收，终端/输入法型号未提供；不能推定其他终端、输入法或 Windows 支持。当前自动/PTY 平台证据限 Ubuntu。
- 最终全量测试含条件跳过；真实 Provider/Orca 集成、Windows、图片、跨 Session 问答、完整历史/搜索和 #53 长历史性能未在本 change 验收。
- 原型 hard constraint 与来源见 [TUI 交接页](../../../docs/dev/tui-implementation-handoff.md)。当前角色标题、composer 外观和回答呈现仍需 `align-tui-with-approved-prototypes` 纠偏；其 0/6 实现任务不因本报告变为完成，不把交互反馈充当原型画面对照。
