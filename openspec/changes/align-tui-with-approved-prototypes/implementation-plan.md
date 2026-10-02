# Implementation Plan

## 1. 实施基线与权威来源

baseline: `predecessor-contract`。直接前驱：`complete-tui-editor`。规划 HEAD：`c1964d4913343265d20c4076ff82c5643c6cd30e`。当前前驱 7/7 实现任务完成，已按用户要求复用实施证据补充功能范围 verification PASS，但实现仍在 dirty 工作区、尚未归档及同步主规格；**本 change 仅规划完成，不具备当前 apply 前置条件。**

权威：本 change 的两份 delta specs、D-01–06、用户选择的当前界面纠偏范围，以及 [交接页](../../../docs/dev/tui-implementation-handoff.md) 中的最终决议与定稿资产。顺序为第二批 → 本纠偏项 → 3A → 3B → 第四至第八批。

apply 前执行 `git rev-parse HEAD`、`git status --short`、`openspec list --json`；以 `rg --files openspec/changes/archive` 定位前驱真实归档，读取其 tasks/verification/implementation-plan，核对完成与 PASS 范围。通过 `openspec show <capability> --type spec` 确认前驱同步后的 `tui/planning-workspace`、`tui/input-protection`、`tui/session-interactions` 与 `coordinator/user-questions` 主规格。记录实际实施起点 HEAD、归档路径及可归属的已有改动，不要求删除本轮已创建的规划文件。

冻结接缝：

- IC-13 的 UiDraft 唯一全文、UTF-16 grapheme 光标、`{id,start,end}` 粘贴范围、同步 CAS、提交前完整快照与稳定 submissionId；单活跃提交及 generation 防迟到清空。
- `composerViewport`/`editComposer` 的完整编辑、原子块、容量与粘贴规则；内宽可由新呈现统一传入，纯编辑语义不改变。
- IC-11 当前 Session 问题精确读取与回答入口、owner/InteractionId/expected revision、既有 accepted/rejected/unknown 处理和 Esc 恢复。
- render/effect/resize/remount 不执行持久化或业务动作；UI schema v2 与 Coordination schema 14 不变。

核对实际 UiDraft、保护模块、handleComposerKey、Composer、Workspace、AnswerPanel 及生产调用者和已有测试；前驱未归档、主规格缺失、共享接缝漂移或改动归属不明时返回规划。不得将当前 HEAD 单独当作前驱已提交实现，也不使用源码 hash 或全文件字符串匹配代替接缝核验。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
| --- | --- | --- | --- |
| IP-01 | `components/transcript.tsx` 的 Transcript、toolToggleLabel、maxLines；原型 PrototypeTranscript 的纯呈现规则 | 在生产逐行渲染内加入 continuous 标记/色边/留白 | 模拟 thought、成功标记、第二份时间线或回合实体 |
| IP-02 | Composer、composerViewport、handleComposerKey、Workspace、render/width.ts | 圆角框与统一输入内宽，现有 metrics/native cursor 和高度预算 | 第二份 UiDraft、光标或输入/提交状态机 |
| IP-03 | AnswerPanel、InteractionCard、原回答/输入保护管线 | 同一主题、反色选项及同一 Composer | 问题权威、提交结果或跨 Session 返回协议 |
| IP-04 | 现有 TUI harness、PTY/tuistory、生产 preview 与交接页 | 行为回归、三档生产画面对照、进度更新 | 原型 fixture 作为真实业务证据或第二套测试/采集框架 |

## 3. 代码变更映射

