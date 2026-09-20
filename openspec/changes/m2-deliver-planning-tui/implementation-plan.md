# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`。
- **规划 commit**：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（十个规划包共同起草时的 `git rev-parse HEAD`）。apply 首步必须记录实际 HEAD，并确认直接前驱 `m1-evolve-execution-graph` 已归档且冻结接缝与实现符号一致。
- **直接前驱**：`m1-evolve-execution-graph`。
- **架构合同**：`docs/architecture.md` 的 MOD-05、MOD-06、MOD-07，以及 `docs/interface-contracts.md` 的 IC-04、IC-05、IC-11、IC-12。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Extend | IC-12：`TuiViewModel`、`projectTuiViewModel`、planning React components | 沿用 M0 的 CLI/lifecycle owner，不创建第二 projection 或进程入口 |
| Consume | IC-11：`ControllerService`、`ControllerSnapshot`、`SemanticEvent`、commands | 所有业务事实和意图只通过 façade；组件不得直连用例/store/backend |
| Consume | IC-04、IC-05（仅经 IC-11） | 不复制 Session、Wake、Planning、Authorization 或 GraphHistory 类型 |

若 ControllerService、projection owner 或 TTY lifecycle 语义漂移，停止实施并先更新架构合同。
- **冻结接缝**（实施前逐项与实际文件/符号对齐，任一漂移即回到规划）：

  1. `src/application/controller-service.ts` 向界面暴露的运行时校验快照、语义事件订阅与服务意图入口；本 change 只消费，不另建 controller port；
  2. Branch Coordination State 中的 Scope identity（Git common dir 与完整 branch ref）、Planning Cycle、Coordinator Session registry 与 Pending Interaction（含 interaction ID 与 expected revision）；
  3. `ExecutionGraphHistory` 经 `ControllerService` 投影的 GraphVersion 拓扑与 admission/authorization readiness；
  4. Pending Interaction 的 deterministic resolution 与 CAS 语义（过期 revision 必须拒绝）；
  5. #31 的 `CompactionOutcome`（含 `compaction_degraded`、`context_exhausted`）与维护 lane 当前状态/有限 cycle 上限的只读快照；不假定未定义的 cache idle 配置；
  6. #32 的 `PlanningHandoffProposal`、Target Session、Cutover CAS 与 `awaiting_user_prompt` 激活门；
  7. #33 的当前 Coordinator Model Configuration 与切换准入条件（仅 Session suspended 且无在途模型操作）。

  Patch/Revision/Replanning/Cutover 只作为只读投影来源，本 change 不新增其入口。
