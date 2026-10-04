## ADDED Requirements

### Requirement: Trusted project and selected session presentation
顶栏/状态栏 SHALL 消费应用只读投影的注册 repository/branch、选中 Session 的不可变模型 provider/model/effort、精确 Ticket Claim 及当前 Dispatch Work Package；缺失、未配置、不支持与不可用 SHALL 明确区分。预算 SHALL 按明确类别显示实际主体、持久 consumed 与对应批准上限，MUST NOT 使用第一条 ledger 或累计消耗作为 active package count。statusline SHALL 保持三核心项、单行与默认 graph 附加项，普通字段按配置顺序整体让位、先缩短 provider，Ticket 号保持可辨识。展示偏好 MUST NOT 控制风险、授权或待答事实。

#### Scenario: Session and budget identities
- **WHEN** 用户切换到另一 Session 或 graph/authorization/current attempt 改变
- **THEN** 模型、Claim 和当前工作包准确绑定原事实，预算明确显示对应主体；没有精确来源时显示不可用，不采用别的 Session、Worker 或 ledger 数值

### Requirement: Exact current model context observation
上下文 SHALL 只接受已安装 integration 对完整有效模型输入与 tools 的精确测量及可信模型窗口，并绑定 Session、configuration 与有效输入版本。接受新消息/tool step、压缩、切换模型或版本不匹配 SHALL 失效。缺少精确能力 SHALL 显示不可用；MUST NOT 使用字符估算、通用近似 tokenizer、上一轮或累计 usage、配置读回预算冒充模型窗口。snapshot/render/resize MUST NOT 触发外部测量。

#### Scenario: Available exact integration and stale observation
- **WHEN** integration 提供精确当前输入测量与窗口后，用户接受新消息、压缩或切换模型
- **THEN** 读数先仅用于原绑定，输入改变后显示不可用直到新精确测量，迟到结果不覆盖新绑定

#### Scenario: Missing exact capability
- **WHEN** integration 只有近似 tokenizer 或累计 usage
- **THEN** 状态栏显示上下文不可用，不以估算数或零填充

### Requirement: Version-bound bounded project details
项目详情 SHALL 精确读取所选 Scope/Session/对象及所见 revision，批准后 Manifest SHALL 读取批准引用并与候选区分。每页 SHALL 至多20项及64KiB，长字段以 UTF-8 连续范围读取，并提供后续页；失效或失败 SHALL 保留原入口、展示明确状态并允许重读。>=100列 SHALL 继续使用原 Sidebar 固定框，更窄使用主区域，返回恢复原栏目、选择、滚动和输入。读取 MUST NOT 自动批准、切 Session 或产生模型/Worker动作。

#### Scenario: Approved manifest and long data
- **WHEN** 用户查看批准后授权或长身份/预算详情并连续翻页
- **THEN** 全部字段属于精确批准对象并可通过有界页连续读完，候选不被标为批准，框内浏览且返回原入口

#### Scenario: Version changed during reading
- **WHEN** 所选对象 revision 已改变或旧页面结果迟到
- **THEN** 页面明确失效或失败，旧结果不替换当前对象、焦点或草稿
