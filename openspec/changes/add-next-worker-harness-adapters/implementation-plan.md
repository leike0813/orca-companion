# Implementation Plan

## 1. 实施基线

predecessor-contract：直接前驱 archive/2026-10-11-add-testable-worker-harness-adapters；HEAD 13b203f62bbb68a60456c5acd7d28e4c54c625a4，起始工作区干净。主规格 workers/harness-adapters、WorkerHarness 和七项 registry 已核验。冻结 IC-02 mutation/unknown、IC-07 Session/Envelope、IC-08结算、IC-09恢复/预算、IC-14 modelSelection；只增加独立报告安装行为。Project schema5、Manifest4、SQLite schema不变。lab active 独立保留。

## 2. 实施映射

| IP-ID | Task | Requirement/Scenario | Owner、文件与接缝 | 行为变化 |
| --- | --- | --- | --- | --- |
| IP-01 | 1.1 | 全部新 requirement | change artifacts、候选事实表、原生 CLI/source | 版本、公开报告/导出/恢复事实，更新 SSOT |
| IP-02 | 2.1 | 独立安装全部场景 | adapters/agents 报告定义；scripts/worker-harness-reporting.mjs；原 Worker runtime | 独立 install/status/uninstall，启动只检查，非 Companion noop |
| IP-03 | 3.1–3.5 | 精确 Session 全部场景 | adapters/agents/*-harness/*-transcript；WorkerHarness 与既有 process/readonly/session/recovery seams | 七家完整实现，各自拥有原生格式；parent拥有共享模块，禁止并行重叠写 |
| IP-04 | 4.1–4.3 | 分级验收全部场景 | tests/adapters/agents、现有 real worker matrix/support 与 mixed Controller fixtures；候选显式注入 | 五家独立探索真实资格，具体原生阻塞可延期；Muse/Cursor离线与后续任务；完整通过者才进入mixed Controller与注册 |
| IP-05 | 5.1–5.2 | 全部场景 | bootstrap registry、domain/model-configuration、catalog/runtime；AGENTS、IC-07、兼容性、研究、OpenSpec config、verification | 只反映实际通过者，最小受影响caller/fixture回归 |

## 3. 文件与公共接口

新增七家 adapter/原生格式 reader、专用报告定义与维护脚本、最小高价值 tests、当前change artifacts与验收 evidence。修改仅真实通过者所需的生产注册/canonical IDs、catalog/runtime 与受影响测试替身，以及当前合同文档。WorkerHarness 复用原输入/结果联合，候选以测试注入，不增加生产实验状态、凭据端口、数据库、通用插件平台或依赖。不修改 ledger-lab、上游私有源码、package/lockfile 和用户默认模型/provider/认证；没有计划项目文件删除。

## 4. 调用、权限与失败

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
