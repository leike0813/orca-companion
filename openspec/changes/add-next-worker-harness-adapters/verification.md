# Verification

## 验收对象

- Change：`add-next-worker-harness-adapters`，schema `orchestrated-delivery`。
- 输入实现 HEAD：`622cb5184984c7b4486ecb15136bb19ddda5c9f6`。
- 最终验收 HEAD：`622cb5184984c7b4486ecb15136bb19ddda5c9f6`。
- 验收 Agent：独立 Codex verification agent `01a1388c-517c-7c40-afca-d3187f6b6b53`；parent 负责产品决策与最终接受。
- 最终输入快照：`/var/tmp/ocp-agy-final-implementation-checkpoint-20261014.tgz`，SHA256 `599263cc65233b87dead1559d7254aab2d5b6e415786cbfdb458dbdda08daf3e`，配对 diff 为 `/var/tmp/ocp-agy-final-implementation-checkpoint-20261014.diff`。
- 准备阶段快照：`/var/tmp/ocp-agy-implementation-checkpoint-20261014.tgz`，SHA256 `3d1a3dd35e404b38c8902257fefcb5157e6c41a4c832d34d3ead2b58e6ea0177`，配对同名 `.diff`。

实现处于未提交工作树，HEAD 本身不包含本轮全部实现。两份快照的 SHA256 均经实际核验；最终快照含 874 个文件，其中 515 个产品源码、测试和脚本文件与验收时工作树逐字节一致，没有快照外未提交产品文件。本验收只新增本文件、完成 tasks 5.2 和同步其当前进度；这些验收记录不在输入快照内。parent 后续研究页/handoff 的记录更新不扩大产品验收对象。

已先读取项目 verify skill，并执行 `openspec instructions verification --change add-next-worker-harness-adapters --json`；读取全部 proposal、delta spec、design、implementation-plan、tasks、实际实现、既有测试与下述证据。CodeGraph 优先定位实现，未运行真实模型或 Orca 动作。

## 结论

**PASS**，范围限当前 change 在 Ubuntu x86_64、未修改 Orca CLI/runtime 1.4.224 上的七家候选实现、离线验证、独立延期收敛及完整通过候选的生产接入。3 个 Requirement、9 个 Scenario、IP-01–05 均有覆盖；实施与验收记录完成后 tasks 为 12/12，必需限定审计已闭合。

新增生产注册只有 Antigravity，保留原七家，共八家。Antigravity 完整原生 TUI 资格记录为 **agy 1.3.4**、`gemini-3.8-flash-medium`：四角色、精确 resume、Validator 同 Session 续接、只读 Recovery 和 mixed Controller 均通过。Controller 为 deliverable，人工中断后的恢复、集成、私有 origin 推送及同 Scope 重启保持已证明。Controller 结束后本机 agy 变为 1.3.5；其 available/host-verify 探针不扩展为完整角色资格。

其余六家未注册。Kilo/Kimi/Hermes/Cline 具有具体原生阻塞、尝试路径和重新验收前置条件；Muse/Cursor 完成实现与离线验证，CLI/登录和完整真实矩阵待办。当前规格允许这种独立延期；延期及失败未计为真实资格通过。

## 核验与修复证据

### 基线、前驱与冻结接缝

`predecessor-contract` 基线 `13b203f62bbb68a60456c5acd7d28e4c54c625a4` 位于输入 HEAD 的历史中；`openspec/changes/archive/2026-10-11-add-testable-worker-harness-adapters` 及主规格 `openspec/specs/workers/harness-adapters/spec.md` 均存在。前驱的 PASS 保留原范围，未用它替代本轮 Antigravity 资格。submodule 为 `cc5c85fb7a43ed52c6cd29157210020cd769d84c`，其工作树干净；历史上游副本补丁仅作诊断，未应用于资格所用 Orca。

