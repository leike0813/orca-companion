# 第七批项目资料与状态栏证据

实现 change：[complete-tui-project-statusline](../../openspec/changes/complete-tui-project-statusline/implementation-plan.md)，基线 `82f6a77`。12/12任务、画面采集和最终检查已完成，[独立gpt-6-luna验收PASS](../../openspec/changes/complete-tui-project-statusline/verification.md)；实现尚未提交或归档。

生产画面使用构建后的 `TuiApp`，`capture.mjs` 通过真实 PTY 挂载独立 fixture 端口，偏好使用真实 storage adapter 与临时配置目录；不会读取用户偏好或连接 provider、tracker、Orca。metadata、context 及验收数量明确为示例；可信生产接线另由宿主测试验证。`preview-ports.mjs` 只在显式隔离预览开关启用。

复现：`pnpm build` 后运行 `node artifacts/project-statusline/capture.mjs` 与 `node artifacts/project-statusline/capture-supplement.mjs`；性能运行 `node artifacts/project-statusline/benchmark.mjs`，复用前驱工作负载并将结果独立保存到本目录。历史原型与旧证据目录只读。

参照为[六票来源表](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)：P-48 [custom-direct](../statusline-prototype/custom-direct/README.md)，P-51 [tabs](../project-panel-prototype/README.md)，P-52/P-43 [dialog final](../dialog-prototype/final/README.md)，P-40 continuous、P-47 above-input 保留前驱布局。#41/#42 的真实阅读、编辑与 Shift+Left 回答优先于旧样例演示键位。

| 范围 | 需要核验的行为 |
|---|---|
| P-40/P-47 | continuous 标记/色边、圆角 composer、中文任意位置光标、上方候选与采用/执行分离 |
| P-48 | 三核心单行、类别配色、普通附加项按序省略、设置同宽预览、Enter直接保存/Space恢复默认、失败留页 |
| P-51 | >=100原侧栏固定框、窄屏主区域、详情精确批准记录、有界分页、Esc恢复栏目/选择/输入 |
| P-52/P-43 | 定稿选择框/返回、Nerd/ASCII即时同步、图检查三档可读、全图共享验收摘要 |
| 恢复与并发 | 实际文件保存后重启、单区patch、env临时覆盖、CAS失败显式再保存、迟到结果不抢焦点 |

平台限 Ubuntu，真实模型/provider token测量、Windows及新增OS输入法预编辑的人工检查不在此画面证据内。历史图版本与依据全文由第八批接续。

## 本轮检查记录

基础采集见 [release/samples.json](release/samples.json)：116 对 PNG/文本，包含三档×彩色/NO_COLOR×Nerd/ASCII×规划/执行/阻塞/待答/空闲，以及项目身份/预算、custom 编辑、默认恢复、保存失败、中文光标与连续 resize。

最终重采见 [final/samples.json](final/samples.json)：116 对 PNG/文本，重复上述矩阵以核对当前生产组件。六票表的基础画面以 final 同名文件为最终参照，release 保留原采集记录；supplement 的专项操作证据独立保留。主代理重新查看了 final 的设置、身份、规划与执行工作区，并与定稿画面比较，未重设计布局。

补采见 [supplement/samples.json](supplement/samples.json)：95 对 PNG/文本、[24 项检查](supplement/checks.json)和[53 条操作](supplement/operations.json)。12 组尺寸/颜色/图标组合覆盖 Inspector、命令目录、slash 先采用后执行和返回；另有长批准 Manifest 的 UTF-8 续读与 resize、真实第二偏好宿主的 CAS 冲突与 Enter 重试、三档保存失败、图标未保存提示/重试、无环境覆盖的重启恢复、statusline 单区保存保留临时图标覆盖，以及三档绑定问题的回答面板。

基础采集中的 `answer-panel-answer-*` 不能独立证明回答 composer 绑定：该名称下部分画面仍是普通输入。回答绑定以补采的 `answer-composer-bound-interaction-answer-panel-*`、问题/选项可见检查为准，不将前一组重复计为已验证的回答。

主代理已读取六票定稿源码、通过 GitHub API 读取对应决议，并实际查看代表 PNG。下表记录本批新增与保留区域的对照，不据此将第八批能力标为完成。

