# Verification

## 验收对象与结论

- Change：`simplify-ledger-lab-lifecycle`，2026-10-09，Ubuntu 本机。
- Node.js `v24.12.0`、pnpm `11.10.0`、Vitest `5.0.1`。
- 实施基线与当前 HEAD：`a29704bc7226c215f2bb14d1503211af82867c5f`。本次实现留在未提交工作区；没有提交、同步主规格或归档。
- 按用户「实施，完成后直接写verification.md，不需要独立验证」的要求，由实施者直接记录工程检查与限定自查，未派独立验证 Agent。

**工程检查与限定的 T4 框架生命周期验收已完成，任务 14/14。** 本轮相关测试按文件去重后为 20 个文件、276 项通过。真实 pack/install 与生产入口 PTY 已通过，普通启动配置和 debug 对话均可完成。初次工程检查的 GitHub/Orca 使用合成公开传输；后续补充了旧未登记轮次的回收记录，以及 T4 main 创建、登记、首次配置、Scope 初始化、退出后采集、注销与回收的真实平台证据，见下文。2026-10-10 按本轮讨论明确的验收范围修正 task 5.2 和 T4：以 main 轮次验证共用框架生命周期，cancel 档案隔离由已有 setup acceptance 覆盖，不再要求重复完整真实轮次。cancel 档案、现场 debug/doctor 未单独实跑，不能记为真实平台通过；发现的 TUI 缺陷尚未修复，原 active lab 的完整业务验收亦保持未完成。

## 已实现的用户流程

1. `pnpm lab:new` 创建外置私有仓库、main 主 checkout、打包安装和首次推送，然后经公开 Orca 命令登记、设置 `origin/main`、核验主工作区、创建并聚焦原生终端。终端初始命令只补本轮 bin PATH 与原 Orca executable，可直接运行 `ocp` 或 `ocp --debug`。准备不启动 ocp、不配置模型或创建地图，不产生模型调用。
2. 普通 `ocp` 每次启动自动逐项检查 repository、Orca 和身份，以当前 spinner、已完成/失败项反馈；失败等待显式重试。已有精确 Scope 沿原身份恢复；新项目进入环境、Coordinator、Route Map、最终确认四步。确认后保存 schema 5、核验模型和 tracker，再创建 Scope/cycle/session。Worker Profiles 仍由执行授权核验。
3. Coordinator 模型配置统一使用 `ProviderLibraryEditor`、现有 library/catalog 和唯一 CredentialStore。普通初始化、工作区模型设置及 debug 空库共用编辑器；保存失败保留输入，迟到连接保存刷新 CAS 基准并保留后来编辑。Worker 设置入口仍使用原生 harness/model/effort 菜单。
4. Scope 前地图端口仅提供有界 list/select/create。创建只含领域空章节和唯一 operation marker；Git common dir 内按完整 branch ref 保存操作记录。unknown 重开只查原 issue 或匹配原 marker，不重发创建；旧 revision 写者被 CAS 拒绝。
5. debug 可从空用户库配置，明确选择新建或继续才核验并打开会话；不要求 Orca、项目配置、地图、Scope 或 Worker。会话和输入留在用户状态目录。
6. `lab open` 核验原 Git/安装/Orca 身份，聚焦记录的原终端；只有精确终端无 PTY 且有明确退出原因时才替换。原创建或登记不确定时停止重发。未登记的旧 schema 2 可显式补登记。
7. `lab list` 可在仓库删除后读取记录；`cleanup` 默认预览，`--yes` 才删除已核验的本地/远程仓库。仍登记或运行时拒绝删除，保留仓库外的 run.json、安装包、operator、captures、checks 和报告。

主要实现位于 `artifacts/ledger-lab/{setup,run-record,cleanup,lab}.mjs`、`src/interfaces/tui/{app,debug-app}.tsx`、新启动引导/共享编辑器、Route Map 应用及 storage/tracker adapters 和两个 bootstrap 宿主。根 README/AGENTS、架构/接口合同、lab 指南、原型交接与 change 工件已同步。删除 lab 专属模型向导和设置 bootstrap；根依赖与 lockfile 未变。

## Requirement / Scenario / IP 证据

以下是本 change 13 项 Requirement 的初次工程检查证据分组；后续真实平台补充见 T4 章节，合成传输与真实平台的边界不互相替代。

