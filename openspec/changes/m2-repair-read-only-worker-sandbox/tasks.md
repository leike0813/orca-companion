## 1. 实施前核验

- [ ] 1.1 按 IP-01～IP-05 核验直接前驱 `m2-deliver-execution-tui` 已归档、主规格存在，并重读实际接缝与未提交改动；运行 `openspec list --json`、`openspec list --specs --json` 与 `git status --short`，若漂移则返回规划。

## 2. 只读启动与能力探针

- [ ] 2.1 按 IP-01 共用只读 profile 并移除 `use_legacy_landlock` 启动参数；运行 `pnpm exec vitest run tests/adapters/agents/codex-launch.test.ts` 确认权限配置与启动命令。
- [ ] 2.2 按 IP-01 实现有界、无模型的宿主可写/沙箱读/沙箱拒写/宿主回读探针及三态诊断；运行 `pnpm exec vitest run tests/adapters/agents/codex-read-only-probe.test.ts` 覆盖成功、沙箱失败、超时和意外写入。

## 3. 启动前诊断与授权

- [ ] 3.1 按 IP-02 将独立只读能力检查接到 `doctor`，不扩大 Route Planning 启动门；运行 `pnpm exec vitest run tests/doctor.test.ts` 确认 JSON、退出码与无 TTY 行为。
- [ ] 3.2 按 IP-03 在授权审阅显示 Capsule/Finalizer 的只读配置与探针结论，并在批准前重新检查；运行 `pnpm exec vitest run tests/bootstrap/execution-authorization.test.ts tests/tui/authorization-review.test.tsx` 确认失败不写授权、环境恢复可重审。

## 4. 执行期失败关闭

- [ ] 4.1 按 IP-04 将探针接到 Capsule 新派发前，先核对已有 intent/Task/Dispatch；运行 `pnpm exec vitest run tests/recovery/capsule-dispatch.test.ts` 确认不可用时零新派发、零预算消耗，旧派发按原身份对账。
- [ ] 4.2 按 IP-04 将探针接到 Finalizer 新派发前，保留原报告与工作区核验；运行 `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts` 确认不可用时只有 blocker、没有 deliverable 或重复派发。

## 5. 本机证据与收口

- [ ] 5.1 按 IP-05 更新 `docs/orca-compatibility.md` 的统一只读基线，记录实际版本、探针结果、环境措施与未解除的限制；检查文档不再把 Landlock 写成只读退路。
- [ ] 5.2 按 IP-05 将 `tests/tui/pty-execution.test.ts` 的环境可用路径收紧为真实 Capsule 与 deliverable 必达；运行 `pnpm exec vitest run tests/tui/pty-execution.test.ts` 确认默认无真实开关时仍安全跳过。
- [ ] 5.3 按 IP-05 在获得独立的主机环境修复后先运行 `pnpm build`，再依 implementation-plan §6 的命令，以全新隔离项目和专用身份分别运行真实 Validator Recovery、PTY 中断模式与不中断模式；确认 Capsule 报告、只读 Finalizer、deliverable 与重启不重复派发。环境未修复则保持本任务未完成并记录 blocker。
- [ ] 5.4 按 IP-01～IP-05 运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-repair-read-only-worker-sandbox --strict`，并核对没有修改上游、系统挂载或用户已有改动。
