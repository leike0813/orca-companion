## MODIFIED Requirements

### Requirement: Approved role model settings and independent effort

模型页 SHALL 沿 #52 定稿分为当前 Coordinator、Planning 和 Execution 角色区。Coordinator SHALL 提供已有连接复用及 Provider/custom、地区/产品线或地址、隐藏 API Key、保存/发现、模型/可信 effort、核验和明确应用流程；MUST NOT 呈现 module/export、SDK options JSON、认证类型或字段路径。每个 Worker 角色 SHALL 显式选择注册 harness 与原生目录模型，effort 使用独立水平选择且只展示可信来源；Worker MUST NOT 出现连接、凭据、Key 或 options。目录失败 SHALL 允许手填 exact ID 并标记未验证，不捏造 effort。默认动作 SHALL 返回，保存、发现、核验和应用 SHALL 区分；失败保留输入，异步结果不得改变其它 Session 或焦点。

#### Scenario: Coordinator 简洁配置与复用
- **WHEN** 用户新建连接或选已有连接
- **THEN** 新建只需服务/协议、地址及隐藏 Key；已有连接直接选择模型，不要求重复输入 Key 或 SDK JSON

#### Scenario: Worker 原生选择
- **WHEN** 用户配置 Worker 角色
- **THEN** 只选择 harness、native model 与可信 effort，目录失败可以手填未验证 exact ID

#### Scenario: 默认返回与独立应用
- **WHEN** 用户保存、取消、刷新或切 Session
- **THEN** 默认返回和原焦点约定保留，只有明确应用才更新目标绑定，迟到结果不覆盖新编辑

#### Scenario: effort 不复制候选
- **WHEN** 浏览同模型不同 effort
- **THEN** 只有一个模型候选，独立水平选择仅提供可信值

#### Scenario: 角色配置编辑与返回
- **WHEN** 从 Palette/slash 编辑保存或逐层返回
- **THEN** 保留查询、选择、Session、草稿与锚点，保存不代表应用，秘密不进输入恢复

#### Scenario: 执行模型更新审阅
- **WHEN** 在 execution_coordination 应用角色模型
- **THEN** 展示完整新 Manifest，默认返回且明确批准后应用，失效审阅明确拒绝

#### Scenario: 逐角色 harness 与原生连接编辑
- **WHEN** 为 Worker 角色选 harness 并浏览模型
- **THEN** 仅出现其原生模型与可信 effort，执行绑定在重新批准前不变

#### Scenario: 三档生产画面对照
- **WHEN** 验收模型选择、编辑、保存和应用
- **THEN** 提供120×40/80×24/50×40可审阅画面及中文、resize和返回行为证据，不覆盖旧证据；按2026-10-08用户决议接受当前功能，彩色/NO_COLOR、Nerd/ASCII及完整视觉一致性对照留待后续，不计为本轮通过项
