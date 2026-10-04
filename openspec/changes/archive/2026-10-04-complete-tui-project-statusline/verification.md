# Verification

## 验收对象

- Change：`complete-tui-project-statusline`
- 输入实现 HEAD：`82f6a77e928b838bd4542391bfb0f706c44c16ef`，含该 HEAD 上的未提交实现工作区
- 最终验收 HEAD：`82f6a77e928b838bd4542391bfb0f706c44c16ef`，verification 文档本身保持未提交
- 验收 Agent：`gpt-6-luna`（Wegener），独立验收

## 结论

**PASS** — 六项 Requirement、十个 Scenario、IP-01–06 与 Section 8 限定审计均有实现和证据对应；审计未发现未修复的范围内缺陷。结论限于本次固定 HEAD 上的未提交工作区和下列平台/集成范围。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 实现与证据 | 结果 |
|---|---|---|
| Trusted project and selected session presentation / Session and budget identities / IP-01 | `project-presentation.ts` 与 `foreground-planning-runtime.ts` 从注册 Scope、选中 Session、精确 Claim、当前 Dispatch/Attempt 和批准授权投影；`tests/tui/host-wiring.test.ts` 中 host metadata 用例验证注册 Session 配置与 Claim 且不读取票据正文。预算缺少精确主体或批准引用时保持不可用。 | 覆盖；未发现以其他 Session、首个 ledger 项或 Worker 数据代填的路径。 |
| Exact current model context observation / Available exact integration and stale observation / IP-01 | `chat-model-factory.ts` 只接受 installed integration 明确提供的 `exactContext.measure`；runtime 将完整准备输入和 bindTools 传入测量，并以 Session、configurationRef、effectiveInputRevision 核验结果。`tests/bootstrap/foreground-planning-runtime.test.ts` 精确 context 用例覆盖 snapshot 不测量、输入变化失效；下一用例覆盖迟到结果。 | 覆盖；观察与当前有效输入绑定。 |
| Exact current model context observation / Missing exact capability / IP-01 | `tests/adapters/chat-model-factory.test.ts` 的 ordinary tokenizer/usage 用例证明近似 tokenizer 和累计 usage 不构成精确能力；缺能力投影为 unavailable。 | 覆盖；未见 fallback。 |
| Shared current contract validator acceptance / Current contract and retired nodes / IP-02 | `execution-view.ts` 的 `validatorAcceptanceSummary` 以当前 GraphVersion 未 retire 包为分母，按精确 Task/Dispatch/Attempt/contract revision/authorization 结算去重；`tests/application/execution-view.test.ts` whole-graph Validator acceptance 用例及 release/final 画面核验 statusline、Sidebar、Inspector 共用摘要。 | 覆盖；Task done、旧合同、retired 包和局部窗口不计入。 |
| Version-bound bounded project details / Approved manifest and long data / IP-03 | storage 的 `project-detail-json-field` 按批准 authorization ID/version 和 UTF-8 offset 取字段；`readProjectDetailPage` 限制每页 20 项/64 KiB。`tests/application/project-details.test.ts` 覆盖 UTF-8 连续范围；`tests/tui/host-wiring.test.ts` 覆盖批准 Manifest 连续读取并拒绝 candidate key。supplement checks 记录 approved authorization、bounded pagination、UTF-8 continuation 与 next page。 | 覆盖；批准记录与候选分离。 |
| Version-bound bounded project details / Version changed during reading / IP-03、IP-05 | runtime 在 Scope、Session、对象与 revision 不匹配时返回 stale/unavailable；TUI 回调再核对对象、revision、Session、页面和请求代次，旧页面结果不会替换当前页。`project-details.test.ts` 覆盖 stale/cross-object/session cursor；host wiring 覆盖 Scope/Session/revision 绑定。 | 覆盖；失效可见且可从原入口重读。 |
| User presentation preferences with explicit persistence / Restart and partitioned save / IP-04 | `tui-preferences-store.ts` 对 icons/statusline 分区应用 patch；跨重启与临时图标覆盖场景见 `tests/adapters/tui-preferences-store.test.ts`、host-wiring restart 用例和 supplement checks。实现使用 exclusive lock、revision CAS、临时文件 fsync、rename、目录 fsync 与回读。 | 覆盖；未见跨分区写入或把临时环境覆盖持久化。 |
| User presentation preferences with explicit persistence / Failure and conflicting hosts / IP-04 | adapter 用例覆盖独立 host CAS 冲突、只读/不可读路径与 schema 校验；补采记录第二偏好宿主冲突、保留草稿及显式 Enter 重试。 | 覆盖；冲突不自动重试或覆盖原文件。 |
| Approved custom editor and unsaved icon choice / Save and discard preserve the caller / IP-05 | `app.tsx` 与 `statusline-settings.tsx` 实现内存草稿、同源生产预览、Enter 保存、Esc 放弃和逐层返回；final 截图含设置/保存返回，TUI 行为测试与 supplement 操作记录覆盖原输入及上下文。 | 覆盖；图标与 statusline 分开保存。 |
| Approved custom editor and unsaved icon choice / Failed save followed by another page / IP-05 | `app.tsx` 的请求序号、编辑版本、overlay/Session ownership 检查阻止迟到回调关闭新页或覆盖后续草稿；保存失败保留草稿。`tests/tui/statusline-settings.test.tsx`、TUI 输入/宿主测试和 supplement 的失败/重试画面与操作证据覆盖该边界。 | 覆盖；没有发现迟到焦点回归。 |