| Requirement 与场景组 | IP-ID | 证据 | 边界 |
| --- | --- | --- | --- |
| Isolated canonical rehearsal rounds；Repository-local companion installation：无模型准备、Orca 不可达、独立轮次、内部路径拒绝、安装失败 | IP-02/03/06/07 | setup acceptance；installed acceptance 的真实 pack/install、发布文件 allowlist、安装 bin/runtime JSON/无开发绝对路径 | 公共 Orca/GH 命令使用合成回执；未通过撤销用户开发目录权限来测试不可访问 |
| Configuration through the normal TUI：首次配置、自动一次核验、失败重试、最终确认、能力失败 | IP-06/09 | startup-onboarding、foreground runtime、model-settings；installed 从空 XDG 经真实按键保存配置并初始化 | 模型能力由本机协议服务核验；没有付费 provider 实测 |
| Pre-scope Route Map initialization：空章节、精确选择、响应丢失、branch 隔离、并发/漂移 | IP-08 | route-map-initialization 的真实临时记录、marker 对账、unknown 零重发、错仓库拒绝及 stale revision CAS；installed 经 gh fixture 选择 issue | 真实 GitHub 创建未执行；临时文件 store 实际执行 |
| Debug configuration from an empty user library：首次配置、继续原快照 | IP-09 | debug-app/debug-cli/debug-harness-e2e；installed 空库配置和普通非 Git 调试目录 | 实际模型协议流量、真实 checkpoint；无真实 Orca |
| Coordinator secrets stay in the credential store：TUI 保存 Key | IP-06/09 | installed 核验 CredentialStore 合成值、0600 用户库、项目和模型库只保存引用；既有隐藏输入用例 | 不读取、复制或使用用户真实 Key |
| Durable creation records；Failed preparation retains its original resources：早期中断、取消、unknown、删除后列表 | IP-02/03/07 | setup 的动作前阶段/目标写入、登记绑定、原 handle、失败现场与 missing repo 查询 | 临时本地资源及合成远程；没有清理用户既有轮次 |
| Explicit repository reclamation；Partial and uncertain reclamation remains observable：预览、替换/运行拒绝、dirty 删除、部分失败/未知、旧记录 | IP-04 | cleanup acceptance 的真实临时目录、GraphQL 身份核验/REST DELETE 回执、删除前写入、独立结果、unknown 对账、debug 写锁与外置证据保留；旧轮次回收记录与只读复查 | REST 传输在测试中为合成回执；旧轮次没有 Orca 登记，不覆盖注销或完整 T4 |
| Reopen verifies the existing canonical identity：原终端、已退出、不可核验、旧未登记、漂移/回收 | IP-05/07 | setup 的 live 聚焦、退出替换、缺失状态/错工作区拒绝、unknown 不重发、原 executable、原 handle 和旧 schema 入口 | PTY 状态/登记回执为合成公开字段 |
| Round defaults preserve external evidence boundaries；Rehearsal failures stay structured：Scope 缺失、人工内容、空成品、离线报告、外部失败 | IP-03/04/05 | setup/collector/process/result/cleanup acceptance，结构化码与报告结果 | 空业务仓库产生 BLOCKED 是被测试断言的预期结果 |
| 合同移交 | IP-01–09 | 两份 change 严格校验；同路径 ledger delta 唯一 owner；IC-12/14/16 与文档同步 | 原 lab 真实业务任务未勾选；未归档 |

## 实际执行的检查

相关测试分批运行。重复复验仅取最终结果，不累加通过数量：

| 检查组 | 文件数 / 通过数 | 实际结果 |
| --- | --- | --- |
| startup-onboarding、model-settings、provider-library-editor、debug-app、debug-cli、route-map-initialization、foreground-planning-runtime、worker-model-settings、debug-harness-e2e | 9 / 78 | 退出码 0；共享编辑器收尾后其中 4 个文件复验 30 项通过 |
| ledger-lab-cleanup/collector/process/result、wizard、exit、workspace、execution-graph、interaction-card | 9 / 162 | 退出码 0 |
| ledger-lab-setup | 1 / 35 | 最终复验退出码 0；包含新增 unknown 登记不重复和成功替换恢复 ready |
| ledger-lab-installed | 1 / 1 | 最终复验退出码 0，71.80 秒 |
| **按文件去重合计** | **20 / 276** | **全部通过** |

主要复现命令：

