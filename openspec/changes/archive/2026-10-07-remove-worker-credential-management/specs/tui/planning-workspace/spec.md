## MODIFIED Requirements

### Requirement: Approved role model settings and independent effort

模型页 SHALL 沿 #52 定稿分为当前 Coordinator、Planning 和 Execution 角色区。Coordinator 组 SHALL 保留既有 connection/model/options/key 编辑合同；每个 Worker 角色 SHALL 显式选择已注册 harness 与来自该 harness 原生目录的 provider/model 候选，effort 使用独立水平选择且只展示可信能力来源。Worker 角色 MUST NOT 出现连接、凭据、API key 或任意 options 编辑；未实现角色、未注册 harness 或缺少能力 SHALL 显示原因。目录查询失败时 SHALL 允许手填 native exact ID 并标记为未验证，MUST NOT 提供或保存虚构 effort。默认动作 SHALL 返回，明确应用才提交；保存和应用结果 SHALL 区分，失败保留编辑，迟到结果不改变其他 Session 或焦点。

#### Scenario: effort 不复制候选

- **WHEN** 用户浏览同一模型不同 effort
- **THEN** 候选只有一个 provider/model 条目，水平选择只允许来源证明的值，缺失能力不可保存虚构 effort

#### Scenario: 角色配置编辑与返回

- **WHEN** 用户从 Palette 或 slash 进入角色模型、编辑候选、保存或逐层返回
- **THEN** 原查询/选择/Session/草稿/锚点保留，保存不代表应用，秘密不进入普通输入恢复

#### Scenario: 执行模型更新审阅

- **WHEN** 用户在 execution_coordination 应用角色模型候选
- **THEN** 展示完整新 Manifest 并默认返回，仅明确批准后应用，失效审阅和不可用角色有明确原因

#### Scenario: 逐角色 harness 与原生连接编辑

- **WHEN** 用户为某角色选择 harness 并查看其候选模型
- **THEN** 只出现该 harness 的原生目录候选与 effort 选择，不出现连接、凭据、API key 或任意 options 字段，未注册 harness 不可保存，保存后执行绑定在重新批准前保持不变

#### Scenario: 三档生产画面对照

- **WHEN** 验收模型选择、harness 选择、effort、编辑、保存与重新授权
- **THEN** 六票有120×40/80×24/50×40、彩色/NO_COLOR、Nerd/ASCII生产画面对照，中文/resize/返回符合原定稿，旧证据不被覆盖
