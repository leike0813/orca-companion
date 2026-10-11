## ADDED Requirements

### Requirement: Immediate pending submission presentation
完整提交快照落盘后 SHALL 立即从 composer 分离原草稿并在 transcript 标记待受理正文，允许编辑下一条但原 lane 未结清前不再次发送。accepted SHALL 按稳定 submissionId 去重；拒绝/unknown SHALL 保留原快照供显式恢复，MUST NOT 覆盖后来输入。回答 SHALL 保留原 interaction/revision。
#### Scenario: 延迟受理继续编辑
- **WHEN** 用户发送消息且应用受理延迟，立即编辑下一条
- **THEN** 原文作为待受理消息可见，composer 只含新草稿，旧结果不清空它且不产生第二次发送
#### Scenario: 快照写失败与未知
- **WHEN** 保存快照失败或已保存提交返回 unknown
- **THEN** 保存失败不发送且保留原草稿，unknown 保留原身份与快照等待核验而不重发

