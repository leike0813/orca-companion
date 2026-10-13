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
- [ ] 4.3 IP-04 新通过项参与 mixed Controller、人工中断及同Scope重启闭环，存证后回收测试资源。

## 5. 最终集成与报告

- [ ] 5.1 IP-05 仅注册真实通过者，更新受影响caller/fixture、当前合同、支持文档与OpenSpec上下文。
- [ ] 5.2 IP-05 完成types/lint/build/full tests/strict/diff与限定审计，verification如实记录四级状态。

当前为 9/12 tasks，新生产注册 0。七家实现与离线验证完成；Antigravity
已通过独立四角色、Implementation resume、Validator 同 Session 续接与新 Recovery，
其他六家按具体原生阻塞或账号/CLI前置条件延期。延期不作为真实资格通过。

Antigravity + Qwen 的 mixed Controller 已建立隔离 fixture，Scope
`ip04-mixed-controller-485da76f-4ba2-4c13-941a-ff479dde1049`。验收宿主现经
`toChildEnvironment` 去除主终端身份环境，同 Scope 和原授权恢复通过。
原生工作区信任菜单确认后，原 prepared terminal 的公开 `tui-idle` 等待仍超时；
paneRuntimeId=-1、rendererGraphEpoch=0，不能用可见输入框代替 satisfied/running。
测试进程已停止，没有 Worker turn 在途，原终端与授权保留等待精确核验。
4.3、生产注册与独立最终 verification 保持未完成，不提前勾选。

本轮 typecheck、lint、build、OpenSpec strict、diff 通过；全量
`pnpm exec vitest run --maxWorkers=4` 最终为 2521 passed / 18 skipped，
212 文件通过、9 文件跳过。静态回归不代替真实 Controller。
独立限定审计发现的 Kimi 安装解析与 Muse 身份/覆盖缺陷已修复并独立复核关闭；
没有新增生产注册，完整 Controller 与 schema 要求的最终 verification 仍待完成。

当前资格、延期与恢复条件见：
- `docs/research/next-worker-harness-adapters.md`
- `artifacts/next-worker-harness-adapters/exploration-20261012.json`
- `artifacts/next-worker-harness-adapters/controller-preparation-20261012.json`
- `artifacts/next-worker-harness-adapters/audit-20261013.json`

历史尝试及原 OperationId/unknown 回执保留于研究记录和各轮 evidence；
未重放旧 unknown，未放宽身份、覆盖、权限或 prepared terminal 就绪条件。
