## MODIFIED Requirements

### Requirement: 有界问题读取
Branch Coordination Store SHALL 拥有问题正文、选项与回答。当前 Session 和整个 Scope 的待答列表 SHALL 按稳定 keyset 分页、每页至多二十条；详情 SHALL 精确按 Scope、Session 和 InteractionId 读取，不依赖列表首屏。展示 snapshot SHALL 只携带有界摘要和完整 Scope/Session 待答计数；CLI SHALL 仅投影摘要身份。历史关联 SHALL 只查询当前有限调用的指定问题摘要，SHALL NOT 为一个详情或一帧读取全库问题载荷。业务准入 SHALL 使用完整 Scope 待答计数。

#### Scenario: 页面与精确详情
- **WHEN** 当前 Session 有超过二十个待答问题并读取下一页或一个详情
- **THEN** 页有界且无重复，详情只返回绑定身份的问题，不泄漏其他 Session 的内容，后页问题可直接读取

#### Scenario: Scope 分页与完整计数
- **WHEN** 多个 Session 累积大量已答问题及超过二十个待答问题
- **THEN** Scope 列表仅返回一页摘要，计数仍包含所有待答问题，其他 Scope 隔离，Finalizer 不因分页而误判没有待答

## ADDED Requirements

### Requirement: 历史提问与权威回答关联
历史提问 SHALL 以可信持久化操作身份关联唯一问题，问题状态、正文和回答 SHALL 来自问题权威来源。SHALL 区分索引未就绪、读取失败与记录缺失，不解析工具结果文案猜测身份或成功。

#### Scenario: 重放与恢复
- **WHEN** 同一提问重放、历史翻页、压缩或重启后读取原调用
- **THEN** 原位置仍关联同一个问题和回答，其他提交者的回答不被视为当前输入提交成功
