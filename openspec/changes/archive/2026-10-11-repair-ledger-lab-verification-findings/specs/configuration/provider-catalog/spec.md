## ADDED Requirements

### Requirement: Distinct manual model input
模型搜索与手填 exact ID SHALL 有独立状态；手填 Enter SHALL 进入元数据确认或保存，不发起目录查询。Coordinator 菜单 SHALL 使用定稿候选、独立横向 effort、区域焦点和明确返回。
#### Scenario: 手填未收录模型
- **WHEN** 用户进入手填状态输入 vendor/exact-model-id 并按 Enter
- **THEN** 可完成声明和保存，不因目录无匹配而丢弃输入或重新发现

