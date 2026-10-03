## MODIFIED Requirements

### Requirement: 固定外框项目面板

项目面板 SHALL 使用总览、待答列表、最近事件三个栏目，总览 SHALL 按需要处理、额度与权限、项目资料分组，以用途标题、操作名称、次要说明三层呈现，并可进入预算/授权、身份及工作记录/依据。终端至少 100 列时 SHALL 使用原 Sidebar 区域，MUST NOT 改变 transcript/composer/statusline 的宽度和位置；更窄时 SHALL 独占主区域并保留全局身份/风险/待答提示。同一尺寸下所有栏目、空状态、列表和详情 SHALL 共用固定外框并在内部有界浏览。最近事件 SHALL 复用本次启动最多 50 条的窗口并标明范围；缺少可信正文或数据的项目 MUST 明示不可用。resize 与新事件 MUST NOT 改变所选对象、栏目、返回层级或抢焦点。

#### Scenario: 宽屏栏目切换不移动对话
- **WHEN** 用户在 120×40 以 Ctrl+B 打开项目面板，切换栏目并打开长详情
- **THEN** 面板位置、宽高不随内容改变，左侧对话和输入保持原位，长内容在框内浏览

#### Scenario: 窄屏关闭恢复工作区
- **WHEN** 用户在 80×24 或 50×40 打开项目面板后关闭
- **THEN** 打开期间主区域只显示该面板且全局风险可见，关闭后原会话、焦点、草稿、光标与阅读位置恢复

#### Scenario: 事件和问题不复制权威
- **WHEN** 用户查看最近事件或另一 Session 的待答摘要
- **THEN** 事件标明本次启动窗口，问题显示真实 owner/state/revision；用户明确选择后读取所属会话正文并建立返回入口，新事件不自动换会话或提交

## ADDED Requirements

### Requirement: 项目待答有界联动
项目待答栏目 SHALL 展示 Scope 的二十条 keyset 页及简短问题预览、所属 Session 与状态，明确提供翻页；精确选题 SHALL 不受首屏限制。栏目、空状态、详情及返回 SHALL 使用定稿固定外框。历史问题展开 SHALL 纳入原 transcript 视口与缓存预算，折叠态 SHALL 只读取有限摘要。render、effect、resize 和事件刷新 SHALL 只查询，不发送回答、恢复模型或派发 Worker。

#### Scenario: 后页跨会话选题
- **WHEN** 用户在窄屏或宽屏项目栏目翻到后页并选择其他 Session 的问题
- **THEN** 精确打开该问题，关闭或完成后恢复原栏目和页面，对话布局保持定稿约定

#### Scenario: 后台状态刷新
- **WHEN** 问题在后台被回答或终端连续 resize
- **THEN** 摘要从权威来源重读，阅读位置与输入保持，刷新本身不产生业务动作
