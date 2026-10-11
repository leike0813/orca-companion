## ADDED Requirements

### Requirement: Serialized transcript navigation and regional wheel
阅读导航 SHALL 按输入顺序串行执行；到达最新可见底部立即恢复跟随，短历史无移动上翻保持跟随。切 Session 或退出 SHALL 使旧导航失效，失败保留原视口。SGR 鼠标滚轮 SHALL 只在 transcript 区域每次移动三行，overlay 打开时不导航，协议字节不进入 composer；退出恢复终端鼠标模式。
#### Scenario: 连续翻页及到底
- **WHEN** 用户连续上翻两次后下翻到最新，或对短历史上翻
- **THEN** 两次动作按序保留，到底及短历史保持跟随新消息
#### Scenario: 区域滚轮与覆盖层
- **WHEN** 鼠标在 transcript、composer 或弹窗上滚动
- **THEN** 仅 transcript 且无弹窗时导航，输入正文始终不含鼠标协议

## MODIFIED Requirements

### Requirement: Exact current model context observation
上下文 SHALL 区分当前精确测量与真实上次请求用量。精确观察绑定 Session、configuration 与有效输入版本，接受新消息/tool step、压缩、换模型或版本不匹配 SHALL 失效。缺少精确能力时 MAY 显示明确标注上次请求的真实 usage 与配置来源窗口；新输入使它成为历史观察，换模型使其失效。MUST NOT 以估算、累计 usage 或项目预算冒充当前用量或模型窗口；snapshot/render/resize MUST NOT 触发测量。

#### Scenario: Available exact integration and stale observation
- **WHEN** integration 提供精确当前输入测量与窗口后，用户接受新消息、压缩或切换模型
- **THEN** 精确读数仅用于原绑定，输入改变后失效；有同配置真实 usage 时明确显示上次请求，否则不可用，迟到结果不覆盖新绑定

#### Scenario: Missing exact capability
- **WHEN** integration 只有近似 tokenizer 或累计 usage
- **THEN** 状态栏显示上下文不可用，不以估算数或零填充

#### Scenario: Real last request usage
- **WHEN** integration 无当前精确测量，但存在同配置最新已提交请求 usage
- **THEN** 状态栏标注上次请求，使用声明窗口或仅展示真实 tokens，不将未发送输入或累计轮次加入该数值


