## Why

第六批模型配置已归档，当前状态栏仍缺可信 effort/context、项目身份和预算上限，custom 与图标偏好尚未恢复。第七批按已确认的 #48 custom-direct、#51 tabs 与 #52 final 补齐合同，不重新设计界面。

## What Changes

- 从应用只读投影提供注册身份、精确 Session 模型/Claim/当前 Work Package、授权及预算，缺少来源明确不可用。
- 用当前合同 Accepted Validator Result 统一全图验收摘要，供状态栏、Sidebar 与 Inspector 复用。
- 接通有界项目详情与批准后 Manifest；精确绑定对象版本，不将候选冒充批准记录。
- 新增用户级 UI 偏好端口、schema/CAS/原子存储，支持 statusline 草稿预览、直接保存、默认恢复及 Nerd/ASCII 跨重启；失败保留编辑和原入口。
- 当前 context 仅接受 installed integration 的精确完整有效输入测量与可信模型窗口，否则显示不可用。

## Capabilities

### New Capabilities

- `configuration/tui-preferences`: 用户级展示偏好、CAS 与失败恢复。

### Modified Capabilities

- `tui/planning-workspace`: 可信顶栏/状态栏 metadata、custom 编辑及有界项目详情。
- `tui/execution-monitoring`: 当前版本全图 Validator 验收摘要。

## Impact

直接前驱为已归档 `2026-10-04-complete-tui-model-configuration`，里程碑为 M2 第七批。影响 Controller/query DTO、store 索引或精确读取、模型构造/前台接线、TUI 组件与用户配置 adapter；不增加依赖。不实现历史图版本、依据全文、provider token fallback、键位自定义或新的调度权限；第八批继续负责历史图与依据有界读取。
