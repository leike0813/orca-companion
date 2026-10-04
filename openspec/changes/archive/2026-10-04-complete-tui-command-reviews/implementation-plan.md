# Implementation Plan

## 1. 实施基线与权威来源

baseline: `predecessor-contract`；planning commit: `abf8f0c0617972f8277598dfe04257769ba86179`；直接前驱 `link-tui-pending-interactions`。实施前确认其 archive、主规格和干净工作区；冻结 IC-13 草稿/提交、IC-11 问题范围查询和 IC-12 reader/回答返回接缝。实际核验无漂移。权威为 proposal、三份 delta、D-01–06 与 #45/#46/#52。定稿源码快照和历史证据保持只读；现行原型入口仅作端口签名适配。不修改 submodule、配置或锁文件。

## 2. 复用与接缝

| IP-ID | 文件/符号 | 复用方式 | 不复制 |
|---|---|---|---|
| IP-01 | command-palette/keymap/HELP_LINES | 提取单一 command catalog、搜索、帮助 | Controller 准入 |
| IP-02 | app/state/input protection/reader | typed outcome、页面 frame、原输入 generation | 正文/回答/历史 |
| IP-03 | controller-service/TUI ports/foreground host/交接用例 | 精确提案、Session 目录、语义审阅、只读结果引用 | 业务状态机/Manifest |
| IP-04 | selection-list/authorization/handoff/session/model components | 已确认布局、有界选择/栏目 | fixture 与标签推断 |
| IP-05 | 现有 TUI/bootstrap tests 与 preview | 故障行为、生产画面、文档 | 脆弱 snapshot/索引 |

## 3. 代码变更映射

| IP-ID | Requirement/Scenario | 文件与变化 |
|---|---|---|
| IP-01 | 可搜索同源命令目录/两个场景 | 新 commands module；command-palette、keymap、Workspace/context hints 使用同源定义 |
| IP-02 | 命令结果与页面返回绑定/两个场景；命令连按与待核验恢复 | app/state：捕获目标、frame、generation、typed handler outcome、去重、精确清稿/返回 |
| IP-03 | 精确选择与语义审阅/三个场景；未知响应 | Controller DTO、ports、foreground host、planning/execution handoff 与 planning-tools 的可信 review revision 参数：精确 ID/revision、Session 目录、结果查询；仅消费已有权威记录 |
| IP-04 | 搜索子项与取消、多级返回、审阅期间内容变更、审阅键位不穿透 | selection-list 及现有 picker/review components、Workspace：独立查询、有界栏目、默认返回及明确反馈 |
| IP-05 | 所有场景及原型一致性 | tests/tui、相关 tests/bootstrap/application、scripts/tui-preview 与新 artifacts/command-reviews；docs/interface-contracts、architecture、dev handoff/workbench 与必要 README |

## 4. 调用与副作用顺序

查询只读 → 捕获 Scope/Session/问题/对象/revision 与调用 generation → recheck → 单目标 guard → 原 Controller 用例 → 记录结构化结果 → 读权威现状。opened/accepted 才按 IC-13 generation 清原命令；其他结果保留。审阅批准只回传所见身份/版本；宿主验证 ownership/CAS，确定写入后发布。unknown 只查询原引用，不换 ID。旧 frame/generation 不执行导航或清新输入。

## 5. Schema、状态与持久化落实

新增窄 DTO/结果引用做运行时校验，宿主绑定 Scope。UI frame/query/选择只属展示；草稿唯一 owner IC-13，锚点属于 reader，业务结果属于原 store/receipt/checkpoint。不新建持久命令账本、不新增历史格式迁移。modelCatalog.load 指定 Session；交接 prepare 回传本次 ID，后续动作带所见 revision；审阅语义由应用字段投影。

## 6. 验收证据矩阵

