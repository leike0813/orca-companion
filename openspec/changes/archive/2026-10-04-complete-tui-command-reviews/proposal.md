## Why

#46 第六批的命令目录尚无完整搜索，调用结果和返回位置也未统一：slash 在拒绝或未知结果后仍清空输入，交接按首个待审阅记录取对象。用户已确认拆为连续 6A/6B，本 change 先交付现有命令与审阅闭环。

## What Changes

- 统一命令描述、固定快捷键、帮助、候选及 handlers，加入独立、有界目录/子页搜索。
- 将调用结果区分为打开界面、accepted、rejected 和 unknown，保护原目标、输入与返回位置，连按不重复提交。
- 授权和交接消费应用层语义栏目；精确提案 ID、审阅 revision 和结果引用贯通生产宿主。
- 现有 Coordinator 模型目录明确 Session 绑定；provider/effort/Worker Profile 新能力归直接后继 6B。
- 修正交接文档中第五批未归档的过期记录，采集生产画面并按既有定稿验收。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tui/planning-workspace`：同源命令目录、独立搜索、精确反馈及返回。
- `tui/session-interactions`：模型和交接子页的目标绑定、精确审阅与旧结果保护。
- `tui/execution-control`：控制入口一致、重复调用与待核验反馈。

## Impact

直接前驱为已归档的 `link-tui-pending-interactions`，predecessor-contract 基线 `abf8f0c`。扩展 MOD-06、IC-11/12，消费 IC-13，涉及 TUI、Application DTO/审阅用例、Bootstrap 接线及现有行为/PTY 测试。沿用 #45/#52 及六票定稿；不重新设计、不改 Worker 派发配置、不增加依赖、迁移、Orca 私有接口或第二份持久命令状态机。第七批负责用户级展示偏好与 statusline custom。