| 原型 | 对照生产画面 | 核对结果与边界 |
|---|---|---|
| P-40 continuous | [80列规划](final/workspace-planning-80x24-color-nerd.png) | 用户青色色边/标记、助手弱标记、留白、紧凑工具和底部输入保持；没有加入原型模拟 thought |
| P-47 above-input | [候选与原输入](final/slash-above-draft-return-planning-120x40-color-nerd.png)、[50列无色候选](supplement/slash-candidates-before-adopt-50x40-no-color-ascii.png) | 独立上方候选、反色选项、圆角 composer；采用/执行与返回另由补采和行为测试验证 |
| P-48 custom-direct | [80列设置](final/statusline-settings-planning-80x24-color-nerd.png)、[失败草稿](final/statusline-failed-save-draft-retained-planning-120x40-color-nerd.png) | 三核心单行、青/紫/绿/亮蓝字段配色、同源主区域宽度预览、Enter 保存/Esc 逐层返回；列表滚动以终端高度预算为准 |
| P-51 tabs | [同框身份](final/project-identity-planning-120x40-color-nerd.png)、[50列 resize](final/project-budget-resize-planning-50x40-color-nerd.png) | 宽屏使用当前 sidebar 区域，窄屏主区域；固定框内换页/滚动，关闭恢复输入。正式密度由前驱响应式规则决定，未复制原型 fixture 宽度 |
| P-52 dialog final | [custom 直接保存返回](final/statusline-saved-returned-draft-planning-120x40-color-nerd.png)、[命令目录](supplement/command-directory-open-80x24-color-nerd.png) | 设置复用已定选择框、身份分隔和反色选项，保存后关闭命令层，原中文草稿保留；图标重启/失败见补采 |
| P-43 adaptive | [执行 sidebar](final/workspace-execution-120x40-color-nerd.png)、[Inspector](supplement/graph-inspector-open-80x24-color-nerd.png) | 拓扑与分区节点卡保持，验收来自一份全图摘要；示例7/20故意不同于节点生命周期计数，未复制原型9/20；历史图和依据全文仍属第八批 |

[measurements.json](measurements.json) 使用真实文件 SQLite、生产 TranscriptReader 和生产 App，每种输入/缓存导航各100次采样：

| 工作负载 | 输入 p95/ms | 已缓存导航 p95/ms |
|---|---:|---:|
| 1千条 | 62.44 | 8.82 |
| 1万条 | 66.67 | 7.78 |
| 10万条 | 74.53 | 9.41 |
| 1MiB 助手正文 / 工具 | 77.41 / 79.95 | 0.17 / 0.21 |
| 5MiB 助手正文 / 工具 | 72.66 / 82.91 | 0.19 / 0.20 |

以上均满足输入/缓存导航 p95≤100ms；冷读、resize、commit、finish、缓存占用与 RSS 单独记录。没有把 fixture SDK/provider 调用当成真实 tokenizer 验证，也没有用这项对话基准证明项目详情全链路成本。

首轮 `pnpm test --maxWorkers 4`：159 文件通过、2 文件失败、6 文件条件跳过；1683 项通过、2 项5000ms超时、12 项条件跳过，exit 1。失败文件 `startup-reconciliation.test.ts` 与 `recovery/acceptance/roles.test.ts` 随后在 `--maxWorkers 1` 下24/24通过；原始全量失败记录保留，不表述为全量一次通过。TUI专项33文件287项通过、2项条件跳过；协调存储55/55通过。最终修复后的检查另行追加。

最终全量 `pnpm test --maxWorkers 4` 的[原始记录](checks/final-tests.log)为159文件通过、2文件失败、6文件条件跳过；1690项通过、2项失败、12项条件跳过，exit 1。两项失败已修复：新增Session测试使用已持有Runtime Lease的writer注册第二会话；详情JSON字段的键名解码、UTF-8续读和类型边界按生产查询修正。[详情及PTY复验](checks/details-pty-verified.log)为5文件110项通过，[其余受影响复验](checks/affected-final.log)为7文件92项通过。合并全量与失败文件修复后的最终结果按用例去重为1692项通过、12项条件跳过；复验不重复累计。

独立gpt-6-luna只读审计发现工作详情遗漏原有Recovery/Finalizer观察。宿主补回当前Session/revision的已有投影引用，并在失效时明确要求刷新，字段仍经同一有界分页；批准Manifest和工作图原文继续从存储按范围读取。[宿主回归检查](checks/observation-fix.log)10/10通过，包括Finalizer门禁/只读事实读回。普通PTY与最终静态检查在修复后再次运行，后续结果按最终记录补充。

最终补回修复后，`pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts tests/tui/host-wiring.test.ts tests/tui/pty.test.ts --maxWorkers 2` 为[3文件42项通过](checks/last-runtime-pty.log)，包括普通真实PTY13项。`pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate complete-tui-project-statusline --strict`、`git diff --check` 全部exit 0。工作区保留未提交实现，没有提交、切分支、归档、安装依赖或修改上游。

一次修复中间态的PTY检查因构建失败而跳过全部5条收集占位，不算通过；收拢后普通PTY包含13条实际用例，见上面的110项复验。真实Orca/provider集成需显式隔离开关，本轮12项条件跳过保留其限制。
