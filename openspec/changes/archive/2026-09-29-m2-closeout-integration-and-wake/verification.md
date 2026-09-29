# Verification

## 验收对象

- Change：`m2-closeout-integration-and-wake`；直接前驱为已归档的 `2026-09-29-m2-deliver-execution-tui`。
- 输入实现 HEAD：`013c83047247a1dcde3b1e7ce2a6aabc8d51932a`。
- 最终验收 HEAD：`013c83047247a1dcde3b1e7ce2a6aabc8d51932a`；本 change 的实现与验收文件保留为该 HEAD 上的未提交工作区改动。
- 验收 Agent：Codex；日期：2026-09-29。

## 结论

**PASS（限本 change 的持久集成完成判定、执行投影与图补丁消息消费）。** 6/6 任务完成；三项 Requirement、六个 Scenario 均有实现与回归证据；D1–D4 与 IP-01–IP-04 一致。没有待修的范围内缺陷或待做的限定审计。本结论结合已归档 M2 的真实 PTY 证据；本轮没有重新运行真实 Orca/PTY 闭环。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| 完整集成以获批目标的推送结算为界；commit 后中断、推送结算完成；IP-01 | `completedIntegrationRef` 按当前 Scope/Graph Generation/Work Package 的 push OperationId、目标和 settled/accepted 判定；`tests/application/integrate-work-package.test.ts` 覆盖已结算 commit 后只读回该步并继续 merge/push；`tests/bootstrap/execution-finalizer.test.ts` 用生产稳定 ID 证明完整 push 后才派发 Finalizer | 13/13、9/9 通过；commit/merge 不提前完成，已完成步骤不重新 mutation |
| 集成投影与执行完成事实一致；部分集成、完整集成；IP-02 | `deriveExecutionFacts` 与宿主共用 `completedIntegrationRef`；`tests/application/execution-view.test.ts` 覆盖 0/1/2 步、拒绝 push、完整 push 与依赖 Frontier；`tests/tui/status-json.test.ts` 覆盖共用只读 CLI 投影 | 部分步骤维持 `waiting_integration` 且依赖等待；完整 push 为 `accepted` 且依赖可准入；CLI 无 TTY 只读测试通过 |
| 已受理的单次图补丁声明只处理一次；受理后中断、拒绝或未知；IP-03 | `createToolsNode` 在 `ok` 工具结果同一 checkpoint 写入 `completedWorkSource` 并结束当前工作；`pendingWorkFromHistory` 由提交历史重建队列；`tests/workflow/coordinator-tool-loop.test.ts`、`tests/application/actionable-work.test.ts`、`tests/domain/coordinator-session-state.test.ts` 覆盖成功、拒绝、未落盘、精确源移除和字段角色校验 | 定向测试通过；unknown 沿原未配对 call 的既有阻塞路径，不写完成标记 |
| 合同、文档与门禁；IP-04 | `docs/interface-contracts.md` IC-03/04/08、`README.md`；`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate m2-closeout-integration-and-wake --strict`、`git diff --check` | 全部 exit 0。最终全量测试 139 files passed / 6 skipped，1268 passed / 12 skipped；commit 续跑定向测试 13/13 通过，typecheck/lint 再次通过 |

验收期间修复了两处原有产品判定：任意 accepted Git 步骤被读成完整集成、正常集成成果在 Sidebar/CLI 中仍显示等待；并消除了受理图补丁后同一用户声明的重复提交。checkpoint 解析器也收紧为只有 tool 结果可携带消费标记。首次全量测试的 9 个 Finalizer 失败来自旧测试夹具使用任意 push ID；改用生产派生函数后该文件 9/9 通过，最终全量测试无失败。新增 commit 续跑测试最初把 HEAD 回读误算成 mutation，修正断言后通过；生产逻辑未因此更改。

## 限定审计

- 审计范围：当前图世代和包的 push 才放行 Finalizer；工具结果落盘前不得消费用户消息；CLI `status --json` 保持只读与无 TTY 可运行。
- 结论：通过。`completedIntegrationRef` 的精确 ID 判定、工具节点的 checkpoint 写入顺序、Session parser、`pendingWorkFromHistory`、共用执行投影与上述定向/全量测试互相吻合；未发现第二份集成状态或新增持久化表。

## 后续注意事项

- 真实执行运行时测试需一次性隔离项目和专用 Orca 身份；本轮未提供该环境，该测试文件按设计跳过。新修复的真实 PTY 复核仍可在下次隔离验收中补做。
- 已归档 M2 验收中「重启先显示 reconciling」画面场景仍是跳过项；本 change 不改变该画面的行为。
- 本轮未提交或归档 change；归档前应以最终工作区再次核对验收记录。
