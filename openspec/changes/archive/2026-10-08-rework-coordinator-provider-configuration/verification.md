# Verification

## 验收对象

- Change：`rework-coordinator-provider-configuration`。
- 规划基线：`f486bd67c64a3dcbd70b81d9773a452ff764bfcb`，直接前驱 `remove-worker-credential-management` 已归档。
- 输入实现 HEAD：`78430376d256a4e2aa0516b91e0bf075188a95ea`，加当时未提交及未跟踪的完整实现。
- 最终验收 HEAD：同上，加验收修复后的工作区。完整实现包含未提交文件，单独 HEAD 不代表本次验收对象。
- 验收 Agent：Maxwell（`01a11be5-6537-76e0-b65a-e0079d0c2128`，继承主模型，只读）；父 Agent 完成限定修复与检查记录。最终检查点交付后未再修改产品代码。
- 日期：2026-10-08。

## 结论

**PASS：用户明确接受的功能范围。** 10/10任务完成；8个Requirement、29个Scenario均有实现、测试或范围决议证据。证据映射不表示每个Scenario都有独立端到端测试。全仓库基线检查后，验收发现的输入覆盖缺陷已修复，受影响路径复验通过，并经Maxwell再次只读核对。

用户原话：“可以，先这样吧，功能先做出来就行，TUI美化可以以后慢慢做”。该验收范围已同步到proposal、design、implementation-plan、tasks和TUI delta。三尺寸材料保留；TUI美化、完整彩色/NO_COLOR、Nerd/ASCII与视觉一致性对照留待后续，不列为本轮通过项。真实付费Provider、真实Orca派发及ledger-lab业务演练也不在本轮已验证范围内。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 实现与证据 | 结果 |
| --- | --- | --- |
| Immutable versioned model settings；跨项目复用与多模型、保存与应用独立、冲突和文件失败保留输入、旧schema拒绝、复杂或秘密字段拒绝、旧记录与旧指纹、nativeWorker拒绝、Worker-only字段拒绝；IP-01/02/05 | `domain/model-configuration.ts`、`application/configuration/{project-config,provider-library,model-settings}.ts`、provider-library store；`tests/bootstrap/project-config.test.ts`、`tests/configuration/{provider-library,model-settings,project-configuration-store}.test.ts`、`tests/adapters/storage/provider-library-store.test.ts`；保存交错修复见下 | 通过 |
| Saved discovered and verified states are distinct；离线保存与拒绝应用；IP-02/04/05 | provider-library/model-settings、`application/coordinator/model-config-switch.ts`；configuration、model-config-switch及bootstrap测试 | 通过；保存不激活Session |
| Versioned broad provider catalog；离线基础目录与自定义协议；IP-03/04 | provider-catalog conversion/adapter/固定JSON/generator、chat-model factory；`tests/configuration/provider-catalog.test.ts`、`tests/adapters/chat-model-factory.test.ts` | 通过；194预设/6119模型，不宣称账户可调用 |
| Endpoint discovery owns candidates；不与目录合并、失败回退与版本更新；IP-03 | `adapters/agents/provider-catalog.ts`；provider-catalog测试覆盖非空独占、空/失败回退、内容/发布版本失效、相同内容保留及重启缓存 | 通过 |
| Explicit bounded refresh and manual model selection；后台刷新与手填；IP-03/05 | provider-catalog、TUI app/editor、lab wizard；目录有界/取消/迟到测试，TUI与lab行为测试 | 通过；未知能力保持未知 |
| Coordinator Model Configuration injects a verified installed chat model；配置/凭据不可用、直接调用、核验后创建Session、集成不可用拒绝、缺少tool calling拒绝、切换全部核验；IP-04/05 | chat-model factory、capability-probe、foreground bootstrap/doctor、model-config-switch；adapter/probe、doctor-model-configuration、foreground-planning-runtime及model-config-switch测试 | 通过；固定adapter与实际工具结果续接探针，不自动fallback |
| Provider replay data survives bounded restoration；推理工具续接及重启、预算和跨模型隔离；IP-04 | session-state、checkpoint-store、workflow context/model-call/nodes、OpenAI converter patch；`tests/adapters/checkpoint-store.test.ts`、`tests/workflow/context-maintenance.test.ts`及tool-loop测试 | 通过；原配置保留必要签名，跨配置移除非可移植载荷 |
| Approved role model settings and independent effort；Coordinator简洁配置与复用、Worker原生选择、默认返回与独立应用、effort不复制候选、编辑与返回、执行更新审阅、逐角色harness选择、三档生产画面；IP-05/06 | TUI app/editor/model-picker/state/ports、foreground与ledger-lab共享服务；TUI model-settings、host-wiring、session-lifecycle、bootstrap及lab acceptance测试；三尺寸画面与用户决议 | 功能通过；完整视觉对照按明确用户决议留待后续 |
| IP-06：消费者、共享fixtures、当前文档与必要仓库检查 | [implementation-evidence](implementation-evidence.md)、[检查日志](implementation-checks/)、[三尺寸材料](../../../artifacts/coordinator-provider-tui/README.md)；active lab delta同步 | 通过；未改写历史现场，未勾选lab剩余业务验收 |