| IP-ID / D-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
| --- | --- | --- | --- | --- | --- |
| IP-01 / D-01,02,05 | 1.1–1.2 | “定稿 continuous 的当前聊天呈现”及两个场景 | `src/interfaces/tui/components/transcript.tsx`；`tests/tui/workspace.test.tsx`、`tests/tui/execution-workspace.test.tsx` | 前驱/参照核验；移除重复角色标题，保留正文，按显示宽度加入用户色边/标记、助手弱标记、紧凑工具与有界留白 | 条目身份、真实文本/detail、工具展开状态、原有读取边界 |
| IP-02 / D-03,05 | 2.1 | “定稿输入框与完整编辑能力共存”及两个场景 | `components/composer.tsx`、`render/width.ts`、`screens/workspace.tsx`、`app.tsx`；相关 width/workspace/input-paths/PTY 测试 | 圆角框、紧凑模式说明及焦点层级；统一正文内宽和键盘换行，重算框内 cursor 与占用高度 | editor 语义、UiDraft、按键职责、提交/持久化与应用 API |
| IP-03 / D-04,05 | 2.2 | “当前 Session 回答面板的定稿视觉层级”及三个场景 | `components/answer-panel.tsx`、`components/interaction-card.tsx`；input-paths/interaction-card 测试 | 问题/题序/选项/提示层级、反色与符号选中态、同一自由输入框，按真实占用布局 | owner/revision/submissionId、结果核验、Esc 恢复及无抢焦点 |
| IP-04 / D-01,06 | 3.1–3.2 | “生产界面的原型一致性证据”及两个场景；其余全部场景的回归验收 | 生产 preview、既有测试、`artifacts/tui-prototype-alignment/` 与交接页 | 隔离生产组件场景、独立 PNG/文本对照与逐项报告；更新当前实现/验证/原型状态 | 定稿源码/样例、未验证平台及后续批次未实现状态 |

## 4. 调用与副作用顺序

已有输入事件 → 以统一内宽纯计算编辑/viewport → 原输入保护管线保存；render 只读 UiDraft/投影并发布本帧原生光标。普通提交或回答仍先保存完整快照，再调用原应用用例，最后只结清对应 generation；新样式不新增 effect 或调用业务端口。面板切换、Esc 与退出沿用原 flush/恢复顺序。

问题查询、提交失败、CAS 冲突、stale revision、unknown 和迟到结果继续由前驱处理。界面只展示真实原因与状态，保留原内容/身份，不改 ID 重发、不抢焦点。前驱接缝核验失败时不修改生产代码；没有所需定稿参照时先补齐该区域来源，不猜另一套设计。

## 5. Schema、状态与持久化落实

无 schema、数据库、偏好文件、业务状态或应用公共 API 变更。MOD-06 拥有纯呈现与内宽计算；IC-11 查询/命令及 IC-13 CAS/草稿/提交权限冻结。布局计算和光标发布不持久写入。测试只使用既有隔离 fake ports/store；不操作用户真实 `ui.sqlite`、Orca 数据或主项目运行事实。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 / 证据 | Fixture/前置条件 | 关键断言 | 可运行命令 |
| --- | --- | --- | --- | --- | --- |
| continuous：当前聊天沿用连续时间线、原型演示事实不进入生产 | IP-01,04 | workspace、execution-workspace；PNG/文本对照 | 既有用户/助手/工具投影，彩色/NO_COLOR | 真实正文与工具展开仍可读，标记/色边/留白对应原型，无虚构摘要或结果 | `pnpm exec vitest run tests/tui/workspace.test.tsx tests/tui/execution-workspace.test.tsx`；`pnpm ui:preview planning` 与 `pnpm ui:preview execution` |
| 输入框：中文/粘贴块编辑、窄屏及不可提交状态 | IP-02,04 | editor、width、workspace、input-paths、input-protection、PTY | 三档宽度、正文换行边界、组合字符/emoji、多块、已有只读/拒绝 fixture | 屏幕换行与上下移动一致，实际 native cursor 在对应位置；完整草稿、块载荷和原提交身份不变 | `pnpm exec vitest run tests/tui/composer-editor.test.ts tests/tui/width.test.ts tests/tui/workspace.test.tsx tests/tui/input-paths.test.tsx tests/tui/input-protection.test.tsx tests/tui/pty.test.ts` |
| 回答：选项/自由输入、Esc 恢复、未确定状态 | IP-03,04 | input-paths、interaction-card、input-protection、session-lifecycle；生产画面 | 当前 Session 真实问题查询的 fake ports，accepted/rejected/stale/unknown 与迟到场景 | 问题绑定及提交次数正确、完整聊天恢复，新问题不抢焦点，未确定不显示成功；视觉层级逐项比较 | `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/interaction-card.test.tsx tests/tui/input-protection.test.tsx tests/tui/session-lifecycle.test.tsx`；`pnpm ui:preview answer` |
| 生产对照：三档画面、无色及尚未迁移区域 | IP-04 | `artifacts/tui-prototype-alignment/README.md`、配对 PNG/文本；PTY | build 通过；120×40、80×24、50×40 独立启动；彩色/NO_COLOR | 对聊天/输入/回答逐项记录布局、边框、留白、标记、颜色、选中态和焦点；不覆盖定稿样例或误报后续完成 | 下述 tuistory 命令；`pnpm exec vitest run tests/tui/pty.test.ts` |
| 前驱无副作用与整体完整性 | IP-01–04 | no-side-effect、TUI 行为检查及工具结果 | 前驱已归档/主规格齐全，隔离测试环境 | 重绘/resize/remount 无写入或业务动作；相关检查通过，文档与真实进度一致 | `pnpm exec vitest run tests/tui/no-side-effect.test.tsx`；`pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate align-tui-with-approved-prototypes --strict`、`git diff --check` |

