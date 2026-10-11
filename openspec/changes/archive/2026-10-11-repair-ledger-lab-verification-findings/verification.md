# Verification

## 验收对象

- Change：`repair-ledger-lab-verification-findings`，Ubuntu 本机，2026-10-10。
- 输入实现 HEAD / 最终验收 HEAD：`e6203fb43269a49005888daa8bda78735c34907f`。实现保留在工作区，未提交、同步主规格或归档。
- 工具链：Node.js v24.12.0、pnpm 11.10.0、Vitest 5.0.1。
- 独立验收 Agent：Pauli（模型、用量、历史）与 Confucius（输入、轮次、导航、鼠标、回收）。两位均未参与其审查范围的实现，最终只读复查通过。
- 固定实现：完整 HEAD + 工作区文件清单见 [checkpoint v2](../../../artifacts/ledger-lab/verification-repairs-20261010/review-checkpoint-v2.json)，729 个文件，SHA256 `5cb776b2d797493f56effd483d09745c1da20da4c0775ad6ce52ee5e21ba010a`。文本完整 diff 见 [review-v2.patch](../../../artifacts/ledger-lab/verification-repairs-20261010/review-v2.patch)，二进制画面由清单逐文件哈希固定。审查首尾及保存证据前再次核验，729 个文件均一致；本验收文档、审查记录和日志副本在冻结后新增。

## 结论

**PASS：本 change 的 13 项 Requirement、23 个 Scenario、IP-01–08 与 9 项实施任务完成，八个限定审计标签全部通过，无剩余范围内缺陷或待审计项。**

结论覆盖代码、合成协议 / 公开平台传输、真实 SQLite 和生产组件的 Ubuntu PTY；不表示真实 provider、真实 Orca / GitHub 重跑或原 lab 完整业务剧本通过。原 `add-ledger-lab-rehearsal-infrastructure` 的业务任务保持原状。

## Requirement / Scenario / IP 证据

下表逐项覆盖本 change 的 delta specs。测试文件路径以当前仓库为准，模型库用例实际位于 `tests/configuration/provider-library.test.ts`。

| Requirement / Scenario | IP-ID | 核验依据与结果 |
| --- | --- | --- |
| Declared immutable model metadata；自定义模型保存重开 | IP-01 | provider-library、model-settings、editor：窗口、输入模态、来源和推理能力进入不可变快照，重开恢复；校验 / 保存失败保留输入 |
| Distinct manual model input；手填未收录模型 | IP-01 | editor：手填与目录搜索分开，exact ID 不改写，不依赖目录命中；重复 ID 优先精确 modelRef 或最新记录 |
| Fixed protocol reasoning presets；声明后调用固定协议 | IP-01 | chat-model-factory、provider-library：固定协议预设与真实 adapter 参数映射；声明不替代 capability probe |
| Model window caps effective input budget；较小模型窗口 | IP-02 | foreground-planning-runtime、debug-runtime：请求 / 压缩使用项目预算与声明窗口的较小值；模型容量独立取可信 backend / 模型窗口 |
| Protocol-correct last request usage；不同流式用量语义 | IP-02 | coordinator-graph：Anthropic 输入含缓存、输出取末次累计，OpenAI / Gemini 使用 SDK 聚合；缺数报告保持 null，不补零或累计历史 |
| Empty registered history and bounded visible projection；首次进入及协议内容、长旧响应恢复 | IP-03 | checkpoint-store、history-display-projection、history-inspection、reader、search：空会话可读；可见 text 排除 thought，原文 / replay 不变；旧记录增量准备，阅读和搜索共用 UTF-8 显示坐标 |
| Observable genuine agent turn state；挂起请求与停止 | IP-05 | controller-service、agent-turn-driver、foreground runtime、workspace：真实 idle / running / halted 状态与事件接入；Scope active 不冒充模型工作状态 |
| Immediate pending submission presentation；延迟受理继续编辑、快照写失败与未知 | IP-04 | input-protection、input-paths、debug-app：先持久快照后展示 pending / 分离原草稿，原 lane 防重复；accepted 只结清原快照，CAS 冲突保留并发输入；rejected / unknown 保留原身份 |
| Actual asynchronous initialization feedback；延迟创建和初始化 | IP-05 | startup-onboarding、foreground runtime 与 PTY：Route Map 创建和最终确认核验使用真实在途 spinner / 已完成项 |
| Serialized transcript navigation and regional wheel；连续翻页及到底、区域滚轮与覆盖层 | IP-06 | reader、mouse、生产 PTY：连续导航串行，到底 / 无位移保持跟随；失败保留旧 frame，旧 Session 迟到请求不改变新状态；滚轮三行且限制区域，overlay / composer 隔离，退出恢复模式 |
| Exact current model context observation；Available exact integration and stale observation、Missing exact capability、Real last request usage | IP-02 | project-presentation、foreground runtime、debug runtime：精确观测校验 Session / configuration / input revision；无精确能力时如实显示上次已提交请求，窗口未知不画百分比；项目预算不当作窗口 |
| Shared repaired conversation behavior；调试发送及重开 | IP-03–06 | debug-app、debug-runtime、既有 debug 集成：共用提交、reader、鼠标与真实 usage；重开读回原配置绑定和上次请求用量 |
| Explicit repository reclamation；预览、显式回收、目标替换、已有业务改动、运行资源、删除前漂移 / 后置不明 | IP-07 | ledger-lab-cleanup：默认预览；删除前持久意图并立即复核，删除后证明原 node 和名称均缺失；稀疏响应 / unknown 停止本地回收；身份、活跃资源及外置证据边界保留 |
| 上述全部合同与证据移交 | IP-08 | AGENTS、architecture、interface-contracts、TUI handoff、lab guide、OpenSpec config 同步；严格校验、完整检查及独立画面证据通过 |