- **需求事实源**：本 change 的 proposal、四个 capability 的 delta spec 与 design D1–D10；不修改 `openspec/specs/` 下任何主规格。
- **依赖与命令存在性**：`package.json` 当前声明 `typecheck`、`lint`、`test`；M0 负责建立 `build`，实施时若缺失即升级询问。新增依赖只有 `ink@7.1.1`、`react@19.3.0`、`@types/react@19.3.0`、`ink-testing-library@4.0.0`（依据 [docs/research/ink-react-terminal-constraints.md](../../../docs/research/ink-react-terminal-constraints.md)）。
- **环境边界**：当前 agent shell 非 TTY 且 `TERM=dumb`，所有 TUI 断言必须经 PTY（`tmux` 或 `script`）运行；不得在裸 shell 中运行 TUI 用例。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-02 | `src/bootstrap/` 的配置、依赖注入与进程生命周期入口 | 在同一入口前插入 TTY 检查，再挂载 Ink | 不新建第二个进程入口或重复解析配置 |
| IP-03 | `src/application/controller-service.ts` 的 `ControllerSnapshot`、语义事件与命令 | 直接消费并映射为展示 view model；意图提交走同一 façade | 不定义第二个状态 DTO，不在 TUI 内重建 Scope/Session/Pending Interaction 状态 |
| IP-03 | `src/interfaces/cli/` 的 `status --json` 装配 | 与之共用同一快照投影函数 | 不在 CLI 与 TUI 各写一份字段映射 |
| IP-04 | `src/application/planning/initialize-scope.ts` 的 `initializeCoordinationScope` | 向导确认后调用该既有初始化用例 | 不直接写 SQLite，不复制 Scope identity 或初始化事务 |
| IP-05 | `src/interfaces/tui/` 既定职责（transcript、composer、sidebar、Graph Inspector 与输入映射） | 全部新建于该目录 | 不让 TUI 调用 Orca、恢复模型或实现重试 |
| IP-06 | `docs/research/ink-react-terminal-constraints.md` 的 resize 与 raw mode 结论 | 直接作为实现与测试依据 | 不把 `ink-testing-library` 的 mock `isTTY` 当作 TTY 语义证据 |
| IP-11 | #31 的 `CompactionOutcome`、#32 的 `PlanningHandoffProposal` 与 Cutover CAS、#33 的 Model Configuration 与切换准入 | 经 `ControllerService` 提交 `/compact`、模型切换与 planning handoff 意图，只读投影结果 | 不在 TUI 内实现压缩、切换、交接或对账；不复制 Capsule 结构或预算计数 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | 全部（依赖前提，对应 D9） | 修改 `package.json`、`pnpm-lock.yaml` | 新增四项依赖与 `bin`/`start` 入口声明 | 不新增第二套测试运行器，不改 `engines`/`packageManager` |
| IP-02 | 1.2 | 前台入口与 TTY 门禁（3 个 Scenario） | 修改 `src/bootstrap/`（`main`/`runTui` 等入口符号）；新增 `src/interfaces/cli/argv.ts` 的子命令解析 | 解析 `[repository-path]`、`status`、`doctor`；非 TTY 时在 `render()` 之前写 stderr 并非零退出；不识别 `run`/`resume`/`tui` | 不改 `status --json`/`doctor` 现有输出契约与退出码 |
| IP-03 | 1.3 | 常驻主视图与信息分层（前置） | 新增 `src/application/tui/view-model.ts`（`TuiViewModel`、`projectTuiViewModel`）；修改 `src/interfaces/cli/` 的 `status --json` 装配以复用 ControllerSnapshot 的公共投影 | 从已校验 `ControllerSnapshot` 派生展示模型；只消费 ControllerService 已过滤的语义事件 | 不重定义 ControllerSnapshot/SemanticEvent，不暴露 OperationId 等责任元数据 |
| IP-04 | 2.1 | Home 的 Scope 恢复与查找；初始化向导的核验与原子创建（6 个 Scenario） | 新增 `src/interfaces/tui/screens/home.tsx`、`src/interfaces/tui/screens/wizard.tsx`；装配 `initializeCoordinationScope` | Home 按 Git common dir 与完整 ref 查询；向导只核验 repository 与 worktree、Orca 能力与身份、Coordinator Model Configuration 与 tracker；Review 确认后单次调用既有初始化用例 | 不在向导内直写存储；不复制初始化规则；不收集预算、Worker Profiles、权限或风险 |
| IP-05 | 2.2 | 常驻 transcript 与 composer 主视图（4 个 Scenario） | 新增 `src/interfaces/tui/screens/workspace.tsx`、`src/interfaces/tui/components/{transcript,composer,status-line,top-bar,command-palette}.tsx`、`src/interfaces/tui/input/keymap.ts` | 顶栏/transcript/composer/状态行常驻；工具记录默认折叠；固定全局键位；Command Palette 承载全局命令入口 | 不在输入映射处理业务语义；不解析自由文本推断 intent |
| IP-06 | 2.3 | 三态 Sidebar 与渲染保真（3 个 Scenario） | 新增 `src/interfaces/tui/components/sidebar.tsx`、`src/interfaces/tui/render/width.ts`（显示宽度、换行、按宽度裁切） | 以偏好上限与终端宽度决定密度；按显示宽度换行与裁切 | 不用字符数代替显示宽度；不引入第三方宽度库 |
| IP-07 | 3.1 | Session Picker 与焦点约束（3 个 Scenario）；信息分层（Event Drawer 部分） | 新增 `src/interfaces/tui/components/session-picker.tsx`、`src/interfaces/tui/components/event-drawer.tsx` | 恢复上次选择；无记录时优先待答 Session；新事件只加标记；每 Session 独立草稿与滚动位置 | 不在事件到达时切换 transcript 或改变 Scope 级图 |
| IP-08 | 3.2 | 只读 Graph Inspector（2 个 Scenario）；Pending Interaction 回答绑定（3 个 Scenario） | 新增 `src/interfaces/tui/components/graph-inspector.tsx`、`src/interfaces/tui/components/interaction-card.tsx` | Inspector 沿依赖导航且只读；interaction 卡片以内联方式提交绑定 revision 的回答 | 不在 Inspector 内修改图或授权；不接受 revision 已过期的回答 |
| IP-11 | 3.3 | 会话维护、模型配置与 Route Planning Handoff（5 个 Scenario） | 新增 `src/interfaces/tui/components/{model-picker,handoff-review}.tsx`；修改 `src/interfaces/tui/components/command-palette.tsx`、`src/interfaces/tui/components/status-line.tsx`、`src/application/tui/view-model.ts` | 在既有 Command Palette 接入 `/compact`、Model Picker 与 Handoff prepare/review/cutover；投影 `compaction_degraded`、`context_exhausted`、handoff review 与 `awaiting_user_prompt`；准入不满足时禁用提交 | 不新增页面；不在 TUI 内执行压缩、切换或交接；fail closed 时显示 blocker |
| IP-09 | 4.1 | 渲染与重挂载零业务副作用；其余可用组件测试覆盖的 Scenario | 新增 `tests/tui/*.test.tsx`、`tests/tui/status-json.test.ts` 与 `tests/tui/pty.test.ts`，共用 `tests/tui/harness.ts` | 用 `ink-testing-library` 驱动交互并断言帧；用 `node:child_process` 调 `script -qec` 覆盖无 TTY 拒绝与 PTY 启动/退出 | 不用该库断言 TTY 语义；不精确断言整屏 snapshot 或大段文案 |
| IP-10 | 4.2 | resize 后宽字符不失配；终端过窄时不遮挡主视图 | 修改 `tests/tui/pty.test.ts`、`tests/tui/pty-fixture.ts`；修改 `docs/` 用户说明 | 保活进程后发 SIGWINCH 断言重排与边框对齐；记录只支持当前 Ubuntu 本机 | 不声明 Windows 或后台运行支持 |

