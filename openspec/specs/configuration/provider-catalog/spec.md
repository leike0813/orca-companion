# configuration/provider-catalog Specification

## Purpose

定义 Coordinator Provider 预设、随发布固定的基础模型目录、公共目录更新与连接端点发现的来源权威和回退边界，使操作者获得可搜索的模型候选，同时避免目录刷新改动既有会话绑定或冒充模型能力核验。

## Requirements

### Requirement: Versioned broad provider catalog

系统 SHALL 随发布提供固定版本的主要 API Key Provider catalog，并支持运行时公共目录更新；预设 SHALL 清晰区分地区、产品线与协议。自定义连接 SHALL 支持 OpenAI Chat、OpenAI Responses、Anthropic Messages，MUST NOT 静默换协议。必要集成 SHALL 随应用提供，MUST NOT 要求用户输入模块导出或安装 SDK。

#### Scenario: 离线基础目录与自定义协议

- **WHEN** 网络不可用或用户配置自定义端点
- **THEN** 基础目录仍可搜索，自定义端点使用明确选定协议及原样模型 ID，不根据地址猜供应商

### Requirement: Endpoint discovery owns candidates

有发现服务时，有效非空发现结果 SHALL 是候选列表的唯一真源；失败或空结果 SHALL 按 last known good、catalog 顺序回退。无发现服务 SHALL 使用 catalog。last known good SHALL 绑定连接版本、凭据引用与有效 catalog 版本；下一次 catalog 内容更新 MUST 使其失效，内容未变的刷新 MUST NOT 使其失效。metadata SHALL 只从可信精确匹配来源取得，未知窗口及 effort MUST 保持未知。

#### Scenario: 发现结果不与目录合并

- **WHEN** 端点发现有效非空列表且 catalog 含额外模型
- **THEN** 候选只包含发现模型，目录不得增加其它 ID

#### Scenario: 失败回退与版本更新

- **WHEN** 发现报错或为空
- **THEN** 使用同连接同 catalog 版本的 last known good，否则使用 catalog；更新 catalog 后旧 last known good 不再使用

### Requirement: Explicit bounded refresh and manual model selection

保存新连接 SHALL 发起首次发现；打开模型选择 SHALL 立即提供已有候选并后台刷新过期数据，且提供显式刷新。查询 SHALL 有界、可取消，失败保留已有展示与输入，迟到结果 MUST NOT 改变其它连接、Session 或选择。render/resize/remount MUST NOT 发起网络副作用。手填 exact ID SHALL 可保存为未验证模型，MUST NOT 猜测能力。

#### Scenario: 后台刷新与手填

- **WHEN** 用户进入选择页后刷新失败或切换页面
- **THEN** 原输入及焦点保留；可手填模型，迟到结果不能替用户选择或应用