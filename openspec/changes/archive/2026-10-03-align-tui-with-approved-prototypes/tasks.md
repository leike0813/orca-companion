## 1. 基线与六票来源

- [x] 1.1 IP-01–09：按 implementation-plan 第 1 节核验前驱/主规格、HEAD 与已有未提交改动；亲自阅读 design D-01 的六票定稿源码/画面和最终语义，记录差异与 D-10 缺口。检查：`git rev-parse HEAD`、`git status --short`、`openspec list --json`，每个 P-ID 有真实参照。

## 2. 保留阶段成果并整合布局

- [x] 2.1 IP-01,04：continuous 呈现纳入固定工作区预算，真实工具展开与正文不变；运行 workspace/execution-workspace 测试。
- [x] 2.2 IP-02,04：统一候选/回答/框内行列预算和 native cursor，保留完整编辑/粘贴/保护；运行 composer-editor、width、input-paths、input-protection、pty 测试。
- [x] 2.3 IP-03：当前回答保留定稿层级、精确绑定及 Esc 恢复；运行 input-paths、interaction-card、session-lifecycle 测试。以上复用已有实现，重新验证扩展布局。

## 3. 项目面板

- [x] 3.1 IP-04,05：实现 Ctrl+B 固定 tabs、100 列分界、框内列表/详情、resize 与逐层返回；在 workspace/pty 检查 120 列不动对话、80/50 列独占主区且关闭恢复。
- [x] 3.2 IP-05：预算/身份/工作依据、待答摘要和最近事件复用现有可信投影；事件入口指向同一页签，缺失数据明确不可用；运行 event-drawer、session-lifecycle、no-side-effect 测试。

## 4. 命令与四类弹窗

- [x] 4.1 IP-06：共享名称/短说明/目标/可用性，加入 project/events UI 入口；above-input 候选有界、采用与执行分离，错误 slash/不可用/粘贴/IME 不发出；运行 input-paths 与 input-protection 测试。
- [x] 4.2 IP-06：命令、Session、模型选择固定框/分区/反色，缺失角色/effort 明示未接通；取消恢复原上下文；运行 workspace、session-picker、input-paths 测试。
- [x] 4.3 IP-06：授权/交接/Cancel/Exit 依 dialog final 有界分栏/栏目、默认返回、精确确认；运行 authorization-review、execution-handoff、control、exit 测试。

## 5. 顶栏、状态栏与图

- [x] 5.1 IP-07：简短顶栏、单行 Coordinator 三核心+图、独立风险/notice、详情出口；缺失数据/偏好不冒充完成；运行 workspace、execution-workspace、unknown-state、recovery 测试。
- [x] 5.2 IP-08：sidebar/Inspector 共用 adaptive 与节点卡，三档可浏览、稳定选择、多关系显式选择、阶段/liveness/验证分开；运行 graph-inspector、execution-graph、execution-frontier 测试。
- [x] 5.3 IP-08：Nerd/ASCII 即时同步、可信 live 动画、无未知进度猜数，保留只读；运行 graph-inspector 与 no-side-effect 测试并核对三档回退画面。

## 6. 全范围验收与交接

- [x] 6.1 IP-09：同步 AGENTS.md/IC-12/工作台的 Ctrl+B、事件与窄屏图合同；运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm exec vitest run tests/tui --maxWorkers=8`、严格 OpenSpec 与 `git diff --check`，跳过不算通过。
- [x] 6.2 IP-09：主 agent 按 D-06 完成六票生产画面对照，覆盖三档/彩色与无色/Nerd与ASCII/项目各栏目/四类弹窗/slash/图与返回；用现有 tuistory/PTY 另存 full-map 277 对 PNG/文本及逐票结论，六票原型定稿完整保留。旧阶段一对工具图/文本误覆盖、无备份，用户明确接受丢失，来源更正已登记，不作为旧阶段原始证据。
- [x] 6.3 IP-09：交接页分别登记当前实现、运行检查、六票呈现状态、D-10 功能缺口与提交/归档状态；逐项检查证据链接。旧 54 组与旧测试仅作为阶段记录，不记为本次整体通过。

## 7. 验收修复

- [x] 7.1 V-01 / IP-06：共同输入分发阻止审阅期间 Ctrl+P/B/G 穿透，复验三类审阅的返回与精确确认。
- [x] 7.2 V-02 / IP-05：恢复总览用途分组和三层呈现，保持固定框内滚动；对照三档彩色/无色生产画面。
- [x] 7.3 V-03 / IP-07,08,09：按定稿同步执行概要/节点详情/Recovery/Finalizer 的区域归属，补齐相关 delta、主规格及 IC-12；修正预览架构描述。
- [x] 7.4 V-04 / IP-09：真实执行 PTY 经项目/Inspector 入口观察原事实并返回，不再依赖已移除的 Sidebar 分区；保留真实集成断言和显式隔离开关。
- [x] 7.5 IP-09：运行最小回归与常规检查，补充独立画面/操作证据，复核 V-01–04 并更新 verification 与交接状态；条件跳过不计为通过。
- [x] 7.6 F-01 / IP-04,05：输入/渲染共用项目几何与可见滚动预算，避免越过末页后 Up 无反应；保留列表位置提示，交接前后从真实工作/预算入口核对身份。