| 冻结合同 | 实际核验与证据 | 结果 |
| --- | --- | --- |
| IC-02 mutation / unknown | `application/worker-launch.ts`、`adapters/orca-cli/operation-catalog.ts`；[延期证据][exploration]、[回收回执][cleanup] | 复用公开 CLI、可信 scope 与稳定 OperationId；旧 unknown 保留原现场。prepared 接管严格核验原 handle 的 tui-idle satisfied/running；focus 参数不承担身份或就绪证明。 |
| IC-07 Session / Envelope | `application/ports/worker-harness.ts`、`bootstrap/worker-harness.ts`、七家 adapter；[角色矩阵][matrix]、[恢复链][recovery] | 原 WorkerHarness 端口相对基线未改；report 与精确 native facts 交叉证明。candidate activation 为 none，Orca 提交 preamble；不追加试探输入。 |
| IC-08 结算 | `tests/acceptance/worker-harness-controller.test.ts:590`；[Controller][controller] | 四主角色有 Accepted Settlement，Validator verdict 为 passed，Finalizer 为 deliverable。独立矩阵未 ack 的读取不计为 Controller 消费证明。 |
| IC-09 恢复 / 预算 | Controller 测试原 Task/profile 断言及 `:625` 的重启比较；[Controller][controller] | 原 Validator Task/Attempt 保持，replacement Dispatch 明确；Recovery consumedBudget=1，5 bindings、1 Recovery、4 settlements 及预算重启后相同。 |
| IC-14 modelSelection | `domain/model-configuration.ts`、adapter 目录、`bootstrap/doctor.ts`、doctor 回归 | 唯一生产名单八家；Worker 沿原授权/profile 使用 native modelSelection，未知 effort 保持 null，Worker 检查不读取 Coordinator 凭据。 |

主规格“直接读取 harness 数据库推断身份”与本轮精确原生事实核验一并检查。`antigravity-harness.ts:52` 的 Session ID 来自精确 transcript 路径，并与原生 hook 的完整 ID 复核；`:30` 的 summary 查询只按该完整 ID 核对 workspace，冲突即拒绝，不从数据库枚举或选择 Session。按当前 delta 的独立 native metadata 交叉核验要求、D-05 和 IC-07 判定符合；不读取 Orca DB，也不把终端文本、cwd/mtime 或最新记录当身份来源。

相对基线，WorkerHarness port、Manifest schema/授权定义、storage、package/lockfile 和 `artifacts/ledger-lab` 无变更。共享 launcher 的私有 outputProtocol、原生 runtime roots 和 prepared 就绪核验保持现有 owner；未另建生命周期、恢复状态机或依赖。

### Requirement / Scenario