```sh
pnpm exec vitest run tests/tui/startup-onboarding.test.tsx tests/tui/model-settings.test.tsx tests/tui/provider-library-editor.test.tsx tests/tui/debug-app.test.tsx tests/cli/debug-cli.test.ts tests/application/route-map-initialization.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/worker-model-settings.test.ts tests/integration/debug-harness-e2e.test.ts
pnpm exec vitest run tests/acceptance/ledger-lab-cleanup.test.ts tests/acceptance/ledger-lab-collector.test.ts tests/acceptance/ledger-lab-process.test.ts tests/acceptance/ledger-lab-result.test.ts tests/tui/wizard.test.tsx tests/tui/exit.test.tsx tests/tui/workspace.test.tsx tests/tui/execution-graph.test.tsx tests/tui/interaction-card.test.tsx
pnpm exec vitest run tests/acceptance/ledger-lab-setup.test.ts
pnpm build
ORCA_COMPANION_LAB_INSTALL_ACCEPTANCE=1 pnpm exec vitest run tests/acceptance/ledger-lab-installed.test.ts
```

安装验收实际在仓库外临时 Git 仓库安装 tarball，启动原生 shell，执行生产 `terminalCommand`，输入 bare `ocp --debug` 和 `ocp`。全程不预写项目配置、Provider Library 或凭据来绕过界面。普通启动经生产公开传输/parser 核验环境，选择共享库模型和 issue，确认前项目配置不存在；确认后保存 schema 5 并进入真实协调工作区。之后在普通目录打开同一包的 debug 会话，完成聊天与文件工具调用续接，共 3 次对话请求。Ctrl+C 退出码 0，activeRequests 归零，300ms 观察窗口未追加请求。模型目录和能力探针单独统计，不算作这 3 次对话请求；既有 debug e2e 还覆盖能力核验/流式期间取消和信号退出。

| 工程命令 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 退出码 0 |
| `pnpm lint` | 退出码 0；最后修改文件另做目标 ESLint，退出码 0 |
| `pnpm build` | 退出码 0 |
| `pnpm lab --help` | 退出码 0，包含 list/预览 cleanup/open |
| `openspec validate simplify-ledger-lab-lifecycle --strict` | 退出码 0 |
| `openspec validate add-ledger-lab-rehearsal-infrastructure --strict` | 退出码 0 |
| `git diff --check` | 退出码 0 |

## 画面与检查中修复

[启动画面证据](../../../artifacts/ledger-lab/startup-ui-20261009/README.md) 包含 36 对 PNG/文本：三档尺寸，各覆盖彩色/Nerd 与 NO_COLOR/ASCII 的逐项核验、失败、连接、模型、地图及确认。代表画面按 #52 的圆角框、摘要分界、反色动作与固定页脚检查；长路径裁切与窄屏动作可见。ASCII 状态符号修正后补采对应核验/失败画面。生产组件使用隔离端口，没有真实平台副作用；这些画面不代表完整六票人工视觉接受。

本轮发现并修复：
- 安装验收最初的 Orca fixture 缺公开 envelope 请求 ID，导致 parser 拒绝；补齐 fixture 后继续流程，没有放松生产 schema。
- 真正首次启动时，缺失配置被映射为 config_unreadable，无法进入模型引导；现在缺失返回 config_unavailable，非法/不可读仍拒绝。补入既有 bootstrap 用例并重跑真实安装流程。
- 共享编辑器提取时保留了异步失败、迟到保存 CAS 更新、用户新输入和 Worker 设置入口；目标测试通过。
- 卸载模型编辑器会使未决选择回调失效；首次启动也通过共享编辑器的成功回调切页。拒绝、后来编辑及卸载后的迟到结果均不会触发交接，参数化回归用例通过。
- 模型初始化能力失败不建 Scope；未知终端/登记不重发；替换成功后保留最终 ready 阶段，避免旧状态覆盖新结果。

## 回收接口修复复核

GitHub 当前 GraphQL Mutation schema 没有 `deleteRepository` 字段。原 fixture 模拟该 mutation 成功，未核验真实接口，导致工程测试漏掉此错误。当前实现保留删除前的 nodeId、owner/name、URL 核验，改用公开 REST `DELETE /repos/{owner}/{repo}`；fixture 按 REST 参数分派并检查目标名称。修复复核运行 `pnpm exec vitest run tests/acceptance/ledger-lab-cleanup.test.ts`，17 项通过，退出码 0；这是复验，不追加到上述去重总数。

