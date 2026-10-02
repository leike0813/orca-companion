## Purpose
定义 Coordinator 在两种协调模式下向当前 Session 提出真实问题的有界工具合同，以持久化事实绑定问题正文、选项和回答身份，使响应丢失后的重放仍可核验并保护用户输入。

## ADDED Requirements

### Requirement: 可信身份与可重放用户提问
`ask_user` SHALL 在两种模式与恢复工具注册表可用，每次接受一个非空问题及至多八个唯一非空标签选项，允许自由回答；总文字 SHALL 不超过既有消息上限。Scope、owner、subject 和稳定 InteractionId SHALL 来自可信运行时及已持久化 operation identity。相同 operation 同载荷 SHALL 返回同一问题，异载荷 SHALL 拒绝冲突。问题 SHALL 持久保存并回读后才返回或发布事件，创建 SHALL NOT 自动 suspend 或停止 Worker。

#### Scenario: 响应丢失后重放
- **WHEN** 提问已保存但工具响应丢失后以原 operation 重放
- **THEN** 同载荷返回原问题，不新建问题；不同载荷拒绝冲突

#### Scenario: 无效选项拒绝
- **WHEN** 输入超过八个选项、重复标签、空问题或总量越界
- **THEN** 工具拒绝且不创建问题

### Requirement: 有界问题读取
Branch Coordination Store SHALL 拥有问题正文和选项。当前 Session 列表 SHALL 按稳定 keyset 分页、每页至多二十条；详情 SHALL 精确按 Scope、Session 和 InteractionId 读取。Scope snapshot 与 CLI SHALL 仅投影摘要身份，SHALL NOT 为一个详情读取全库问题载荷。

#### Scenario: 页面与精确详情
- **WHEN** 当前 Session 有超过二十个待答问题并读取下一页或一个详情
- **THEN** 页有界且无重复，详情只返回绑定身份的问题，不泄漏其他 Session 的内容
