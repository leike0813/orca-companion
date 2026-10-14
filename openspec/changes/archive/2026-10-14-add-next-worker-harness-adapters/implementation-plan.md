# Implementation Plan

## 分级续办（基线 21ddd79）

本轮沿 tasks 6.1–6.4 执行，当前准入合同以 `workers/harness-support`、IC-07 和
`grade-worker-harness-admission` 的落地实现为准。首轮的版本、完整矩阵与 PASS
保留其原验证范围；下列按完整资格才注册的首轮实施记录不作为本轮准入门禁。

- 复用 `tests/support/worker-harness-acceptance.ts` 和既有真实矩阵，先验证
  Hermes/Cline 的 basic；Kimi 在精确隔离目录处理原生信任后复核基础角色；
  Kilo 与有希望的候选继续 enhanced。
- basic 不要求原生 Session、完整历史或响应模型回显；enhanced 要求精确 Session、
  四角色、Implementation resume 和 Validator 同 Session 续接；complete 才追加
  完整历史、Recovery 与 mixed Controller。只读按实际操作单独核验。
- 修改范围：当前 change artifacts、`worker-harness-qualifications.ts`、相关既有
  tests、研究/兼容性文档与当前支持摘要；必要的原生启动修复限所属 adapter。
  新证据追加到 `artifacts/next-worker-harness-adapters/`，不覆盖旧失败现场。
- Kimi 常规工具审批在真实轮次复现；所属 adapter 使用原生逐次 `--yolo`
  （Ask When Needed），保留原生风险审批，不写默认权限或信任数据库。
- Muse/Cursor 缺 CLI/原生登录及获批模型时只记录前置条件，不安装或推测配置。
- 验证使用相关 adapter/资格/registry/模型设置/doctor 回归、types/lint/build、
  OpenSpec strict 与 diff；真实结果按实际 Task/Dispatch/工件独立存证。

## 1. 实施基线

predecessor-contract：直接前驱 archive/2026-10-11-add-testable-worker-harness-adapters；HEAD 13b203f62bbb68a60456c5acd7d28e4c54c625a4，起始工作区干净。主规格 workers/harness-adapters、WorkerHarness 和七项 registry 已核验。冻结 IC-02 mutation/unknown、IC-07 Session/Envelope、IC-08结算、IC-09恢复/预算、IC-14 modelSelection；只增加独立报告安装行为。Project schema5、Manifest4、SQLite schema不变。lab active 独立保留。

## 2. 实施映射