按实施计划的 IP 汇总：IP-01 对应可信 metadata/context；IP-02 对应共享验收摘要；IP-03 对应精确批准详情、分页和 Recovery/Finalizer facts；IP-04 对应用户偏好 schema/CAS/原子存储；IP-05 对应状态栏设置、页面归属和迟到结果处理；IP-06 对应六票画面对照、真实 PTY、性能证据及文档/静态检查。相关生产改动、测试文件和证据见上述逐场景映射及 `artifacts/project-statusline/README.md`。

实现期间发现项目工作详情遗漏既有 Recovery/Finalizer 观察。当前代码将选中 Session/revision 的既有投影作为详情观察，并让 Recovery、Finalizer 与图事实继续通过同一有界分页读取；来源失效时要求刷新，不推断或丢弃已有事实。修复后的 `checks/observation-fix.log` 为 10/10，最终 `checks/last-runtime-pty.log` 为 3 文件/42 项通过（含普通真实 PTY 13 项）。

既有验证证据（独立验收复用最终全量与修复后复验记录，未重复运行全量 suite）：

- 原始 `pnpm test --maxWorkers 4`：1690 项通过、2 项失败、12 项条件跳过；失败分别涉及第二 Session lease 注册和详情 JSON/UTF-8 字段读取，原始记录保留于 `checks/final-tests.log`。
- 修复后失败文件及 PTY 相关复验：`checks/details-pty-verified.log` 为 5 文件/110 项通过；其余受影响文件 `checks/affected-final.log` 为 7 文件/92 项通过。去重合并为 1692 项通过、12 项条件跳过；42 项最后复验是后续最终状态检查，不重复累加。
- Recovery/Finalizer 修复后 `checks/observation-fix.log` 为 10 项通过；随后 runtime、host wiring、PTY 最终检查为 3 文件/42 项通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate complete-tui-project-statusline --strict`、`git diff --check` 的最终结果均记录为成功，见 README 与 checks 记录。
- IP-06：六票原型代表及对应 final/supplement PNG 已逐票实际对照；release/final 各 116 对画面，supplement 95 对画面、24 项检查和 53 条操作。性能记录使用生产 TranscriptReader、真实 SQLite 与生产 App：列出的输入/缓存导航 p95 均不超过 100 ms。真实 PTY 最终检查见上述 42 项复验。

## 限定审计

按 implementation-plan Section 8，仅审计以下范围：

| 审计项 | 结论与证据 |
|---|---|
| 精确绑定 | 当前 Session、immutable model configuration、Claim、Dispatch/Attempt、批准授权及对象 revision 均由权威绑定投影；host wiring 与 application/runtime 测试覆盖。 |
| context 失效 | 输入、工具、压缩、模型配置或 Session 绑定改变时递增/失效 revision；迟到测量被拒；runtime 与 application 测试覆盖。 |
| 无 fallback | tokenizer、字符估算、旧 usage 和配置窗口不作为精确能力；chat-model-factory 测试覆盖。 |
| 批准/候选分离 | 详情 key 必须匹配当前批准授权 ID/version；host wiring 对 candidate key 的拒绝有行为断言。 |
| 分页上限 | 20 项、64 KiB、UTF-8 边界 continuation 和绑定 cursor 由应用读取器及详情测试覆盖；宿主测试覆盖连续读取。 |
| CAS/原子完整性 | exclusive lock、锁内重读/CAS、同目录临时文件、fsync/rename/回读和冲突保留由 adapter 实现、测试及补采操作证据覆盖。 |
| 迟到焦点 | statusline 与详情响应分别检查请求代次、Session、当前页面/对象/revision；失败后进入其他页面的行为测试和补采证据覆盖。 |
| 六票画面对照 | P-40、P-43、P-47、P-48、P-51、P-52 的本地定稿代表源码/PNG已核对；`artifacts/project-statusline/README.md` 将各票映射到实际 final/supplement PNG、布局与行为。 |

## 后续注意事项

验证平台限 Ubuntu。真实 provider 的精确 context capability 未做真实 provider 集成验证；Windows 未验证；新增 OS 输入法预编辑/候选窗没有人工验收。全量测试中 12 项条件跳过仍受隔离集成条件约束。历史 GraphVersion 与依据全文仍属第八批范围。这些限制不改变本次已覆盖 Requirement、Scenario 与限定审计的结论。
