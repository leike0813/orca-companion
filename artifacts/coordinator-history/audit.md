# 会话历史限定审计

日期：2026-10-03。基线 `8af15029d22ba364985abcf2cb8edbf30cc85bf2`，最终代码见 [implementation.diff](implementation.diff)。只读代理 Kuhn（继承主代理模型；`01a0ffd3-d418-71e0-b730-9874611d88cf`）核验 HIST-INCREMENTAL、HIST-ATOMIC、HIST-UI；不写文件、不调用 Orca。主代理修复并运行行为检查，结果见 [README](README.md)。

## HIST-INCREMENTAL / HIST-ATOMIC

全部生产 `loadCheckpoint` 调用均声明 metadata/context/tools/pending/migration；仅新 Session 的单条初始化仍可调用 `saveCheckpoint`，没有日常完整历史读改写。entry/正文块/step/Wake 关联提交，追加失败回滚、身份重放不重复、旧工具不重办。有效上下文先通过索引排除压缩区间，再在独立预算内读取；大正文按长度先检查预算。

| 发现 | 根因修复与证据 | 终审 |
| --- | --- | --- |
| 压缩同 step 的穿插消息时，排除区间大于摘要区间 | 摘要覆盖选定时间前缀的全部片段；保留尾部 step 的完整区间；Capsule 固定序号，原载荷重放不移动边界。`context-maintenance` 与 `checkpoint-store` 用例涵盖 S/B/S 和迟到结果 | 闭合 |
| 恢复工具行数与 metadata 数组预算边界 | tools 使用预算+1 行检测；JSON 数组计入方括号和逗号 | 闭合 |
| 用户消息重放返回候选 Wake，Session 校验过晚 | 先校验 Session，再精确读持久 Wake；异载荷拒绝，保留原身份 | 闭合 |
| 首次交接/原生迁移只摘要模型响应 | 有限 migration 原文逐条摘要，包含用户和工具；扩展现有 model-config-switch 用例 | 闭合 |
| 安全读取或压缩产物保存失败没有传到阻塞 | 非 metadata 不可恢复读取、Capsule/native 保存失败抛出，由模型 loop 发布 blocked | 闭合 |

fixture 修正：十万条正文复制使用 Session/entry 复合索引；工具幂等用例先建立真实配对调用；安全预算测试使用 canonical `CONTEXT_READ_BYTES`。没有通过弱化行为断言消除失败。

schema 2 是该 change 的首次交付格式，前驱为 schema 1；中间结构只生成已释放的临时/内存 fixture，无持久中间库，不为实现过程另增格式版本。诊断 `readCommittedMessages(range)` 按当前原始 step 区间读取，生产 Capsule 使用自己冻结的序号，不混用两者。

## HIST-UI

主代理发现向新跨页默认页尾会跳过开头，已让 PgDown 从新页首开始、PgUp 从旧页尾开始；Ctrl+Home 页首、Ctrl+End/Esc 最新。复用现有分页用例验证第 100 条连续出现，三档 PTY 另存跨页画面。

只读代理核对了行数计算与渲染、真实视口高度、request generation、Session 守卫、失败保留、事件提示、Esc 逐层返回及草稿保护；终审未发现可复现的范围内问题。迟到请求用例同时覆盖更新请求和实际 Session Picker 切换。最终 TUI 27 文件/184 项通过，2 条件跳过。

## 后继

将来扩大 Capsule 再压缩能力时，应重新评估相同 step 端点的产物身份；当前生产者不会生成同端点的第二个不同区间，身份冲突仍明确拒绝。此项与 3B 渲染/缓存计划分开记录，不影响本批次。三个必要审计均已完成，无范围内缺陷或必要审计待处理。