生产采集复用现有工具，例如构建后执行：

```sh
pnpm exec tuistory -s tui-align-120 --cols 120 --rows 40 -- node scripts/tui-preview.mjs answer
pnpm exec tuistory -s tui-align-120 snapshot --trim
pnpm exec tuistory -s tui-align-120 screenshot
pnpm exec tuistory -s tui-align-120 close
```

同样独立启动 80×24、50×40，场景使用 `planning`、`long-cjk`、`answer`；无色启动给同一命令加 `NO_COLOR=1`。按场景编辑中文多行、插入长粘贴，打开回答并切换选项/自由输入，Esc 返回，保存 PNG 与对应 pane 文本。把工具返回的截图复制到新证据目录；记录运行环境、字体、实施 HEAD/工作区、参照路径与逐项结论。独立干净采集后，再用现有 PTY 用例验证 resize/退出及终端恢复。若现有 fixture 不能呈现不可提交状态，仅扩展生产 preview 的隔离 fixture，不新增应用合同。

优先复用/调整现有测试；仅对新增的几何风险补代表性行为用例。新增失败必须意味着可观察的编辑、焦点、输入保存或提交行为被破坏；不用整屏 snapshot、完整文案/空白或内部组件结构证明视觉通过。仅有自动测试和第二批 IME 反馈不足以勾选原型对照任务。

## 7. 文件清单与升级条件

- **生产修改**：`src/interfaces/tui/components/transcript.tsx`、`composer.tsx`、`answer-panel.tsx`、`interaction-card.tsx`，以及 `src/interfaces/tui/render/width.ts`、`screens/workspace.tsx`、`app.tsx`。主题只复用已有 `theme.ts`，不新增主题模块。
- **测试最小修改范围**：`tests/tui/workspace.test.tsx`、`execution-workspace.test.tsx`、`width.test.ts`、`input-paths.test.tsx`、`interaction-card.test.tsx`、`pty.test.ts`；editor/input-protection/no-side-effect/session-lifecycle 用例优先原样运行，不为形式完整扩大修改。
- **预览/证据/交接**：必要的 `scripts/tui-preview.mjs` 隔离场景补充；新增 `artifacts/tui-prototype-alignment/README.md` 和场景配对 PNG/文本；更新 `docs/dev/tui-implementation-handoff.md` 的当前状态、证据及归档后的链接，维护 `AGENTS.md` 必读入口。
- **只读保护**：所有已确认原型源码、final/custom-direct 样例及独立归档；前驱非本 scope 改动、IC-11/13、domain/application/workflow/storage/bootstrap、依赖锁文件与 `references/orca`。不删除文件，不创建额外通用组件或采集框架。

超出上述呈现/几何范围、需要新可信数据合同或修改业务/持久化规则时回到设计。字体环境差异记录为验收条件，不以它为由重开已定稿视觉选择。保留用户改动，不提交、切分支、归档前驱或启动开发服务器。

## 8. 验收 Agent 授权与限定审计

主 agent 亲自实施和核对原型；独立调研可按项目委派规则进行。验收范围为四个 Requirement、九个 Scenario 与 IP-01–04，限定审计标签为：原型来源、真实事实、内宽一致性、native cursor、回答绑定/unknown、无副作用及证据范围。

允许验收阶段在本 allowlist 内修复并复验呈现/几何回归；业务、持久化、权限和后续批次职责受保护。完成任务后固定实际实施对象再进入 verification；apply 不创建 verification.md。将实现、行为检查、原型对照、提交/归档分别写入交接页，本轮工件创建不表示这些实施任务已完成。
