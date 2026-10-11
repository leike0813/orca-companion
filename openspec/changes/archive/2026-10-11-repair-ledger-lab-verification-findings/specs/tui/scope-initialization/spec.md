## ADDED Requirements

### Requirement: Actual asynchronous initialization feedback
创建 Route Map 与最终保存/核验/初始化 SHALL 显示实际在途 spinner 和阶段，错误保留入口及输入；进入新 Session SHALL 可显示空历史。
#### Scenario: 延迟创建和初始化
- **WHEN** 创建地图或最终确认操作延迟返回
- **THEN** 在途状态持续可见，完成后停止 spinner，失败不显示成功或丢失选择