实现路径省略共同前缀`src/`。IP-01–06的具体文件及冻结接缝见[implementation-plan](implementation-plan.md)。

验收阶段修复：`saveModelSettings`的迟到连接成功、模型保存拒绝及项目初始化成功曾覆盖等待期间的新编辑。保存结果现在核对原调用身份和编辑版本，仅同步必要库metadata及已保存项目revision，保留新输入。正常未编辑路径保持保存、返回与明确应用语义；异常路径不覆盖输入，导航代次检查保留。同步修正ports中两处过时的SDK字段路径说明。

新增5个延迟Promise场景在生产TUI与fake ports上验证连接成功、项目保存saved/rejected/throw、初始化成功；连接用例还核验后续保存使用新library revision。修复前为3失败/7通过，修复后全部通过。Maxwell复核局部修复及对应日志，未发现新的功能缺口。

| 命令 | 结果及时间边界 |
| --- | --- |
| `pnpm test --maxWorkers=4` | 验收局部修复前的全仓库基线：189文件通过/7跳过，2106项通过/16跳过，exit 0 |
| `pnpm test tests/tui/model-settings.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/host-wiring.test.ts` | 最终局部修复后：3文件/32项通过，exit 0 |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 最终局部修复后exit 0，日志为`save-race-{types,lint,build}.log` |
| `git diff --check` | 最终修复与记录完成后exit 0 |
| `openspec validate rework-coordinator-provider-configuration --strict` | 通过 |
| `openspec validate add-ledger-lab-rehearsal-infrastructure --strict` | 同步配置delta后通过 |

原始日志及默认并发失败记录见[实施证据](implementation-evidence.md)。最终局部修复复验受影响路径，没有将此前全仓库结果写成修复后重新执行的全量结果。

## 限定审计

审计范围为本change的strict配置与秘密边界、不可变存储/CAS、catalog版本与发现权威、固定SDK参数及请求路径、tool continuation/主动取消/usage、replay恢复与预算/跨配置隔离、UI异步结果身份与新输入保留、Worker原生配置隔离及lab共享用例。

前一轮独立审查的五处SDK合同偏差已修复，并由Maxwell抽查对应实际SDK mock或checkpoint/context测试：Responses调用ID record与summary index、Anthropic root路径、OpenAI reasoning.effort、Gemini originalTextContentBlock签名、thought:true过滤。具体修复与来源见[实施证据](implementation-evidence.md)。本轮再发现的输入覆盖问题亦已修复并复核结清；限定审计无待修功能缺口。

## 后续注意事项

- 默认并发的全量及复验曾出现历史阅读压力测试超时和PTY输入/退出等待失败；限制4个worker的全套通过。该时序不稳定保留为检查限制，条件跳过不计通过。
- TUI视觉打磨与完整对照按用户决议留待后续；本轮不承诺所有Provider实机兼容，启动和应用仍必须执行能力准入。
- SDK converter patch随依赖升级复核；旧schema拒绝且不迁移。
- 委派Agent曾未经授权产生`7843037`，已披露并保留历史；其余实现和后续修复未提交。该操作偏差不被本功能结论追认授权。未执行新的Git提交、历史改写或归档。
