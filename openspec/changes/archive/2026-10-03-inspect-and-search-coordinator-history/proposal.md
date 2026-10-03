## Why

3B 已归档并提供有界阅读与流式预览，但生产时间线还没有跨页活动关联、调用参数详情、全历史搜索及普通发送历史。第四批消费同一权威历史，补齐日常审查和输入召回。

## What Changes

- 以可信 step/call 身份关联查询活动、变更动作与结果，局部展开和整体详细并存。
- 提供有界参数/结果详情及固定上界的独立字面搜索，命中定位到原文，退出恢复阅读状态。
- 当前 Session 普通消息的↑↓召回与 Ctrl+R 搜索，采用与发送分离，保护原完整草稿。
- 登记结构化 unknown 观测，区分未加载、读取失败、未确认与确实缺失；不改工具执行/恢复语义。
- 保留原型，完成真实生产接线、性能与 PTY 证据，并修正3B交接的提交/归档状态。

## Capabilities

### New Capabilities

无，扩展既有规格。

### Modified Capabilities

- `tui/planning-workspace`：语义活动、按需详情及独立搜索。
- `tui/input-protection`：权威普通发送历史召回/搜索与草稿返回。
- `coordinator/session-runtime`：有界调用详情读取与可信未确定观测。

## Impact

直接前驱 `render-bounded-transcript` 已归档，基线 `20f02996471adb3efca524faced20ef9ffa0136d`。扩展 IC-04/11/12；IC-13 的持久输入、CAS、submissionId 与回答隔离保持。涉及 storage、application、workflow、Bootstrap 和 TUI，新增依赖为零。

沿 #37/#46 第四批及 #41/#42/#53 最终决议，不重设计六票原型、不建立第二份正文或发送日志、不改变 Worker/模型调度。第五批待答联动、配置及用户偏好不进入本 change；交付不提交或归档，不提前创建 verification。
