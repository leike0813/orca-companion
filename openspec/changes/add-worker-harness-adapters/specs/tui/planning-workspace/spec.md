## MODIFIED Requirements

### Requirement: Approved role model settings and independent effort

模型页 SHALL 沿 #52 定稿分为当前 Coordinator、Planning 和 Execution 角色区，并 SHALL 允许每个 Worker 角色显式选择 harness 与 provider/model 候选。候选 SHALL 只展示已注册 harness 的 provider/model，effort 使用独立水平选择且展示可信能力来源；未实现角色、未注册 harness 或缺少能力 SHALL 显示原因。原生连接编辑 SHALL 按所选 harness 只显示适用字段（providerId/baseUrl/api 的适用子集），key 始终遮罩。默认动作 SHALL 返回，明确应用才提交；配置编辑 SHALL 支持 provider/model/options/key。保存和应用结果 SHALL 区分，失败保留编辑，迟到结果不改变其他 Session 或焦点。

#### Scenario: effort 不复制候选

- **WHEN** 用户浏览同一模型不同 effort
- **THEN** 候选只有一个 provider/model 条目，水平选择只允许来源证明的值，缺失能力不可保存虚构 effort

#### Scenario: 角色配置编辑与返回

- **WHEN** 用户从 Palette 或 slash 进入角色模型、编辑连接、保存或逐层返回
- **THEN** 原查询/选择/Session/草稿/锚点保留，保存不代表应用，秘密不进入普通输入恢复

#### Scenario: 执行模型更新审阅

- **WHEN** 用户在 execution_coordination 应用角色模型候选
- **THEN** 展示完整新 Manifest 并默认返回，仅明确批准后应用，失效审阅和不可用角色有明确原因

#### Scenario: 逐角色 harness 与原生连接编辑

- **WHEN** 用户为某角色选择 harness 并编辑其原生连接字段
- **THEN** 只出现该 harness 适用字段，未注册 harness 不可保存，保存后执行绑定在重新批准前保持不变

#### Scenario: 三档生产画面对照

- **WHEN** 验收模型选择、harness 选择、effort、编辑、保存与重新授权
- **THEN** 六票有120×40/80×24/50×40、彩色/NO_COLOR、Nerd/ASCII生产画面对照，中文/resize/返回符合原定稿，旧证据不被覆盖