删除文件：无。

## 4. 调用与副作用顺序

1. **启动**：`main` 解析 argv → 判定子命令。`status`/`doctor` 直接走既有 CLI 路径；TUI 路径先查 stdin 与 stdout 的 TTY，任一无 TTY 写 stderr 并非零退出（D1），通过后才 `render()`。
2. **加载**：TUI 挂载后从 `ControllerService` 读取一次 `ControllerSnapshot`，随后仅通过其语义事件流增量更新展示态。渲染路径不得发起查询、写入或重试（D4）。
3. **Home**：以 Git common dir 与完整 branch ref 查询 Scope。命中则恢复上次 Session；未命中进入向导。查询失败按 blocker 展示（D2）。
4. **向导**：逐步核验 repository 与 canonical worktree、Orca 能力与身份、Coordinator Model Configuration 与 tracker，不收集任何预算或权限。任一步失败停留原步骤且不持久化。Review 确认后只提交一次初始化意图；应用层以单事务写入，失败则整体回滚并回到向导（D3）。
5. **对话**：composer 提交普通消息或 Answer 模式回答。Answer 提交携带 interaction ID 与 expected revision；应用层 CAS 失败时返回 stale，界面提示重读并保留输入内容（D6）。
6. **事件**：语义事件进入 Event Drawer；keepalive、轮询超时、重复事件与无变化对账在投影函数中被过滤，不进入任何用户可见时间线。事件只更新标记，不改变选中 Session（D4、D5）。
7. **resize**：只重算布局与显示宽度，不重新查询快照，不改变 Sidebar 密度的用户偏好（D5、D8）。
8. **会话维护与配置切换**：用户从 Command Palette 触发 `/compact` 或经 Model Picker 选择配置。TUI 只在准入条件满足时提交意图（`/compact` 在 Session 挂起时先由 Controller 取得 Runtime Lease；Model Picker 要求 Session suspended 且无在途模型操作），随后只展示 Controller 返回的结果与 `compaction_degraded`、`context_exhausted` 状态；不自动 fallback（D10）。
9. **Route Planning Handoff**：`/handoff` 通过 `ControllerService` 创建 `PlanningHandoffProposal`；Review 界面展示 Capsule 摘要、Target 与待转移责任。用户确认后提交既有 cutover 意图，界面自动选中 Target、Source transcript 转为只读，Target 显示 `awaiting_user_prompt`。Capsule 生成失败或 checkpoint 不可恢复时，界面显示 Scope blocker 且不激活 Target（D10）。

失败与回滚：向导失败不产生部分状态；快照不可用时展示 blocker 而不推断；任一渲染异常不得触发重试或写入。