| Requirement / Scenario | 实现、测试与运行证据 | 结果 |
| --- | --- | --- |
| 独立安装的原生 Session 报告插件 | `scripts/worker-harness-reporting.mjs`、`agents/worker-harness-reporting.ts`、各 adapter 的 reporting definition/maintainer；reporting 与七家 adapter 测试、[原七家审计][audit13] | install/status/uninstall 独立于启动，启动只检查与生成 Companion 私有工件；报告仅含所需身份/路径，不管理原生模型、provider 或认证。 |
| 保留用户原生配置 | `antigravity-harness.test.ts:93`；Kilo JSONC、Kimi TOML、Hermes YAML、Cline module、Muse managed hooks、Cursor sessionStart 的安装/卸载测试 | 自有项幂等，其他条目保留；冲突、损坏及可检测并发改写拒绝。Kimi 解析审计缺陷已修复并复核关闭。 |
| 普通原生启动无动作 | `worker-harness-reporting.ts` 的 REPORT_TRAMPOLINE；`antigravity-harness.test.ts:104`；Kilo plugin/Cline host 回调与其他候选的 trampoline 路由 | 无 Companion reporter 上下文时不写 Session 报告、不改变模型或 Session。 |
| 报告安装缺失 | 七家 `probe` 的 reporting unavailable 分支；`candidate-worker-launch.ts:51` 的 checkSetup；reporting 状态及缺失拒绝测试 | 缺安装或无法核验时结构化 unavailable/worker_reporting_missing；启动不补装、不改用户配置。 |
| 下一批候选保持精确原生 Session 契约 | `agents/{antigravity,kilo,kimi,hermes,cline,muse,cursor}-harness.ts`、`candidate-worker-launch.ts`、`worker-runtime.ts`；各 adapter 测试、[资格汇总][qualification] | 七家提供完整端口方法、精确 resume、身份/覆盖检查和 Recovery 配方；有界目录查询或有具体原因的 unavailable，允许未验证 exact ID，不捏造 effort。真实能力缺口按分级 requirement 保持拒绝/延期。 |
| 原生 TUI 的重复协议输出 | `antigravity-tui-output.ts`、`codex-model-launcher.ts`；输出过滤测试、[最终限定审计][audit14]、[TUI 资格][qualification] | 仅过滤完整识别的重复设置；控制字符串、其他/未知/截断输出和全部 stdin 保留，缓冲有界。真实 PTY、foreground、输入提交及监督归属保持；新模式有独立真实资格。 |
| 按精确身份恢复 | 各 adapter `prepareResume`/verifyResume；Kilo、Kimi、Hermes、Cursor 等精确恢复/冲突测试；[Implementation resume][matrix]、[Validator 续接][recovery] | 全 ID/原生精确路径与新观察窗口复核；Antigravity sameSession=true，Validator contextPreserved=true。未通过候选的接口实现不被记为真实恢复通过。 |
| 身份或覆盖不可证明 | 各 adapter native identity/inspectTranscript；陈旧/ID/cwd/manifest/wire/未知记录/覆盖变化拒绝测试；[历史审计][audit13]、[恢复链][recovery] | 冲突、缺失和不完整活动历史 fail closed。Muse 未知记录/冲突 workspace 修复已关闭；Antigravity RUNNING/UNKNOWN 仍拒绝，配对 GENERIC/ERROR 按工具终态核验。首轮 Recovery 失败保留。 |
| 实现状态与生产注册分别验收 | 下表；[研究 SSOT][research]、[延期记录][exploration]、[资格汇总][qualification]、[Controller][controller]；registry 与 doctor 回归 | 七家四级状态分开记录；五家按批准模型探索，只有完整通过的 Antigravity 注册，六家未注册。 |
| 离线完成仍不生产注册 | Muse/Cursor adapter 与 fixtures；`bootstrap/worker-harness.ts:65`、WORKER_HARNESS_IDS；本验收离线 Node assert 自检 | Muse/Cursor 可直接测试 adapter；六个未通过 ID 全部返回 worker_harness_unregistered，且不在生产 canonical IDs 中。真实 CLI/登录、四角色/恢复/只读/Controller 前置条件见 SSOT。 |
| 真实验收通过才纳入 | [四角色+resume][matrix]、[新 Recovery+续接][recovery]、[Controller][controller]、[注册检查][registration]；registry/schema/catalog/probe/doctor 调用链 | 仅 Antigravity 完整通过后注册；总八家，原七家保留。当前 1.3.5 探针未被当成完整 1.3.4 资格的替代。 |
| 阻塞候选独立延期 | [探索记录][exploration]、[研究 SSOT][research]，包括 default-tui-matrix、continuation 与 native source 引用 | Kilo 的多轮输入/resume/只读失败、Kimi 的请求 alias、Hermes/Cline 的覆盖及响应模型缺口有可复核来源和重验条件；各项延期不阻塞已通过者，不删除原失败/unknown。 |

### IP-ID

| IP-ID / tasks | 覆盖与证据 | 结果 |
| --- | --- | --- |
| IP-01 / 1.1 | 前驱/基线及冻结合同表；[SSOT 原生版本、报告/导出/恢复事实][research] | 基线与 owner 成立，七家来源和缺口明确。 |
| IP-02 / 2.1 | 独立维护脚本、七家 reporter、安装/卸载/noop/拒绝测试；[audit13][audit13] | 完成；启动只检查，不自动修复原生配置。 |
| IP-03 / 3.1–3.5 | 七家 adapter/tests、共享 launcher/runtime 与模型目录；[audit13][audit13]、[audit14][audit14] | 实现与离线验证完成；native 真实支持按下表限定。无 WorkerHarness DTO、存储或依赖迁移。 |
| IP-04 / 4.1–4.3 | [matrix][matrix]、[recovery][recovery]、[延期证据][exploration]、[Controller][controller]、[精确回收][cleanup] | Antigravity 完整通过；四家探索形成具体延期。mixed Controller 人工中断/Recovery、deliverable、同 Scope 重启通过；7 个终端有精确关闭回执，fixture 文件及旧失败现场保留。 |
| IP-05 / 5.1–5.2 | registry/canonical IDs、native catalog/doctor/probe、合同与支持文档；[最终检查][registration]、全量日志、两次限定审计、本报告 | 仅实际通过者注册，caller/fixture 回归通过；必需检查、审计与独立 verification 完成。 |

### 七家候选四级状态