用户提供的另一 Agent 回收报告对应旧轮次 `ledger-lab-main-20261009132443958-9a43dd4a`。本次只读复查确认：schema 2、`orca: null`，原 `run.json` 的 local/remote 均为 deleted，本地 repo 已缺失，run.json、operator、packages、captures、checks 仍保留；以记录所属 GitHub 账号查询原 nodeId `R_kgDOVCexxg` 和原 owner/name，均返回 NOT_FOUND。复核没有发送删除请求；这些证据仅覆盖该旧轮次的回收结果，不代表完整 T4 通过。

## T4 交互验收：main 首次启动与发现的 TUI 缺陷

本轮现场为 `/home/joshua/.local/state/orca-companion/ledger-lab-t4-20261009/ledger-lab-main-20261009153411061-9d43154c`。`pnpm lab:new --root /home/joshua/.local/state/orca-companion/ledger-lab-t4-20261009 --profile main` 退出码 0。独立只读复查确认私有 GitHub 仓库 nodeId 为 `R_kgDOVCqHVQ`，main 主 checkout 干净，仓库内安装入口可运行，Orca 登记及已连接终端绑定准确，尚无项目配置；证据位于该 round 的 `checks/t4-preparation.json`。

用户人工操作普通 `ocp`，确认自动环境核验正常、已有模型候选可设置、Route Map 已创建并进入对话界面，完成框架生命周期中的配置与初始化步骤。同时暴露以下尚未修复的 TUI 缺陷，完成 task 5.2 不表示这些体验已通过验收：

- 自定义模型 ID 无法提交。用共享编辑器、合成用户库与目录复现：输入 `vendor/exact-model-id` 后按 Enter，`saveModel` 调用为 0、目录发现调用为 1；输入被用于搜索过滤，缺少独立手填状态。
- Coordinator 模型菜单呈现未达到用户验收要求。当前以字符串行组织列表，与 #52 dialog final 及已有 RoleModelMenu 的区域、焦点和动作层次不一致；待沿已定稿样式修复并由用户复验。
- 创建 Route Map 时出现静态“核验中”提示。用挂起的合成 create 端口复现，400ms 内可见画面没有变化；该 busy 阶段未绘制 spinner，却共用核验页脚。最终确认阶段的核验动画需另外复验，不能由此推定已经通过。
- 首次进入新 Session `5ca18362-730b-4972-b33f-f79a86df0b8a` 时提示历史读取失败。临时 checkpoint store 中，未建立首个 checkpoint 的恢复查询返回 absent，历史分页却抛出 `Session has no checkpoint`；Scope 初始化只登记 Session，现有初始化测试未覆盖随后的 transcript 读取。现场后续只读查询已见 1 个 checkpoint、4 条提交记录及 2 个模型步骤，不据初始提示判定现有历史丢失。

用户反馈和限定终端信号保存在该 round 的 `checks/t4-first-start-findings.json`。诊断复现使用临时数据库和合成端口，没有向现场终端发送输入或触发新的模型请求；首次启动诊断时尚未进行退出后采集、注销与回收，后续完成结果见下一节。现场 debug、显式 doctor、lab open 与独立 cancel 档案没有实跑，其自动化证据沿原检查边界记录。

用户发送首条“你好”后补充两项尚未修复的对话核心缺陷：

- Enter 后 composer 正文未立即进入 transcript，等待受理时仍可编辑且光标保持输入态。经真实 TuiApp 与延迟 execute 端口复现：仅产生一次提交，但原正文仍在 composer，后续输入追加到同一正文。现有 `tests/tui/input-protection.test.tsx` 的“提交结果只结清原快照”用例通过，恰好允许等待期间继续编辑，未验证提交中的即时展示与焦点反馈。生产首条消息的 `sessionMessages` 先 await `ensureLiveSession`，后者调用 Runtime 能力核验；TUI 在 execute 返回后才清草稿和刷新。消息受理后模型循环异步执行，不能把该等待误记为整个模型轮次必须结束。
  composer 的 readOnly 只来自已交接 Session，native cursor 条件没有提交中状态；持久等待位只防重复提交，不控制输入焦点。debug 宿主在用户消息同步提交后立即返回 accepted 并通知历史刷新，因此当前协调路径的能力核验延迟不能直接推定在 debug 路径也发生；两者仍都缺显式 composer 提交中态。
