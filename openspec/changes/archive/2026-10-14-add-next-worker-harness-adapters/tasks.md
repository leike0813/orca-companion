## 1. 基线与原生能力

- [x] 1.1 IP-01 核验前驱、冻结接缝、七家当前原生报告/恢复/导出事实，记录版本与缺口。

## 2. 独立报告安装

- [x] 2.1 IP-02 实现 install/status/uninstall 与启动只检查，验证保留用户配置、普通启动无动作及拒绝边界。

## 3. 完整 adapter 与离线验证

- [x] 3.1 IP-03 实现 Antigravity 的精确 Session/恢复/覆盖/目录/Recovery 与离线验证。
- [x] 3.2 IP-03 实现 Kilo、Kimi 的完整 WorkerHarness 与离线验证。
- [x] 3.3 IP-03 实现 Hermes 的完整 WorkerHarness 与离线验证。
- [x] 3.4 IP-03 实现 Cline 的完整 WorkerHarness 与离线验证。
- [x] 3.5 IP-03 实现 Muse、Cursor 的完整 WorkerHarness 与离线验证，记录后续真实验收任务。

## 4. 真实验收与注册

- [x] 4.1 IP-04 Antigravity 使用已登录订阅探索完整四角色、resume、Validator续接、Recovery及生产只读/foreground资格；通过或形成有原生证据与重验前置条件的延期结论。
- [x] 4.2 IP-04 Kilo/Kimi/Hermes/Cline 使用中国 MiniMax M Plan 逐家探索同一真实矩阵；各自通过或记录具体原生阻塞、已尝试路径与重验前置条件后延期。
- [x] 4.3 IP-04 新通过项参与 mixed Controller、人工中断及同Scope重启闭环，存证后回收测试资源。

## 5. 最终集成与报告

- [x] 5.1 IP-05 仅注册真实通过者，更新受影响caller/fixture、当前合同、支持文档与OpenSpec上下文。
- [x] 5.2 IP-05 完成types/lint/build/full tests/strict/diff与限定审计，verification如实记录四级状态。

## 6. 按分级准入续办

- [x] 6.1 对齐当前等级合同，区分身份登记、basic/enhanced/complete 与任务级只读能力，核对六家候选及真实验收入口。
- [x] 6.2 继续 Kilo 的高级能力和 Kimi 的基础及增强角色验证；保留精确现场、输入/信任阻塞与已证明事实。
- [x] 6.3 验证 Hermes、Cline 的基础两角色及可行的增强能力；完整历史和模型回显缺口不作为 basic/enhanced 门禁。
- [x] 6.4 根据真实证据更新资格摘要、调用方测试、当前支持文档与续办报告，完成静态/离线检查；记录 Muse/Cursor 的 CLI、登录和模型前置条件。

当前 16/16 项探索与验证任务完成。首轮独立验收范围仍见 [verification.md](verification.md)；
基于 `21ddd79` 的当前结果和原始证据见
[分级续验](../../../docs/research/worker-harness-graded-validation-20261014.md)，后续入口见 [handoff.md](handoff.md)。

Kimi、Hermes 提升 enhanced；Kilo 保持 basic 并新增 Validator 成功事实；Cline/Muse/Cursor
继续 unavailable。Kimi/Hermes 的 Recovery/mixed Controller 未运行，Hermes 历史仍 partial；
这些能力没有计为通过。Cline 的两个 stop_unknown 与 profile 对照的 worker-start unknown、
Kilo 的缺报告派发以及旧失败现场保留原身份，没有重发未知操作。

验收读取修复包括：原 Worker 结算后核验原生快照、在有界重读中刷新导出材料、
阻塞续接保持未证明、保留 worker-start unknown 的 OperationRef。
最终全量 2738 passed / 18 skipped，types/lint/build/strict/diff 通过。
24 个已证明成功的本轮测试终端按精确归属公开关闭，协调终端、未结/unknown 与所有文件保留。
未提交、归档或修改 Orca。
