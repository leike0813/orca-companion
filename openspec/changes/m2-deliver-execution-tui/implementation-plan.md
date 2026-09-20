# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`。
- **规划 commit**：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（十个规划包共同起草时的 `git rev-parse HEAD`）。apply 首步必须记录实际 HEAD，并确认直接前驱 `m2-deliver-planning-tui` 已归档且冻结接缝与实现符号一致；更早前驱由串行归档链保证。
- **直接前驱**：`m2-deliver-planning-tui`。
- **架构合同**：`docs/architecture.md` 的 MOD-05、MOD-06、MOD-07，以及 `docs/interface-contracts.md` 的 IC-08–IC-12。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Extend | IC-12：同一 `TuiViewModel`、projection 与 React component tree | 只增加执行态分区，不新建 snapshot、event channel 或页面状态机 |
| Consume | IC-11：执行 snapshot/event/commands | 查询与控制意图只通过 façade；组件不推进任何领域状态 |
| Consume | IC-08、IC-09、IC-10（仅经 IC-11） | 不复制结果正文、Recovery/Capsule、GraphHistory 或预算事实 |

若执行事实开始绕过 ControllerService，或组件需要拥有状态转换，停止实施并先修正应用合同。
- **冻结接缝**（实施前逐项与实际文件/符号对齐，任一漂移即回到规划）：

  1. `src/interfaces/tui/` 的常驻主视图骨架：顶栏、transcript、composer、状态行与 Sidebar 三态组件，以及它们的属性契约；
  2. `src/interfaces/tui/input/keymap.ts` 的固定全局键位映射与 overlay 栈语义；
  3. `src/application/tui/view-model.ts` 的 `TuiViewModel`/`projectTuiViewModel`，以及「渲染不查询、不写入」的零副作用约定；ControllerSnapshot 与 SemanticEvent 仍由 `ControllerService` 定义；
  4. `ControllerService`（已由图演进 change 扩展）的执行图快照/语义事件、CLI/TUI 公共投影入口与 `status --json` 装配；
  5. Session Picker、Event Drawer 与 Graph Inspector 的既有分区语义与信息分层规则。
  6. 前驱已交付的 Handoff 交互、Command Palette 入口、Model Picker，以及 M1 `ExecutionHandoffState`/`awaiting_user_prompt` 投影。

  以及前驱已归档的 Execution Coordination 语义：并发上限固定为 1、每个 Work Package 使用隔离 worktree、Task Materialization 即时化。本 change 只投影这些事实。

  前驱的 spec 路径为 `openspec/specs/tui/{scope-initialization,planning-workspace,session-interactions,graph-inspection}/spec.md`；实施前必须确认它们已随归档同步存在。