- assistant 协议内容块以 JSON 数组展示，含 text/tool_use/input_json_delta。现场只读查询确认两条 assistant entry 都为 `contentFormat: json_blocks`，正文保存原始数组。用合成 AIMessage、真实 checkpoint store 和 TranscriptReader 完整复现：期望可见“你好！\n\n这是正文。”，实际绘制原始数组 JSON。`toDurableMessage` 保留内容块供模型续接，但当前阅读路径没有对可见文本做投影；修复必须保留续接信息及有界读取、来源锚点合同，同时将工具记录留在既有折叠活动中。

新增诊断只使用合成模型响应和延迟端口，没有现场模型请求、终端输入或历史改写。上述输入保护用例复跑为 1 项通过、23 项按名称过滤跳过，不计作新增验收通过；对话核心修复及原现场复验尚未执行。

用户继续报告运行指示与滚动缺陷，2026-10-10 补充只读诊断如下，修复与体验复验仍未完成：

- 普通模式缺 Agent 工作指示。宿主 `runModelLoop` 持有 `AgentTurnDriver` 的运行状态，但 Controller Session/快照未提供该状态，工作区也未消费；进入和退出轮次没有相应通知。当前停止状态通过 blocker 呈现，不能用 Scope 的 active 或 Runtime Lease 代替模型正在运行。debug 已有 `turn-changed`、状态回读和标题中的“轮次进行中”，两种模式的接线不一致。该结论来自限定代码路径检查，尚未用挂起模型的生产工作区做画面复验。
- 鼠标滚轮没有接入 transcript：当前入口与输入处理未启用鼠标报告，也没有滚轮事件处理器。终端自身滚动不等于阅读器导航；尚未在用户当前终端复验鼠标行为。
- 用真实 `TranscriptReader` 和现有 `createTranscriptReadingFixture` 合成端口复现两个跟随边界错误。40 行正文、8 行视窗从最新的 line-32–39 上翻至 line-24–31，再下翻回 line-32–39，`atLatest` 仍为 false；再次 PageDown 才成为 true。只有 4 个展示行的短对话在 16 行视窗中按 PageUp，画面不动却将 `atLatest` 从 true 改成 false。普通 App 在该状态下仅提示历史有更新而不跟随读取，容易出现已到底部却不显示后续消息的错觉。
- 同一 40 行 fixture 中，同时发起两次 `move('older')`，结果为一个 null、一个 line-24–31，最终只移动一页。App 的按键处理没有串行导航，Reader 的 generation 使较早读取失效；连续按键会合并成一次移动。当前用例覆盖单次导航、范围预算和锚点 resize，未覆盖该连续输入边界。

上述滚动复现脚本均退出码 0，以输出的视窗和状态证明缺陷，不计作测试通过。使用 Vite middleware-only 模块加载，无监听服务、真实模型请求或现场输入，模块加载器和 reader 均已关闭。用户所述“表现奇怪”的具体画面仍待补充，不能将这两个复现结果视为其全部症状。

用户于 2026-10-10 继续补充自定义模型元数据缺陷，作为独立问题记录：

- 设置 Provider 和模型时，没有为自定义模型 ID 填写关键元数据的入口。用户报告自定义模型的推理强度选择和上下文计算因此不可用；这与前述“自定义模型 ID 无法提交”的输入交互缺陷分别记录，修好 ID 输入本身不足以满足该需求。
- 用户要求自定义模型配置至少支持推理强度（思考强度）、上下文窗口和输入模态。后续验收需检查这些信息能通过模型设置填写、保存并在重开后恢复，且推理强度选择与上下文统计实际消费相应配置；输入模态也需明确呈现已配置能力。
- 本条仅记录用户反馈与需求，尚未进行代码诊断、独立复现或修复。元数据的具体字段、校验和能力核验方式待方案明确；用户填写的元数据不能据此记为已通过真实模型能力核验。

## T4 退出、采集与回收，2026-10-10

用户确认已关闭本轮 ocp，并要求继续退出与回收验收。本次操作仅针对上述 `ledger-lab-main-20261009153411061-9d43154c`，没有启动模型、Worker 或新的演练轮次。

