## ADDED Requirements

### Requirement: Debug input identity isolation
调试输入 SHALL 使用独立目录和 Session 身份，复用完整 UiDraft、稳定 submissionId、CAS、冲突、容量与未知提交保护；SHALL NOT 借用虚构 Scope 或回答身份。render、resize、读取恢复和 remount SHALL NOT 自动发送。

#### Scenario: 调试草稿与未知提交恢复
- **WHEN** 调试中编辑含折叠粘贴的多行草稿，或提交结果未知后退出重启
- **THEN** 原正文、光标、粘贴范围与原提交身份可恢复，未知结果仅核验而不自动重发，其他会话输入不变