| 候选 | 实现 | 离线验证 | 本轮完整真实验收 | 生产注册 / 重验条件 |
| --- | --- | --- | --- | --- |
| Antigravity | 完成 | 通过 | 通过：agy 1.3.4 / gemini-3.8-flash-medium；TUI 四角色、resume、Validator 续接、Recovery、mixed Controller | 已注册；agy 1.3.5 仅记录探针范围。 |
| Kilo | 完成 | 通过 | 阻塞延期：7.8.8 完整 TUI 的 Implementation/Validator 部分通过，Planner/resume/只读 Finalizer/Recovery 未可靠进入模型 | 未注册；公开就绪/输入能在读写路径可靠启动原轮次与 resume 后重跑完整矩阵及 Controller。 |
| Kimi | 完成 | 通过 | 阻塞延期：2.1.1 Planner 身份/覆盖通过；usage.model 为 request.modelAlias，缺实际响应模型事实 | 未注册；原生公开响应/hook/export 证明模型后重跑完整矩阵及 Controller。 |
| Hermes | 完成 | 通过 | 阻塞延期：banner 0.17.0，checkout e20ff352b91623d51ae05ea586a1800aee852402；只读 Finalizer 部分通过，export coverage partial，缺实际响应模型事实 | 未注册；公开完整历史/响应元数据补齐后重跑完整矩阵及 Controller。 |
| Cline | 完成 | 通过 | 阻塞延期：CLI 3.0.70 / SDK 0.0.92；Validator 部分通过，messages 是覆盖写入的上下文快照，modelInfo 为客户端配置 | 未注册；公开 Session/export 能证明完整历史和响应模型后重跑完整矩阵及 Controller。 |
| Meta Muse | 完成 | 通过 | 未运行：本机无 CLI/原生订阅登录 | 未注册；安装官方 CLI、原生登录后补全部角色、精确恢复、Recovery、foreground/只读及 Controller。 |
| Cursor | 完成 | 通过 | 未运行：本机无 cursor-agent/原生订阅登录 | 未注册；安装/登录及支持模型明确后补同一完整矩阵与 Controller；编辑器 BYOK 文档不证明 CLI 的任意 endpoint 能力。 |

以上实现/离线完成不等于原生实际可用。探索任务按当前批准的延期合同收敛，不把未运行角色、失败 Recovery 或单轮成功记为完整 PASS。较早 artifact 的状态、日期和版本保留当时范围；当前生产事实由 registry 与本轮证据确定。

### 命令与证据结果

实施/审计阶段结果由 parent 提供并与仓库证据及全量日志核对；本验收没有重跑全量或真实验收。

| 命令 / 核验 | 执行归属与实际结果 |
| --- | --- |
| `pnpm typecheck`；`pnpm lint`；`pnpm build` | apply 最终检查均 exit 0，见[注册检查][registration]。 |
| `pnpm exec vitest run --maxWorkers=4` | apply 最终检查 exit 0；213 files passed / 9 skipped，2551 tests passed / 18 skipped。日志 `/var/tmp/ocp-agy-final-registration-tests-20261014.log` 的结尾计数已独立读取；skip 不计真实资格通过。 |
| `openspec validate add-next-worker-harness-adapters --strict`；`git diff --check` | apply 最终检查均 exit 0，见[注册检查][registration]；parent 在验收落稿后复核，两项均 exit 0。OpenSpec status 为 isComplete=true，apply 为 all_done、12/12。 |
| `tests/acceptance/worker-harness-matrix.test.ts`，显式真实开关及隔离原生 profiles | apply 的保留真实结果见[角色/resume][matrix]及[Recovery/续接][recovery]。`:02-15` 的 Recovery 阻塞没有被汇总成通过；`:02-42` 新链才证明 complete/source/readOnly 与 EROFS。 |
| `tests/acceptance/worker-harness-controller.test.ts`，显式 mixed fixture | apply 真实测试 1 passed / exit 0；[Controller][controller] passed/deliverable，`restartPreserved=true`；[cleanup][cleanup] 记录 controllerTestExit=0。 |
| audit 的两条 scoped Vitest 命令 | 独立限定审计 6 文件114项 + worker-launch 11项，共125项通过，均 exit 0；精确命令见[audit14][audit14]。 |
| `sha256sum` 两份 checkpoint；共享 uv 环境 Python tar 只读逐字节比较 | 本 verification 实际执行，exit 0；SHA256 匹配；最终515个产品文件无差异、无未捕获产品改动。未展开/覆盖工作树。 |
| `node --input-type=module` 离线 assert 自检 | 本 verification 实际执行，exit 0；productionCount=8，六个延期 ID 均结构化拒绝，七家均提供11个 WorkerHarness 方法。仅加载已构建模块，不调用 native probe、模型或 Orca。 |
| `openspec list/status/instructions apply/instructions verification --json` | 本 verification 实际执行，exit 0；repo-local root/schema/全部 contextFiles 已核对，开始时11/12且 verification 不存在。 |

