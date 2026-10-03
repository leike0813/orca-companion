# Verification

## 验收对象

- Change：`paginate-coordinator-history`，#37/#46 的第三批 3A。
- 输入实现 HEAD：`8af15029d22ba364985abcf2cb8edbf30cc85bf2` 加 [固定实现补丁](../../../artifacts/coordinator-history/implementation.diff)。
- 最终验收 HEAD：同上；未提交，未归档。用户已有交接报告归档移动排除在验收补丁外。
- 验收 Agent：主代理 Codex（已结束 apply，核验固定检查点）；独立只读审计 Kuhn（继承主代理模型，`01a0ffd3-d418-71e0-b730-9874611d88cf`）。
- 日期/环境：2026-10-03，Ubuntu、Node v24.12.0、pnpm 11.10.0。

## 结论

**PASS**，限当前 3A 的权威增量历史、独立有效上下文、精确恢复及正式 TUI 的全部原文分页。3B 的虚拟视窗/缓存/Markdown/流式与输入/缓存导航 p95 不在本次结论内。

| 维度 | 结果 |
| --- | --- |
| 完整性 | 6/6 tasks、4/4 IP、3/3 Requirements |
| 正确性 | 8/8 Scenarios 有实现与行为证据，范围内缺陷已修复 |
| 一致性 | D-01–04 与 IC-04/11/12 一致；IC-13、Scope 控制与定稿布局保留 |
| 必要审计 | HIST-INCREMENTAL、HIST-ATOMIC、HIST-UI 完成，无待处理项 |

CRITICAL：无。WARNING：无。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| Incremental authoritative conversation records / 长历史中追加与核验 / IP-01/02/04 | `history.ts`、`checkpoint-store.ts`、`submission-status.ts`、宿主按目的读取；checkpoint 十万条记录与双连接测试、正式宿主 301 条分页；[真实存储计量](../../../artifacts/coordinator-history/storage-measurements.json) | 普通写入与核验不读改写整体历史；三档 metadata 均 100 条且低于 64KiB；新增正文只保存一份 |
| 同 Requirement / 原子提交失败与重放 / IP-01/02/04 | checkpoint 的响应不匹配回滚、重复身份/异载荷、用户+Wake 原子提交；既有 user-message/wake-admission 测试 | 不留下半条正文或 Wake；原身份重放、实际持久 Wake 回读与跨库补齐保留 |
| 同 Requirement / 精确工具恢复 / IP-01/02/04 | `tool-node.ts`、`loadCheckpoint('tools')`、配对调用；既有 coordinator-tool-loop、runtime、unknown 恢复测试 | 最后 step/结果精确读取，不换 call/operation 身份，不重办已配对工具；工具行数有预算 |
| Effective context without historical rescans / 压缩后继续对话 / IP-01/02/04 | 压缩区间 SQL 索引排除、控制字段独立更新；损坏已替换旧正文仍可读取当前 context/tools；穿插消息与迟到结果用例 | 模型输入只读有效原文与产物；Capsule 总结全部替换片段，覆盖序号固定，后续同 step 结果保留 |
| 同 Requirement / 上下文读取无法安全完成 / IP-01/02/04 | 4MiB/4096 条独立预算、长度先验检查；超限原文仍分页可读；宿主读取与产物保存失败进入 blocked | 不静默截断，不生成伪造模型输入，不创建替代 Session |
| Authoritative history paging and full original text / 全历史与巨大正文 / IP-03/04 | UTF-8 巨型正文完整重建；正式 reader/host 超过原 200 条窗口；[45 对真实 PTY](../../../artifacts/coordinator-history/README.md#原型与-pty) | 正文范围和页有界，全部原文可逐页读取；向新跨页显示页首，向旧显示页尾；草稿/光标与 continuous 层级保留 |
| 同 Requirement / 游标稳定与最早直达 / IP-03/04 | append/Capsule 后旧 cursor 测试、oldest 索引读取；三档 Ctrl+Home/End | Session 绑定的稳定 sequence/byte offset，不使用深 OFFSET，不走中间页到起点 |
| 同 Requirement / 失败与切会话 / IP-03/04 | `workspace.test.tsx` 失败/事件保留、request generation、实际 Session Picker 切换后的迟到响应；no-side-effect 回归 | 保留旧页与草稿，显式失败可重读，迟到内容不覆盖新 Session，不触发业务动作 |

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 通过 |
| `pnpm test --maxWorkers=8` | 145 文件/1392 项通过；6 文件/12 项条件跳过，含 IP-01/02 的 storage/application/workflow/bootstrap 指定集合 |
| `pnpm exec vitest run tests/tui --maxWorkers=8` | 最后翻页修复后 27 文件/184 项通过；2 条件跳过 |
| `node artifacts/coordinator-history/measure.mjs` | 1,000/10,000/100,000 条真实文件 SQLite 计量完成；当前有效原文各 1 条，新增正文各 1 块/9 字节 |
| `node artifacts/coordinator-history/capture.mjs` | 三档彩色/NO_COLOR、跨页和 resize 共 45 对；每张原生 cursor 可见，返回后“首中尾”保留位置 |
| `openspec validate paginate-coordinator-history --strict`、`git diff --check` | 通过 |
| `git apply --reverse --check artifacts/coordinator-history/implementation.diff` | 只读校验通过，固定补丁与最终工作区一致 |

原型由主代理实际读取定稿源码、80×24/50×40 continuous 画面并对照正式 PTY，包含角色标记/色边/留白、工具层级、composer/sidebar 和 Esc 返回；自动检查不替代画面对照。[证据 README](../../../artifacts/coordinator-history/README.md) 保存操作、截图、计量来源及限制。

验收阶段没有新增产品修改。实施及限定审计阶段已修复穿插压缩边界、冻结 Capsule 覆盖范围、工具恢复/metadata 预算、原 Wake 回读、交接与原生迁移保留全部记录、安全读取/产物落盘失败传递，以及向新跨页跳到页尾的问题；随后复验必要测试与 PTY。没有变更依赖、权限、Scope 状态机或已批准原型。

## 限定审计

[audit.md](../../../artifacts/coordinator-history/audit.md) 记录实际发现、根因、修复与独立终审。Kuhn 复核固定 HEAD+补丁，确认其与已终审代码一致；生产日常调用均声明读取目的，仅新 Session 初始化提供单条 `saveCheckpoint`，没有生产完整历史扫描。原子提交/恢复身份与 TUI 失败/迟到/页首尾边界均闭合，无必要审计待处理。

IC-04/11/12、架构、AGENTS 的合同指针与 [TUI 交接](../../../docs/dev/tui-implementation-handoff.md) 已更新，前驱归档链接/基线已校正。delta specs 暂留 active change，尚未 sync/archive。

## 后续注意事项

- 下一批 3B：局部视窗、内容锚点/有界缓存、Markdown/流式与 #53 输入/缓存导航 p95；单次存储计量不代表这些目标已通过。
- 首版 checkpoint schema 2 拒绝并保留旧整体格式，不提供旧库搬迁。首次交接的有限 migration 读取超限会明确拒绝。
- 将来扩展 Capsule 再压缩时应重新评估相同 step 端点的产物身份；当前生产路径不会产生该身份碰撞，异载荷仍明确拒绝。
- 条件跳过不是通过；没有启用真实 Orca/provider 验收，没有新增人工 IME 预编辑证据；平台结论限当前 Ubuntu，Windows 未验证。