## 5. Schema、状态与持久化落实

- **SSOT**：Scope、Planning Cycle、Coordinator Session registry 与 Pending Interaction 的权威在 Branch Coordination State（`coordination.sqlite`）；TUI 只读投影，不直接打开该文件。预算、Worker Profiles、权限、Git 集成策略与 accepted risks 的权威在 Execution Authorization Manifest，初始化阶段不存在这些记录。
- **checkpoint**：transcript 内容来自 Coordinator Session checkpoint；TUI 不写入。
- **本 change 新增的本地状态只有进程内展示态**：选中 Session、Sidebar 密度、composer 草稿、滚动位置。进程退出即丢弃，不引入新表、新文件或新 migration。
- **权限**：TUI 不具备任意 shell、任意 Orca command、直接 SQL 或通用文件编辑能力；所有意图提交经应用层受控用例，并沿用既有 scope、ownership、revision 与预算校验。
- **错误语义**：stale revision 必须拒绝；unknown 结果按待对账展示；无 TTY 以非零状态拒绝。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 前台入口与 TTY 门禁（全部 3 Scenario） | IP-02 | `tests/tui/pty.test.ts` | 非 TTY 管道子进程；`script -qec` 提供的 PTY；`status --json` 无 TTY 调用 | 非 TTY 启动非零退出且 stdout 无渲染帧；`status --json` 零退出且 stdout 可解析；`resume` 被拒绝 | `pnpm test -- tests/tui/pty.test.ts` |
| Home 的 Scope 恢复与查找（2 Scenario） | IP-04 | `tests/tui/home.test.tsx` | fake 快照端口：有/无匹配 Scope | 命中时进入恢复且不调用创建；未命中时进入向导且无写入调用 | `pnpm test -- tests/tui/home.test.tsx` |
| 初始化向导的核验与原子创建（4 Scenario） | IP-04 | `tests/tui/wizard.test.tsx` | fake 初始化端口：成功、单步核验失败、确认前退出、完整走完向导 | 确认后恰好一次初始化调用；失败时零写入；确认前退出后重新进入向导；向导不出现预算或权限输入项 | `pnpm test -- tests/tui/wizard.test.tsx` |
| 常驻 transcript 与 composer 主视图（4 Scenario） | IP-05 | `tests/tui/workspace.test.tsx` | ink-testing-library 渲染；窄宽终端模拟；overlay 栈 | 窄屏下主视图仍可用；工具记录默认折叠；普通字符不触发全局命令；`Esc` 只关最上层 | `pnpm test -- tests/tui/workspace.test.tsx` |
| 信息分层（2 Scenario） | IP-07 | `tests/tui/event-drawer.test.tsx` | 语义事件与 keepalive/重复事件混合输入 | 保活不进入 transcript 与 Event Drawer；验证接受事件进入 Event Drawer | `pnpm test -- tests/tui/event-drawer.test.tsx` |
| 三态 Sidebar 与渲染保真（3 Scenario） | IP-06、IP-10 | `tests/tui/width.test.ts`、`tests/tui/pty.test.ts` | CJK 与中英文混排样本；保活的 PTY 进程 + SIGWINCH；过窄宽度 + `Ctrl+G` | 按显示宽度换行与裁切且边框对齐；折叠后不被强制展开；过窄时提示扩宽且主视图可见 | `pnpm test -- tests/tui/width.test.ts tests/tui/pty.test.ts` |
| Session Picker 与焦点约束（3 Scenario） | IP-07 | `tests/tui/session-picker.test.tsx` | 两个 Session、其一带 Pending Interaction；输入过程中注入事件 | 默认选中待答 Session；事件不改选中与焦点；切换往返保留草稿 | `pnpm test -- tests/tui/session-picker.test.tsx` |
| Pending Interaction 回答绑定（3 Scenario） | IP-08 | `tests/tui/interaction-card.test.tsx` | fake 回答端口返回 accepted 与 stale | 普通消息不解决交互；stale 被拒绝；匹配 revision 时提交一次回答 | `pnpm test -- tests/tui/interaction-card.test.tsx` |
| 只读 Graph Inspector（2 Scenario） | IP-08 | `tests/tui/graph-inspector.test.tsx` | fake candidate 图快照 | 展开与导航不产生任何写调用；选择移动到上游节点 | `pnpm test -- tests/tui/graph-inspector.test.tsx` |
| 会话维护、模型配置与 Route Planning Handoff（5 Scenario） | IP-11 | `tests/tui/session-lifecycle.test.tsx` | fake 端口返回 compact 成功与降级、`context_exhausted`、运行中切换被拒、Handoff Review 与 cutover、Capsule 失败 | compact 结果与降级告警可见；耗尽后不再发起模型调用；运行中切换不被接受；cutover 后选中 Target 且显示 `awaiting_user_prompt`；失败显示 Scope blocker | `pnpm test -- tests/tui/session-lifecycle.test.tsx` |
| PTY 规划 Handoff | IP-11 | `tests/tui/pty-handoff.test.ts` | 显式选择的隔离项目与专用身份；Coordinator 显式使用 `minimax-cn/MiniMax-M3` | 在真实 PTY 中完成一次规划 Handoff，cutover 后 Target 处于 `awaiting_user_prompt` | `pnpm test -- tests/tui/pty-handoff.test.ts` |
| 渲染与重挂载零业务副作用（2 Scenario） | IP-09 | `tests/tui/no-side-effect.test.tsx` | 计数型 fake 端口；重挂载与 resize 触发；高频事件批次 | 重挂载后模型恢复/派发/写入计数为 0；折叠态不计算详情；批次刷新有界 | `pnpm test -- tests/tui/no-side-effect.test.tsx` |
| 快照 DTO 与 CLI 复用（IP-03 前置） | IP-03、IP-09 | `tests/tui/status-json.test.ts` | 与 TUI 共用同一投影函数的 `status --json` | stdout 可解析且字段语义与既有契约一致 | `pnpm test -- tests/tui/status-json.test.ts` |
| 全量门禁 | 全部 | 全部 | 无 | 类型、lint、测试、构建全部通过 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-planning-tui --strict` |

## 7. 文件清单与升级条件

**新增**：`src/interfaces/tui/screens/{home,wizard,workspace}.tsx`、`src/interfaces/tui/components/{top-bar,transcript,composer,status-line,sidebar,session-picker,event-drawer,graph-inspector,interaction-card,command-palette,model-picker,handoff-review}.tsx`、`src/interfaces/tui/input/keymap.ts`、`src/interfaces/tui/render/width.ts`、`src/application/tui/view-model.ts`、`src/interfaces/cli/argv.ts`、`tests/tui/*`。

**修改**：`package.json`、`pnpm-lock.yaml`、`src/bootstrap/` 进程入口、`ControllerService` 与 `initializeCoordinationScope` 的装配、`src/interfaces/cli/` 的 `status --json` 装配、`docs/` 用户说明；不修改两个既有应用契约的领域语义。

**保护（不得改动）**：`openspec/specs/`、其它 change 目录、`openspec/schema`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`src/domain/` 的领域规则与状态转换、`references/orca`。

**升级条件**（遇到即停下询问，不自作决定）：

1. 前驱 `m1-evolve-execution-graph` 未归档、其主规格缺失，或冻结接缝与计划描述不一致；
2. 需要新增计划外文件、公开 DTO 字段、依赖或 migration；
3. `pnpm build` 等命名命令不存在或持续失败；
4. 需要 TUI 直接访问 Orca、数据库或 checkpoint 才能满足某个 Scenario；
5. 某个 Scenario 在当前 Ubuntu 环境无法通过 PTY 验证。

## 8. 验收 Agent 授权与限定审计

验收范围为本 change 的全部新增与修改文件，加上 `tests/tui/` 与 `docs/` 用户说明；可在隔离的一次性项目中运行 TUI 与 PTY 用例。需要限定审计的语义边界：

- `zero-side-effect`：`tests/tui/no-side-effect.test.tsx` 与 `tests/tui/pty.test.ts` 中「重挂载与 resize 不触发业务动作」的断言；
- `tty-gate`：非 TTY 拒绝必须发生在 Ink 挂载之前，且不得以退出码 0 佐证成功；
- `scope-identity`：Home 查找键为 Git common dir 加完整 branch ref，向导不得隐式创建 Scope；
- `interaction-binding`：回答提交必须携带 interaction ID 与 expected revision，stale 必须拒绝。
- `session-lifecycle-gate`：Model Picker 只在 Session suspended 且无在途模型操作时可提交，`compaction_degraded` 不自动触发 handoff，Handoff 灾难路径不得激活 Target。

超出上述范围的产品行为改动、依赖或公开契约变化必须升级，不得在验收阶段静默扩大。