| 场景 | IP-ID | 测试/前置 | 断言 | 命令 |
|---|---|---|---|---|
| 目录、搜索、同源入口 | 01/04/05 | TUI harness、literal CJK/path query | 对象与原因正确、不 mutation | `pnpm exec vitest run tests/tui` |
| 原输入、迟到/切 Session/回答/返回 | 02/05 | 延迟 fake ports、IC-13 | 新稿/身份/锚点保持 | 同上 |
| 多提案、stale 审阅、模型 Session | 03/04/05 | Bootstrap/application fake backend | 精确目标、零越权副作用 | `pnpm exec vitest run tests/bootstrap tests/application tests/handoff` |
| 连按、unknown、按原引用核验 | 02/03/05 | pending/rejected/unknown ports | 单提交、持续待核验 | 上述两组 |
| 三档生产画面、中文/无色/ASCII/resize | 04/05 | tuistory/生产 App/隔离端口 | 定稿一致、焦点与内容保持 | `node artifacts/command-reviews/capture.mjs` |
| 代码与工件 | 全部 | 已安装工具链 | 类型/行为/发布构建 | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate complete-tui-command-reviews --strict`、`git diff --check` |

## 7. 文件清单与升级条件

新增静态目录和必要窄 DTO/行为用例/采集脚本；修改上述接缝与对应测试、文档；删除分散硬编码，不删证据或用户文件。若必须改变 provider/effort/WorkerProfile、派发策略、权限/预算或原型设计，停止该扩展并向用户说明，不能吸收进 6A。没有新增依赖、Git 提交或开发服务器授权。

## 8. 验收 Agent 授权与限定审计

可由 gpt-6-luna 只读核验范围/代码/行为；主代理拥有 UI 实现与原型比对。重点审计 target/version、slash 清稿、未知结果去重、页面 generation、Scope 级确认、render/effect/resize 无副作用，以及 Application→TUI 依赖方向。实现与必要验证完成后才创建 verification；不以 skipped/live 未运行证据称已验证。

## 9. 验收记录（2026-10-04）

实施和验收 HEAD 均为 `abf8f0c0617972f8277598dfe04257769ba86179`；本 change 是其上的未提交工作区实现。
直接前驱 archive 和主规格已经核验。原型入口只补必需端口签名；final 源码归档及历史画面保持只读。

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 最终实现通过；仅 Companion，不构建 submodule |
| `pnpm exec vitest run --maxWorkers=2` | 全量152文件/1527项通过，6文件/12项条件跳过；随后审计修复按受影响文件复验，新增3项回归，合并覆盖1530项通过/12项条件跳过，不重复计数 |
| 审计修复针对性复验 | 9文件100项通过；`tests/tui/command-reviews.test.tsx` 修正 fixture 的 SnapshotLoad 失败判别值后16项再次通过 |
| 真实 PTY/宿主/重绘 | `pnpm exec vitest run tests/tui/pty.test.ts tests/tui/host-wiring.test.ts tests/tui/no-side-effect.test.tsx --maxWorkers=1`：3文件22项通过，其中真实PTY入口/编辑/终端恢复13项 |
| 审阅最终布局 | 授权/执行交接2文件9项通过；50列键位提示完整保留Enter/Esc |
| OpenSpec / diff | `openspec validate complete-tui-command-reviews --strict` 与 `git diff --check` 通过 |
| 生产画面 | `node artifacts/command-reviews/capture.mjs`：三档、两色、两图标及resize共108对，12组操作；[README](../../../artifacts/command-reviews/README.md)记录定稿对照与端口边界 |

限定审计由 `gpt-6-luna` 的原生只读子代理 Jason 执行，主代理负责实现、测试与画面对照。
审计先发现 planning await 后的 revision 检查缺口，再发现 prepare guard 提前释放及刷新失败清 slash 的问题。
均已修复：用例在 await 后重验可信 record revision；guard 覆盖 prepare→read/review→open 与 action→reload，连按不递增原调用 generation；刷新失败保留 accepted/refreshFailed 与原输入，核验只重读。
最终只读复核确认4 Requirement、9 Scenario、IP-01–05覆盖完整，F1/F2闭合且无新增阻塞。

全量首轮加载修正前代码的三个失败由最终全量闭合；真实PTY的旧失败画面中目录查询为空，补入等待目录和搜索实际可见后再Enter，最终13项通过。
审计修复复验曾因测试 fixture 返回不存在的 SnapshotLoad `rejected` 而构建失败、PTY条件跳过；改用合同的 `failed` 后 typecheck/build、16项回归和上述完整PTY均通过，跳过未算通过。
没有新增依赖、迁移、Git提交或真实Orca/provider启动。6B模型/effort/Worker绑定、后继用户配置和图历史未实施；Windows、OS IME与历史p95未新增证据。