## 实际检查

测试数量按最终全量运行统计；局部复验和审查者测试不重复累加。

| 命令 | 最终结果 / 证据 |
| --- | --- |
| `pnpm test` | 202 文件、2319 项通过；8 文件、17 项跳过；退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/full-test.log) |
| `pnpm typecheck` | 退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/typecheck.log) |
| `pnpm lint` | 最终退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/lint.log) |
| `pnpm build` | 最终退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/build.log) |
| `pnpm exec vitest run tests/tui/input-protection.test.tsx tests/tui/debug-app.test.tsx tests/tui/transcript-mouse.test.ts` | 3 文件、47 项通过；退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/input-tests.log) |
| `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts tests/adapters/history-display-projection.test.ts` | 异常 cause 修正后 2 文件、58 项通过；退出码 0，[日志](../../../artifacts/ledger-lab/verification-repairs-20261010/projection-tests.log) |
| `node artifacts/ledger-lab/verification-repairs-20261010/capture.mjs` | 8 场景 × 三档尺寸 × 两套色彩 / 图标 = 48 场景，114 对独立 PNG / TXT；退出码 0，[最终 manifest](../../../artifacts/ledger-lab/verification-repairs-20261010/capture-2026-10-10T15-27-36.878Z/manifest.json) 的 failures 为空 |
| `openspec validate repair-ledger-lab-verification-findings --strict` | 退出码 0 |
| `git diff --check` | 退出码 0 |

画面尺寸为 120×40、80×24、50×40；各覆盖彩色 / Nerd 与 NO_COLOR / ASCII。每格包含完整及分段 SGR 报告、草稿隔离、composer 区域忽略、overlay 禁止与退出恢复检查。实施者人工抽查代表性菜单、初始化、空会话与滚动画面，对照已批准 #52 / #47 / #40 / #48 来源；没有改写原型。画面端口为合成替身，详见 [证据说明](../../../artifacts/ledger-lab/verification-repairs-20261010/README.md)。首轮矩阵及中断试跑保留为过程证据，不冒充最终矩阵。

## 验收阶段修复