- **需求事实源**：本 change 的 proposal、四个 capability 的 delta spec 与 design D1–D10；不修改 `openspec/specs/` 下任何主规格。
- **依赖与命令存在性**：不新增依赖；复用前驱引入的 `ink`、`react`、`@types/react` 与 `ink-testing-library`。命令沿用 `typecheck`、`lint`、`test`、`build`；缺任一项即升级询问。
- **环境边界**：当前 agent shell 非 TTY，TUI 与 PTY 断言必须经 `tmux` 或 `script` 运行。真实端到端验收的 Coordinator、Planner、Implementation、Validator、Recovery Utility、Graph Patch Planner 与 Finalizer 必须显式使用 `minimax-cn/MiniMax-M3`，且只在显式选择的隔离项目与专用身份中运行。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | 前驱 `view-model.ts` 的 `TuiViewModel`/`projectTuiViewModel` | 在同一展示模型上扩展执行分区字段 | 不新建第二份 ControllerSnapshot 或第二套事实映射 |
| IP-01 | `src/application/controller-service.ts`（含图演进投影） | 执行投影与控制意图经同一 façade | 不在 TUI 内重建 Work Package、预算、queue 或 liveness 状态 |
| IP-02 | 前驱 `sidebar.tsx` 三态与 `render/width.ts` | 在同一组件内替换为执行分区与稳定拓扑布局 | 不复制宽度计算或三态密度规则 |
| IP-03 | 前驱 `event-drawer.tsx` 的语义事件分类 | 扩展分类覆盖 Recovery、integration 与 Finalizer 事件 | 不新建第二套事件通道或重复过滤规则 |
| IP-03 | Worker Session Recovery、本地 `AcceptedWorkerResultRef`、Orca 权威结果读取与 Execution Authorization（M1） | 只经 ControllerService 投影 coverage、结果引用、预算与 superseded 关系 | 不把 Accepted Worker Result 正文复制进本地快照，不复制 Recovery 状态机、Capsule schema 或预算计数 |
| IP-04 | 既有 Scope 级 Pause/Resume/Cancel 与 Finalizer 门禁语义（M1） | 意图提交与 blocker 判定沿用既有用例 | 不在界面推断终态或把 unknown 呈现为已停止 |
| IP-11 | 前驱 `handoff-review.tsx` 与 Command Palette、M1 `ExecutionHandoffState`/Cutover CAS | 复用同一交互经 ControllerService 提交 Execution Handoff 意图，只读投影结果 | 不复用 `PlanningHandoffProposal` 表达执行交接，不新建通用交接记录、第二套流程或页面 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | 授权后工作区连续性（2 Scenario）；执行图与 Frontier 投影（4 Scenario） | 修改 `src/application/tui/view-model.ts`、`src/interfaces/tui/components/top-bar.tsx`、`src/interfaces/tui/components/sidebar.tsx`；新增 `src/interfaces/tui/render/graph-layout.ts` | 快照扩展 Generation/Authorization/control state/active Work Package 计数与详情；节点位置取自稳定拓扑；过滤只隐藏节点；active 计数只取 0 或 1 | 不在授权时重置 transcript/composer；不在状态变化时重排节点；不实现并行 active |
| IP-02 | 1.2 | Work Package 生命周期与串行 integration queue 投影（4 Scenario） | 修改 `src/interfaces/tui/components/sidebar.tsx`、`src/application/tui/view-model.ts` | 生命周期与 liveness 分列投影；Frontier 串行推进且 integration queue 串行；canonical 前进、轻微 reconciliation 与严重冲突为不同状态 | 不合并 liveness 与生命周期为单一字段；不在折叠态计算详情；不投影第二个 active Work Package |
| IP-03 | 2.1 | Recovery 与 Segment 可观察（3 Scenario） | 修改 `src/interfaces/tui/components/event-drawer.tsx`、`src/interfaces/tui/components/sidebar.tsx` | 展示 Segment、剩余 Recovery 预算、`complete`/`partial` coverage、superseded、AcceptedWorkerResultRef 与 Recovery blocker | 不复制 Accepted Worker Result 正文；不把 Recovery 呈现为原 provider session 的连续恢复 |
| IP-04 | 2.2 | unknown 与 unverifiable 的如实呈现（2 Scenario） | 修改 `src/interfaces/tui/components/sidebar.tsx`、`src/interfaces/tui/components/status-line.tsx` | unknown 呈现为待对账，unverifiable 独立于 exited；重绘只读已持久化状态 | 不把 unknown 呈现为失败或已停止；不在展示路径触发重试 |
| IP-05 | 3.1 | Scope 级控制粒度与 Pause 与 Resume（4 Scenario）；Scope 级 Cancel（3 Scenario） | 新增 `src/interfaces/tui/components/control-bar.tsx`；修改 `src/interfaces/tui/input/keymap.ts`、`src/interfaces/tui/components/status-line.tsx` | Pause/Resume/Cancel 意图提交与危险态确认；`cancelling` 只反映 Controller 状态；不提供单个 Work Package 的控制 | 不在 TUI 内推断终态或乐观推进控制状态 |
| IP-06 | 3.2 | 前台 Exit 与 Ctrl+C（3 Scenario） | 修改 `src/bootstrap/` 生命周期入口、`src/interfaces/tui/input/keymap.ts` | Exit 与 `Ctrl+C` 只结束前台 Controller；危险态确认；退出后不再调度/验证/集成 | 不让 Exit 隐式暂停或取消 Scope |
| IP-07 | 4.1 | Finalizer 运行条件投影（3 Scenario）；Delivery Verdict 终态投影（2 Scenario） | 新增 `src/interfaces/tui/components/finalizer-panel.tsx`；修改 `src/interfaces/tui/components/sidebar.tsx` | 展示只读 Profile、集成冻结、前后 HEAD/index/dirty paths 与 Evidence；门禁不满足或工作区变化时只显示 blocker；区分三类事实 | 不在门禁不满足时显示 deliverable；不复制 Git 事实为本地状态 |
| IP-11 | 4.3 | Execution Handoff 复用既有交互（3 Scenario） | 修改 `src/interfaces/tui/components/handoff-review.tsx`、`src/interfaces/tui/components/status-line.tsx`、`src/interfaces/tui/components/command-palette.tsx`、`src/application/tui/view-model.ts` | 经 ControllerService 提交 `ExecutionHandoffState` 的 prepare/review/cutover；cutover 后选中 Target 并显示 `awaiting_user_prompt`；运行身份与 Recovery 状态展示不变 | 不复用 `PlanningHandoffProposal`；不改动 Run/Task/Dispatch/Attempt/worktree/Authorization/预算身份；fail closed 时显示 blocker |
| IP-08 | 4.2 | 重启先对账；有界投影与刷新 | 修改 `src/interfaces/cli/` 的 `status --json` 装配、`src/application/tui/view-model.ts` | `status --json` 增加执行快照字段并保持 stdout 可解析；隐藏分区不计算，事件有界批量刷新 | 不改变既有字段语义与退出码 |
| IP-09 | 5.1 | 全部可用组件测试覆盖的 Scenario | 新增 `tests/tui/execution-*.test.tsx` 与 `tests/tui/control.test.tsx`，共用 `tests/tui/harness.ts` | 覆盖 Frontier 串行推进、单 active Work Package、串行 integration、控制竞态、旧 generation 事件、Finalizer 门禁、三态与有界投影 | 不精确断言整屏 snapshot、大段文案或内部调用顺序；不构造并行 active 场景 |
| IP-10 | 5.2 | 全部真实 PTY 端到端验收 | 新增 `tests/tui/pty-execution.test.ts`；修改 `docs/` 用户说明与 compatibility 记录 | 在隔离项目跑初始化→规划→授权→串行 Frontier 推进→Validator repair→canonical 前进 reconciliation→Finalizer→退出重启对账→deliverable | 不声明 daemon、attach、headless、无人值守或 Windows 支持 |