### 修复记录

verification 阶段产品修复：**无**。doctor P2 为 apply 修复：将绕过 adapter 的目录查询改为已注册 harness 的 `queryModels`，回归证明可用目录与零 Coordinator 凭据读取；独立复核 closed。此前 Kimi 安装解析及 Muse 身份/覆盖修复由历史 audit 记录并闭合，不冒称本 verification 新修复。

## 限定审计

必需审计全部完成，无 pending 项。

- [2026-10-13 七家审计][audit13]：七家 adapter、报告安装器及直接身份/生命周期/只读接缝。Kimi TOML 表边界、command/comment 解析及 Muse 未知 retained record、冲突 workspace 四项均 independentRecheck=closed，修复后的相关回归通过。其历史 Controller 阻塞描述保留当时范围。
- [2026-10-14 最终限定审计][audit14]：agent `01a13889-4ab0-7491-9b1b-a05355ffea1e`，结论 no_findings；覆盖有界协议过滤、控制字符串/截断/背压、PTY foreground/信号、生产只读与 Orca 提交归属、精确原生 summary、ERROR/RUNNING/UNKNOWN 覆盖、注册/目录/默认 executable。doctor-catalog-owner P2 独立复核 closed；125项相关测试通过。

本 verification 复用审计结果并独立核对规格覆盖、快照与注册拒绝边界，没有重复深度过滤/PTY 审计。两次审计与本报告均未用离线检查替代真实角色/Controller；未扩大为全仓审计。

## 后续注意事项

- 支持证据限 Ubuntu x86_64。Windows/arm64 未实测；完整资格为 agy 1.3.4，1.3.5 的生产探针不能证明其完整角色矩阵。后续 native/runtime 更新需独立回归。
- Antigravity 后台 RUNNING 快照仍拒绝 complete，Recovery 使用前台有界读取；后台完成通知不能自行补足覆盖。延期六家的完整真实验收须按上表前置条件重开，通过前继续不注册。
- Qwen 0.25.1 本轮成功不消除 provider startup 更新菜单风险。旧失败 Scope/Worker/Task/unknown 现场保持原结论，不能从新轮成功推断旧输入已交付。
- 原生配置维护的短锁仅协调 Companion 安装器；可检测并发改写会拒绝，未声称与所有 native writers 跨进程原子 CAS。写角色权限沿批准原生参数，严格只读角色由 bwrap/seccomp 强制。
- 没有提交、归档、同步主规格、安装依赖或修改 Orca/ledger-lab。parent 的最终产品接受以及后续 Git/OpenSpec 操作不由本报告自动执行。

[matrix]: ../../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-15-07-641Z-5cf6ca74-2bd4-450d-b9de-dcfc280266b6.json
[recovery]: ../../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-42-26-090Z-425d6eb9-bcb6-44a2-903e-6f57e500e3fc.json
[qualification]: ../../../artifacts/next-worker-harness-adapters/antigravity-tui-qualification-20261014.json
[controller]: ../../../artifacts/next-worker-harness-adapters/controller-20261014T033336705Z-09c8d325-3fc7-4e49-bcd9-aebad90db5e1.json
[cleanup]: ../../../artifacts/next-worker-harness-adapters/controller-cleanup-20261014.json
[registration]: ../../../artifacts/next-worker-harness-adapters/antigravity-registration-validation-20261014.json
[exploration]: ../../../artifacts/next-worker-harness-adapters/exploration-20261012.json
[research]: ../../../docs/research/next-worker-harness-adapters.md
[audit13]: ../../../artifacts/next-worker-harness-adapters/audit-20261013.json
[audit14]: ../../../artifacts/next-worker-harness-adapters/audit-20261014.json