| IP-ID | Task | Requirement/Scenario | Owner、文件与接缝 | 行为变化 |
| --- | --- | --- | --- | --- |
| IP-01 | 1.1 | 全部新 requirement | change artifacts、候选事实表、原生 CLI/source | 版本、公开报告/导出/恢复事实，更新 SSOT |
| IP-02 | 2.1 | 独立安装全部场景 | adapters/agents 报告定义；scripts/worker-harness-reporting.mjs；原 Worker runtime | 独立 install/status/uninstall，启动只检查，非 Companion noop |
| IP-03 | 3.1–3.5 | 精确 Session 全部场景 | adapters/agents/*-harness/*-transcript；WorkerHarness 与既有 process/readonly/session/recovery seams | 七家完整实现，各自拥有原生格式；parent拥有共享模块，禁止并行重叠写 |
| IP-04 | 4.1–4.3 | 分级验收全部场景 | tests/adapters/agents、现有 real worker matrix/support 与 mixed Controller fixtures；候选显式注入 | 五家独立探索真实资格，具体原生阻塞可延期；Muse/Cursor离线与后续任务；完整通过者才进入mixed Controller与注册 |
| IP-05 | 5.1–5.2 | 全部场景 | bootstrap registry、domain/model-configuration、catalog/runtime、src/bootstrap/doctor.ts、tests/doctor.test.ts；AGENTS、IC-07、兼容性、研究、OpenSpec config、verification | 只反映实际通过者，最小受影响caller/fixture回归；doctor 经所属 harness 查询原生目录 |

## 3. 文件与公共接口

新增七家 adapter/原生格式 reader、专用报告定义与维护脚本、最小高价值 tests、当前change artifacts与验收 evidence。修改仅真实通过者所需的生产注册/canonical IDs、catalog/runtime 与受影响测试替身，以及当前合同文档。IP-04 共用 `src/interfaces/cli/main.ts` 的身份环境过滤与 `tests/doctor.test.ts` 的既有回归，覆盖终端与 structured agent session 身份的隔离；Companion 的调用身份仍经可信 Scope 显式提供。WorkerHarness 复用原输入/结果联合，候选以测试注入，不增加生产实验状态、凭据端口、数据库、通用插件平台或依赖。不修改 ledger-lab、上游私有源码、package/lockfile 和用户默认模型/provider/认证；没有计划项目文件删除。

## 4. 调用、权限与失败

当前适配范围只包含本项目与未修改的 Orca 公开 CLI/runtime。用户已禁止 patch Orca，
独立源码副本产物只作历史诊断，不再继续匹配、构建或应用。IP-04 先调查原生启动、
结构化输入与现有 launcher 的适配空间；公开选项不等于合同通过，不降低 prepared
就绪标准、不重放原已接受创建。替代路径只有在精确 Session、只读、Task/Dispatch、
Delivery 与恢复均可证明后，才更新相应合同和实施映射；当前 Antigravity 已完成该资格并注册，
其余六家未注册。角色矩阵与 mixed Controller 的独立证据见研究 SSOT 和 tasks。

原生 stream + 临时 launcher 内单轮输入转换已取得公开就绪、真实监督派发/结算、
精确 Session/完整覆盖和 Delivery ack。外层 bridge 对照就绪但识别失败；减少外层
进程后通过，具体 foreground 分类规则尚未证明。IP-04 下一步在所属 adapter/launcher
边界核验连续回复、result 驱动、取消、exact resume 和恢复；复用原报告器、只读
包装与 prepared strategy 的 Orca 提交归属，不加第二套调度/身份来源或放宽就绪。
stream 完整矩阵证明可信 JSON 屏幕会被原生 TUI 就绪规则拒绝，取消该实现路径。
IP-03 增加 `src/adapters/agents/antigravity-tui-output.ts` 的有界重复协议过滤，
`codex-model-launcher.ts` 增加封闭私有 outputProtocol 与系统 script PTY 包装；
`candidate-worker-launch.ts` 转交配置，Antigravity adapter 保留真实 TUI。
所属 adapter 增加原生 summary 的精确只读身份核验与配对工具 ERROR 的终态覆盖。
对应 tests/adapters/agents 下过滤回归与既有 adapter/只读 launcher 检查。
IP-04 的既有矩阵夹具沿精确 transcript 等待 Validator 的最终 assistant 标记，
复用已有 Finalizer 的有界证据等待；worker_done 先到时不把缺标记的范围传给 Recovery。
IC-07、architecture、AGENTS、研究/兼容性随实际结果
更新。其他 harness 不选该协议，WorkerHarness/public DTO 与存储不变。
新模式角色矩阵和 mixed Controller 完成前，IP-05 不注册；真实 probe 在独立资源
中验证，原 Controller 保留。先前证据见 antigravity-stream-bridge-20261013.json。

独立报告 setup→真实原生环境 launcher→Orca TUI接管→精确 report/native identity交叉核验→四角色结果/Delivery结算→原Session续接/resume→Recovery→mixed Controller→正式注册。所有Orca mutation经ExecutionBackend/公开CLI稳定OperationId，unknown仅沿原ID对账。report only路径与标识；roots重叠、报告缺失/冲突、transcript覆盖不完整一律unavailable。resume保持原 Task授权/profile/Attempt/预算，不新建session冒充。安装卸载只管理自有条目，Worker启动不写原生配置。

## 5. 验收映射与命令

| 测试 | 契约与观察 | 验证 |
| --- | --- | --- |
| adapter离线 | 精确ID/cwd/活动历史、恢复、目录取消/超限、拒绝未知数据 | pnpm exec vitest run tests/adapters/agents |
| installer | 保留其他条目、重复安装/卸载、非Companion无动作、缺安装拒绝 | 专用setup tests，同上Vitest |
| 五家真实矩阵 | 四角色、actual model/usage、exact binding/resume、Validator续接、Recovery、readonly/foreground | 现有tests/acceptance/worker-harness-matrix，以显式real开关与候选注入；串行运行 |
| mixed Controller | 原Task/授权/预算、结果结算、人工中断与同Scope重启、deliverable | 复用既有隔离mixed fixture；不触碰lab |
| Muse/Cursor | 完整实现/离线，不注册；后续账号/CLI/Orca/readonly真实任务明确 | 对应fixtures与registry rejection |
| 最终 | 所有场景与已有七家回归 | pnpm typecheck；pnpm lint；pnpm build；pnpm test；openspec validate add-next-worker-harness-adapters --strict；git diff --check |

## 6. 执行与证据

Antigravity先验收，另三组adapter可并行开发；共享文件与真实模型动作串行。每项证据记录CLI/source版本、Task/Dispatch/Attempt、Session、coverage、model/usage、resume/Recovery与Controller结果；跳过/失败不写PASS。精确终端和worktree存证后公开回收已终结资源，失败unknown保留现场。verification按实现/离线/真实/注册分别记录；未完成task保持未勾选。不提交、不自动archive。

候选探索任务只有完整矩阵通过，或已形成包含尝试路径、阻塞合同、原生来源及重新验收前置条件的延期结论，才可勾选；延期不勾选对应的真实能力、不进入生产注册。至少持续推进有希望者至完整资格或可复核阻塞，不因单轮探针结束停止整个change。