删除文件：无。

## 4. 调用与副作用顺序

1. **启动与对账**：前台入口复用前驱的 TTY 门禁与挂载流程。挂载后若快照显示存在活跃 Worker 或未决操作，界面先进入 reconciling；对账由 Controller 执行，TUI 只展示，且在对账完成前不得出现新的派发或集成（D4）。
2. **授权切换**：Scope 进入 Execution Coordination 时，前端只更新顶栏与 Sidebar 分区，transcript 与 composer 内容、焦点与草稿保持不变（D1）。
3. **投影刷新**：语义事件按批次进入投影函数；状态变化只更新节点标识，不改变稳定拓扑位置；隐藏分区不参与计算（D2、D8）。
4. **Pause**：提交意图 → 应用层持久化 → 界面在后续快照中反映停止新派发与集成的结果；已在运行的 Worker 与 Git 动作到可核验边界，界面只展示其状态（D3、D4）。
5. **Resume**：提交意图 → Controller 先对账 → 成功后才恢复调度；对账未完成时界面保持 reconciling（D4）。
6. **Cancel**：危险态确认 → 提交意图 → 界面保持 `cancelling` 直到快照显示 `stopped` 或 `unverifiable`；不得乐观显示终态（D3、D6）。
7. **Exit**：危险态确认 → 结束 TUI 与前台 Controller → 停止后续调度、验证与集成；Scope 未进入暂停或取消（D3）。
8. **Finalizer**：显示只读 Profile、集成冻结与运行前后 HEAD/index/dirty paths；门禁不满足、工作区变化或验证失败时只显示 blocker；只有被接受的只读结论显示 deliverable（D7）。
9. **Execution Handoff**：用户经 ControllerService 创建或推进 `ExecutionHandoffState`；Review 展示 Target 与待转移责任（Execution Coordination Lease、相关 Pending Interaction、当前 Graph Generation 的后续 Worker 生命周期事件责任）。确认后提交 cutover 意图，界面自动选中 Target、Source transcript 转为只读，Target 显示 `awaiting_user_prompt`；在途 Worker、Run、Task、Dispatch、Attempt、worktree 与 Authorization 身份不变。Coordinator Context Capsule 生成失败或 Source checkpoint 不可恢复时显示 Scope blocker 且不激活 Target（D10）。

失败与回滚：意图提交失败保留原控制状态并提示；快照 stale 时拒绝推进式展示；任何渲染或 resize 路径不得触发写入或重试。

## 5. Schema、状态与持久化落实