- 退出后，本地进程检查最初只见仓库内的 zsh shell，未发现匹配本轮仓库路径的 ocp 进程。此检查依据当前进程 cwd/argv，不是模型后端的历史请求或取消回执，不能据此补记退出码或请求取消时间。
- `pnpm lab collect --run <round>` 退出码 0，采集 1 项且协调存储一致；日志保存在 `captures/20261010103118963-98d10fd9/evidence.jsonl`。记录中的 Runtime Lease 已过期，`releasedAt` 仍为 null；这只证明采样时无有效运行租约，不证明退出时已显式释放。
- 未注销时的 cleanup 预览返回 `LAB_ACTIVE_RESOURCE`，正确要求先关闭终端并解除登记；本地和远程均为 present。预览前后 `run.json` 不变，没有执行删除。
- 当前 Orca runtime 为 `75bb80f2-e969-44b6-83e9-2d3a76586c9d`，原记录中的 terminal handle 已失效。经精确 worktree 的公开 terminal list 找到当前句柄 `term_3d35f629-7c6a-403f-b2a8-301171a1cf95`；确认其为用户退出后的 shell，关闭该 tab 后列表为空，原 shell PID 71255 已不存在。没有因旧句柄失效创建替代终端或改写原 run 绑定。
- 公开 `orca project setup-delete --setup 40d54121-a3e4-47ea-8515-e103905b8fc8 --json` 返回成功；随后按原仓库路径查询 worktree 返回 `selector_not_found`，证明本轮登记已解除。
- 注销后的 cleanup 预览退出码 0、blockers 为空。GitHub 只读查询确认目标仍为私有仓库，nodeId `R_kgDOVCqHVQ`、owner/name 和 URL 与记录一致；本地 device 41、inode 94544133 也与创建记录一致。run.json、operator、packages、captures、checks 均存在，预览前后原记录不变。

预检证据为 `checks/t4-exit-preflight-20261010.json`、`checks/t4-exit-user-process-check-20261010.json` 和 `checks/t4-reclamation-preview-20261010.json`。同用户进程检查有 9 个条目的 cwd/argv 因权限无法核验；可读条目没有匹配本轮仓库的进程，不能将此检查写成对全部本机进程的证明。

完成上述具体目标预览后，用户明确要求“直接帮我清理干净吧”，随后执行 `node artifacts/ledger-lab/lab.mjs cleanup --run <round> --yes`，退出码 0：

- 远程先删除、本地随后删除；回执及原 `run.json` 的 local/remote 均为 deleted，code 均为 null。
- 本地 repo 的 lstat 返回 ENOENT。GitHub 按原 nodeId 和 owner/name 联合查询均返回 null 及对应 NOT_FOUND；这是删除后的预期复查结果，gh 退出码 1 不记作删除失败。Orca 再次查询原 worktree 仍为 `selector_not_found`。
- `node artifacts/ledger-lab/lab.mjs list --root <root>` 退出码 0，仍列出原 round 和独立删除状态。run.json、operator、packages、captures、checks 均保留，安装包、首次启动诊断与退出后采集日志仍在；本次没有删除用户级模型库、凭据或 debug 历史。

删除后复查结果保存在 `checks/t4-reclamation-result-20261010.json`，六项限定检查均通过：本地缺失、原远程身份缺失、登记解除、删除状态持久化、外置材料保留及删除后列表可读。结合前述真实创建、登记、人工配置和 Scope 初始化，本轮已完成 task 5.2 修正后要求的框架生命周期，勾选该项。本次未运行模型或新增工程测试；未单独实跑的 cancel 档案及未修复的 TUI 缺陷继续按实际情况记录。

## 未执行与风险

真实 GitHub/Orca T4 main 已完成上述限定框架生命周期；cancel 档案、现场 debug/doctor 与 lab open 未单独实跑，TUI 缺陷修复后的复验、真实 Worker 执行及完整业务剧本没有运行，不计通过，原 lab 真实验收任务保持未完成。工程测试使用合成凭据；本次退出与回收没有模型调用，仅关闭、注销并删除用户指定的 T4 main 仓库，保留外置记录与证据。

回收仍会删除本轮仓库内的业务提交和未提交文件；用户先退出相关运行并解除 Orca 登记，预览目标后再明确执行 `--yes`。schema 1 缺历史删除身份证明时不能自动回收。支持证据限 Ubuntu，未验证 Windows。

远程删除是核验 ID 后按名称寻址，REST 不提供 expected nodeId 原子条件。预检与删除之间的并发重命名或同名替换仍可能导致误删；当前测试未覆盖这种竞态，回收期间应保持远程目标稳定。