首轮独立审查固定 [checkpoint v1](../../../artifacts/ledger-lab/verification-repairs-20261010/review-checkpoint-v1.json)，发现 12 项范围内缺陷。修复后重新运行受影响检查、全量测试和画面矩阵，再冻结 v2 并独立复查。规划工件未通过删减要求掩盖不一致。

| 范围 | 修复 |
| --- | --- |
| 模型编辑（2 项） | 校验 / 保存失败保留声明、窗口和焦点；重复 ID 恢复优先精确 ref / 最新记录。补修窗口 Enter 的动作转移 |
| 用量 / 容量（2 项） | Anthropic 任何不完整片段不采用 seed；精确容量不受项目预算冒充 |
| 历史投影（3 项） | 未准备来源不读 raw；正文与有界游标共用预算并严格校验游标；完整 grammar / EOF / depth 核验，非法新提交回滚、旧准备明确失败 |
| 提交（1 项） | 两个 App 的 accepted 回调只结算快照，删除冲突后再次 clearDraft 的路径 |
| 导航（2 项） | 底部查询成功后才发布 frame；迟到异常核验 generation |
| 鼠标（1 项） | 使用公开 raw stdin 前缀信号重组 Ink 剥去 ESC 的分段报告，同时保留普通 `[` 的即时输入 |
| 回收（1 项） | GraphQL 必须拥有 node / repository 字段，不能把缺字段当作 null |

Lint 首次因并行 PTY 临时文件被移除而中断；稳定重跑发现新异常未携带 cause，补齐后最终通过。最终构建与投影用例亦复验通过。

## 限定审计

独立复查记录：[模型 / 用量 / 历史](../../../artifacts/ledger-lab/verification-repairs-20261010/review-model-usage-history.md)、[输入 / 导航 / 回收](../../../artifacts/ledger-lab/verification-repairs-20261010/review-input-navigation-cleanup.md)。Pauli 独立运行 106 项历史 / 编辑测试、5 项 usage 筛选与 22 项配置测试，并核验 grammar 边界；Confucius 独立运行 7 文件 119 项，复跑 Reader / GraphQL 反例与生产 PTY。两者首尾核验冻结对象一致。

| 标签 | 核验范围与结论 |
| --- | --- |
| immutable-snapshot | 元数据 / 固定协议预设沿原 owner，旧 modelRef / 配置历史不改写；通过 |
| usage-semantics | 四协议片段语义、缓存、缺数、最新 step 及配置绑定，精确 / last_request 区分；通过 |
| bounded-projection | 原文 / replay 权威、64 KiB 批次含游标、depth 64、损坏拒绝、读 / 搜索坐标一致；通过 |
| submission-loss | durable snapshot、CAS 冲突、accepted / unknown / rejected、新草稿与原身份；通过 |
| turn-authority | 真实轮次状态持久化及事件投影，不另建状态机；通过 |
| navigation-order | 串行移动、短历史 / 到底跟随、失败 frame 和迟到 Session 隔离；通过 |
| mouse-input | 公共 stdin、分段 / 完整 SGR、普通输入、区域 / overlay / 终端恢复；通过 |
| deletion-toctou | 前置 / 即时身份证明、明确字段、后置缺失证明、unknown 禁止本地继续；通过，剩余平台原子性限制见下 |

## 后续注意事项

- 未运行付费或真实 provider、真实 Orca / GitHub 回收、真实 Worker、原 lab 业务剧本、独立 pack/install、Windows 或 IME / 用户人工体验；相应 gated 用例按实际跳过，不计通过。未安装依赖、改用户凭据 / 状态、提交或归档。
- 用户声明的模型元数据只证明已配置，实际服务支持仍由既有 probe 核验。旧历史 JSON 损坏、超过 64 层或游标损坏会明确阻塞准备，原始记录保留。
- GitHub REST DELETE 按名称寻址，没有 expected nodeId 的原子条件。立即复核缩短竞态窗口，无法消除复核与删除之间的并发重命名 / 同名替换；回收期间仍需保持远程目标稳定。这是已批准 D-06 的平台限制。