- **SSOT**：执行图拓扑与 GraphVersion 的权威经 `ExecutionGraphHistory` 投影；Authorization 在版本化项目配置/授权记录；Worker、Task、Dispatch、Attempt、Delivery、receipt 与 Accepted Worker Result 正文归 Orca。本地只保留 AcceptedWorkerResultRef、Recovery、Pending Interaction、控制与 `ExecutionHandoffState`。HEAD、index 与 dirty paths 归 Git。TUI 全部只读。
- **checkpoint**：transcript 内容来自 Coordinator Session checkpoint；本 change 不写。
- **本 change 新增的本地状态只有进程内展示态**（选中 Work Package、过滤条件、Sidebar 密度、滚动位置），退出即丢弃；不新增表、文件或 migration。
- **控制状态转换**：`cancelling` 等中间态由 Controller 记录，界面不得自行推进；未知结果以 `unknown` 呈现并等待对账。
- **权限**：不新增任何 TUI 侧写权限；Pause/Resume/Cancel 与 Exit 均为受控意图提交。
- **错误语义**：stale 快照拒绝推进式展示；unknown 与 unverifiable 如实呈现；门禁不满足一律 blocker。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 授权后工作区连续性（2 Scenario） | IP-01 | `tests/tui/execution-workspace.test.tsx` | fake 快照：规划态到执行态切换；含活跃 Worker 的重启快照 | transcript 与 composer 内容焦点不变；重启先显示 reconciling 且无新动作 | `pnpm test -- tests/tui/execution-workspace.test.tsx` |
| 执行图与 Frontier 投影（4 Scenario） | IP-01 | `tests/tui/execution-graph.test.tsx` | 稳定拓扑 fixture；implementing→validating 事件；折叠与过滤操作；两个候选 Work Package | 节点位置不变；折叠态不渲染详情；过滤只隐藏节点；最多一个 active | `pnpm test -- tests/tui/execution-graph.test.tsx` |
| Work Package 生命周期与串行 integration queue（4 Scenario） | IP-02 | `tests/tui/execution-frontier.test.tsx` | 一个 active 加一个等待中的 Work Package；liveness 为 unverifiable 的包；超范围冲突事件 | 只出现单 active 且按串行推进；进入 waiting integration 后串行集成；liveness 与生命周期分列；严重冲突与轻微 reconciliation 状态不同 | `pnpm test -- tests/tui/execution-frontier.test.tsx` |
| Recovery 与 Segment 可观察（3 Scenario） | IP-03 | `tests/tui/recovery.test.tsx` | partial Capsule 的 Recovery 记录；superseded 原 Segment 的迟到结果；Recovery 失败记录 | coverage 为 partial 且显示缺口与剩余预算；迟到结果只入审计历史；失败显示 blocker | `pnpm test -- tests/tui/recovery.test.tsx` |
| Execution Handoff 复用既有交互（3 Scenario） | IP-11 | `tests/tui/execution-handoff.test.tsx` | fake 端口返回 cutover 成功、`awaiting_user_prompt` 与 Capsule 失败 | 运行身份不变；cutover 后选中 Target 且 Worker 事件不唤醒模型；失败保持 Source owner 并显示 blocker | `pnpm test -- tests/tui/execution-handoff.test.tsx` |
| unknown 与 unverifiable（2 Scenario） | IP-04 | `tests/tui/unknown-state.test.tsx` | 返回 unknown 的停止请求；重绘触发 | unknown 呈现为待对账；重绘不产生重试或写入调用 | `pnpm test -- tests/tui/unknown-state.test.tsx` |
| Scope 级控制粒度与 Pause 与 Resume（4 Scenario） | IP-05 | `tests/tui/control.test.tsx` | fake 控制端口；active Work Package；Work Package 选择态 | Pause 持久化意图且无新派发、不要求确认；Resume 先对账；不存在单包控制入口 | `pnpm test -- tests/tui/control.test.tsx` |
| Scope 级 Cancel（3 Scenario） | IP-05 | `tests/tui/control.test.tsx` | 未确认停止结果；危险态；不可核验结果 | 保持 `cancelling`；危险态先确认；不可核验如实呈现 | `pnpm test -- tests/tui/control.test.tsx` |
| 前台 Exit 与 Ctrl+C（3 Scenario） | IP-06 | `tests/tui/exit.test.tsx`、`tests/tui/pty-execution.test.ts` | 活跃 Worker 与未决操作；PTY 中的 `Ctrl+C` | Exit 不隐式暂停或取消；危险态要求确认；退出后无新调度/验证/集成 | `pnpm test -- tests/tui/exit.test.tsx tests/tui/pty-execution.test.ts` |
| Finalizer 运行条件投影（3 Scenario） | IP-07 | `tests/tui/finalizer.test.tsx` | 只读无法强制；运行期间工作区变化；成功只读完成 | 前两者只显示 blocker；成功后显示前后 HEAD/index/dirty 与 Evidence | `pnpm test -- tests/tui/finalizer.test.tsx` |
| Delivery Verdict 终态投影（2 Scenario） | IP-07 | `tests/tui/finalizer.test.tsx` | 全部包通过但无 Finalizer 结论；blocked 结论 | 前者不显示 deliverable；后者显示 blocker 终态 | `pnpm test -- tests/tui/finalizer.test.tsx` |
| 重启先对账与有界投影 | IP-08 | `tests/tui/status-json.test.ts`、`tests/tui/execution-graph.test.tsx` | `status --json` 执行快照；隐藏分区与高频事件批次 | stdout 可解析且字段语义不变；隐藏分区不计算；批次刷新有界 | `pnpm test -- tests/tui/status-json.test.ts tests/tui/execution-graph.test.tsx` |
| 真实 PTY 端到端 | IP-10 | `tests/tui/pty-execution.test.ts` | 显式选择的隔离项目与专用身份；Coordinator/Planner/Implementation/Validator/Recovery Utility/Graph Patch Planner/Finalizer 均用 `minimax-cn/MiniMax-M3` | 完成初始化→规划→授权→串行 Frontier 推进→Validator repair→reconciliation→Finalizer→重启对账不重复派发→deliverable | `pnpm test -- tests/tui/pty-execution.test.ts` |
| PTY 执行态 Recovery 或 blocker | IP-10、IP-03 | `tests/tui/pty-execution.test.ts` | 显式选择的隔离项目与专用身份；Worker Profile 显式使用 `minimax-cn/MiniMax-M3` | 至少覆盖一次执行态 Worker Session Recovery，或一次明确的 Recovery blocker，二者都必须在界面如实可见 | `pnpm test -- tests/tui/pty-execution.test.ts` |
| 全量门禁 | 全部 | 全部 | 无 | 类型、lint、测试、构建与 OpenSpec 严格校验全部通过 | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-execution-tui --strict` |

## 7. 文件清单与升级条件

**新增**：`src/interfaces/tui/components/{control-bar,finalizer-panel}.tsx`、`src/interfaces/tui/render/graph-layout.ts`、`tests/tui/{execution-workspace,execution-graph,execution-frontier,recovery,unknown-state,control,exit,finalizer,execution-handoff,status-json,pty-execution}.test.*`。

**修改**：`src/application/tui/view-model.ts`、`src/interfaces/tui/components/{top-bar,sidebar,status-line,event-drawer,command-palette,handoff-review}.tsx`、`src/interfaces/tui/input/keymap.ts`、`src/interfaces/cli/` 的 `status --json` 装配、`src/bootstrap/` 生命周期入口、`docs/` 用户说明与 compatibility 记录。

**保护（不得改动）**：`openspec/specs/`、其它 change 目录、`openspec/schema`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`src/domain/` 的领域规则与状态转换、`references/orca`、坐标与拓扑数据之外的 Execution Graph 历史。

**升级条件**（遇到即停下询问，不自作决定）：

1. 直接前驱未归档、其主规格缺失，或冻结接缝与计划描述不一致；
2. 需要单包控制、并行执行、新页面、新依赖、新表或新 migration 才能满足某个 Scenario；
3. 需要一个界面无法从既有快照获得的执行事实；
4. 需要 TUI 直接访问 Orca、数据库或 checkpoint；
5. 真实端到端验收无法在显式选择的隔离项目中运行，或无法强制 Worker Profile 使用 `minimax-cn/MiniMax-M3`。

## 8. 验收 Agent 授权与限定审计

验收范围为本 change 的全部新增与修改文件，加上 `tests/tui/` 与 `docs/` 用户说明；可在显式选择的隔离项目与专用身份中运行真实 PTY 端到端。需要限定审计的语义边界：

- `scope-level-control`：Pause/Resume/Cancel 只作用于整个 Scope，且不存在单个 Work Package 的控制入口；
- `serial-concurrency-one`：并发上限固定为 1，任一时刻最多一个 active Work Package，验收不得出现并行 active；
- `unknown-fidelity`：unknown 与 unverifiable 不得被呈现为失败或已停止；
- `finalizer-gate`：只读无法强制、工作区变化或验证失败只映射为 blocker，不得显示 deliverable；
- `zero-side-effect`：重绘、resize 与事件刷新不触发业务动作，折叠态不计算隐藏详情；
- `m2-scope-claim`：不得在文档或 compatibility 记录中声明 daemon、attach、headless、无人值守或 Windows 支持。
- `handoff-identity`：Execution Handoff 不改动 Run、Task、Dispatch、Attempt、Worker、worktree、Authorization 与预算身份，Cutover 后 Target 处于 `awaiting_user_prompt`。

超出上述范围的产品行为改动、依赖或公开契约变化必须升级，不得在验收阶段静默扩大。
