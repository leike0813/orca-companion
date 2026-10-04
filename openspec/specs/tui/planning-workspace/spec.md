# tui/planning-workspace Specification

## Purpose
定义 Route Planning 前台工作区的常驻主视图、响应式辅助栏、信息分层与终端渲染保真要求。

## Requirements

### Requirement: 常驻 transcript 与 composer 主视图

主视图 SHALL 固定包含顶栏、Coordinator transcript、composer 与状态行，默认对话工作区在任何宽度下 SHALL 保留 transcript 与 composer；用户显式打开窄屏项目面板或全屏图检查时可暂时使用主区域，关闭后 MUST 恢复原会话、焦点、阅读位置与完整草稿。Transcript SHALL 只展示用户消息、Agent 回复与默认折叠的工具调用记录。composer SHALL 支持多行输入与提交流式回复，并 SHALL 严格区分命令与消息：以 `/` 开头的输入 MUST NOT 作为普通消息或回答发送；无法识别或格式错误的命令 SHALL 保留输入并给出结构化提示，MUST NOT 回退为发送。粘贴 SHALL 只把正文插入 composer 并立即保存，MUST NOT 触发发送或命令。系统 SHALL 提供 `Ctrl+P` Command Palette、`Ctrl+B` 开合项目面板、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭 overlay 与 `Ctrl+C` 退出；Pause、Resume、Cancel、Session Picker、项目面板最近事件与 Help SHALL 通过 Command Palette 暴露。composer 聚焦时普通字符 MUST NOT 触发全局命令，且系统 MUST NOT 提供用户自定义键位。

#### Scenario: 窄屏下主视图保持可见
- **WHEN** 终端宽度收窄到 Sidebar 无法并排显示的尺寸
- **THEN** Sidebar 折叠，transcript 与 composer 仍完整可见并可继续输入

#### Scenario: 工具调用默认折叠
- **WHEN** Coordinator 在一次回复中调用受控工具
- **THEN** transcript 显示该工具调用的折叠记录，展开后才显示细节

#### Scenario: composer 聚焦时普通字符不触发全局命令
- **WHEN** composer 处于聚焦状态，用户键入普通字符
- **THEN** 字符进入 composer 内容，不触发任何全局命令或 overlay

#### Scenario: Esc 逐层关闭
- **WHEN** 用户在一个 overlay 之上再打开另一个 overlay 后按下 `Esc`
- **THEN** 只有最上层 overlay 关闭，其余界面状态不变

#### Scenario: 未知命令不进入聊天
- **WHEN** 用户在普通消息模式输入以 `/` 开头且无法识别的命令并回车
- **THEN** 系统显示结构化命令提示并保留输入，MUST NOT 把它作为普通消息发送

#### Scenario: 多行命令格式错误保留输入
- **WHEN** 用户输入一个参数或行数不符合要求的多行命令并回车
- **THEN** 系统提示格式错误并保留输入，MUST NOT 发送该内容

#### Scenario: 粘贴只插入不发送
- **WHEN** 用户在 composer 中粘贴多行文本
- **THEN** 文本作为正文插入并立即保存，不触发发送、命令解析或清空输入

### Requirement: 信息分层

顶栏 SHALL 简短显示选中 Session、Scope 模式/控制状态、全局待答及可核验风险；完整身份与引用 SHALL 进入项目详情。Sidebar SHALL 保留当前执行图、阶段、Worker/liveness 与 blocker 摘要；项目面板 SHALL 提供预算/授权、身份、工作记录/依据、待答列表和本次启动的最近事件，总览 MUST NOT 重复 Sidebar 的图与执行摘要。Worker 生命周期、验证、授权、暂停与恢复等语义事件 SHALL 只进入最近事件栏目，MUST NOT 混入对话正文；keepalive、轮询超时、重复事件与无变化对账 MUST NOT 进入用户可见时间线。用户可见故障 SHALL 投影为明确 blocker 或状态。

#### Scenario: 维护噪声不进入用户时间线
- **WHEN** Controller 在 Coordinator Session 挂起期间执行一次保活调用
- **THEN** transcript 与项目面板最近事件均不新增该保活条目

#### Scenario: 语义事件进入 Event Drawer
- **WHEN** 一个 Worker Task 完成验证并被接受
- **THEN** 项目面板最近事件新增对应语义事件，transcript 不被改写，事件仅来自本次启动的有界窗口

### Requirement: 三态 Sidebar 与渲染保真

Sidebar SHALL 保留完整、紧凑与折叠三态，宽度 SHALL 只规定允许的最高密度；状态变化 MUST NOT 强制展开。Ctrl+B SHALL 开合项目面板，MUST NOT 再作为 Sidebar 密度切换键；既有纯展示命令可调整密度。终端过窄时 Sidebar SHALL 折叠，Ctrl+G SHALL 打开有界全屏图检查，关闭恢复原工作区。中文、中英文混排 SHALL 在 resize 后保持正确显示宽度和边框对齐，Graph 标题 SHALL 按显示宽度裁切。动态效果 SHALL 只用于模型 spinner、可信 live 运行节点、短暂状态高亮与一次性 attention。

#### Scenario: resize 后宽字符不失配
- **WHEN** 含中英文混排内容的界面收到窗口尺寸变化
- **THEN** 文本按显示宽度重新换行与裁切，边框保持对齐且无残留字符

#### Scenario: 用户折叠后状态变化不强制展开
- **WHEN** 用户通过纯展示操作将 Sidebar 折叠后出现新的待处理交互
- **THEN** Sidebar 保持折叠，仅出现一次性 attention 标记

#### Scenario: 终端过窄时不遮挡主视图
- **WHEN** 终端收窄且用户尚未显式打开项目面板或图检查
- **THEN** Sidebar 折叠，对话与输入仍可见，新事件不自动打开检查视图

#### Scenario: 窄屏显式检查与返回
- **WHEN** 用户在 80×24 或 50×40 终端按 Ctrl+G 并在检查后按 Esc
- **THEN** 检查视图可浏览所选节点邻域和详情，关闭后恢复原会话、焦点、草稿与阅读位置

### Requirement: 状态与焦点的可辨识视觉层级
前台 TUI SHALL 以一致的高对比样式区分当前焦点、选中项、成功、警告、错误与次要信息。关键状态 MUST 同时以文字或符号表达，MUST NOT 仅靠颜色区分；视觉调整 MUST NOT 改变现有输入、确认和回答绑定的语义。

#### Scenario: 彩色终端中切换选择
- **WHEN** 用户在 Session Picker 或 Model Picker 中移动焦点
- **THEN** 当前焦点具有可辨识的高对比标记，选中项及其状态仍可读

#### Scenario: 无彩色终端中的危险状态
- **WHEN** 终端不显示颜色且界面呈现 blocker 或危险操作确认
- **THEN** 用户仍能通过文字或符号识别状态和待确认动作，且 Enter 不会替代显式确认

### Requirement: 有界完整 composer 编辑
Composer SHALL 按 grapheme 支持任意位置插入、左右移动、上下行移动、Backspace 与 Delete。Home/End 和 Ctrl+A/E SHALL 到当前行首尾。Enter SHALL 提交非空输入，Alt+Enter 与可可靠解析的 Shift+Enter SHALL 换行。可见正文 SHALL 至多占用 min(6, floor(terminalRows/3)) 行、至少一行，光标始终可见；resize SHALL 保留正文光标位置。确认与 overlay SHALL 优先消费键位，未知控制键 SHALL NOT 插入字符。

#### Scenario: 中文与 emoji 中间编辑
- **WHEN** 用户在含中文、组合字符和 emoji 的正文中移动、插入与删除
- **THEN** 完整 grapheme 不被拆开，其他内容保持原样

#### Scenario: 多行与 resize
- **WHEN** 用户编辑长多行文本并缩小终端
- **THEN** 正文光标位置保持，视口有界且显示光标所在行

#### Scenario: 提交与上下文键位
- **WHEN** 用户以 Alt+Enter 换行，随后 Enter 提交，或在 overlay 中按全局键
- **THEN** 换行不发送，非空正文通过既有提交管线发送，overlay 键不穿透到 composer

### Requirement: 定稿 continuous 的当前聊天呈现

当前生产 transcript SHALL 沿用已确认 continuous 原型的视觉结构：用户消息以 `›`、色边和留白突出，助手正文以较弱标记区分，工具默认呈现紧凑折叠记录；MUST NOT 为每条消息重复角色标题或为每个回合添加独立外框。无色环境 SHALL 保留角色与折叠状态的可辨识标记。正文、工具身份和真实结果语义 SHALL 保持不变，MUST NOT 从原型 fixture 补造思路摘要、耗时或成功结果。

#### Scenario: 当前聊天沿用连续时间线
- **WHEN** 当前 Session 展示连续的用户消息、助手正文与工具记录
- **THEN** 界面以定稿标记、色边、留白和紧凑工具行区分内容，没有重复角色标题，原正文与工具展开内容仍可读取

#### Scenario: 原型演示事实不进入生产
- **WHEN** 已确认原型包含模拟思路或工具成功标记，而生产投影没有对应可信事实
- **THEN** 界面只展示生产投影实际提供的内容，不增加演示摘要或成功状态，无色时仍能辨识消息和工具折叠状态

### Requirement: 定稿输入框与完整编辑能力共存

普通聊天与回答 composer SHALL 使用已选 above-input 原型的圆角边框、紧凑模式说明、焦点色和内边距；输入正文 SHALL 使用前驱的完整编辑视窗及真实终端光标，MUST NOT 退化为原型的追加式单行输入或模拟光标。边框和提示 SHALL 纳入可用行列计算，输入视窗 SHALL 保持有界且使光标可见；中文、组合字符与折叠块在 resize 后 SHALL 保留正确显示宽度、全文和输入位置。只读与提交不可用状态 SHALL 明确可见，并保留输入。

#### Scenario: 圆角输入框内编辑中文与粘贴块
- **WHEN** 用户在多行中文草稿或含折叠粘贴块的草稿中移动光标、插入或删除内容
- **THEN** 圆角框与模式说明保持定稿视觉层级，真实光标定位在可见输入位置，完整字符与块载荷不因呈现调整丢失

#### Scenario: 窄屏和提交不可用仍保护输入
- **WHEN** 终端在 120×40、80×24、50×40 间变化，或当前输入变为只读或提交不可用
- **THEN** 输入框边界与文本重新计算且不溢出，可编辑时光标保持可见，不可提交原因明确可读，草稿与原提交身份保持不变

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

### Requirement: 项目待答有界联动
项目待答栏目 SHALL 展示 Scope 的二十条 keyset 页及简短问题预览、所属 Session 与状态，明确提供翻页；精确选题 SHALL 不受首屏限制。栏目、空状态、详情及返回 SHALL 使用定稿固定外框。历史问题展开 SHALL 纳入原 transcript 视口与缓存预算，折叠态 SHALL 只读取有限摘要。render、effect、resize 和事件刷新 SHALL 只查询，不发送回答、恢复模型或派发 Worker。

#### Scenario: 后页跨会话选题
- **WHEN** 用户在窄屏或宽屏项目栏目翻到后页并选择其他 Session 的问题
- **THEN** 精确打开该问题，关闭或完成后恢复原栏目和页面，对话布局保持定稿约定

#### Scenario: 后台状态刷新
- **WHEN** 问题在后台被回答或终端连续 resize
- **THEN** 摘要从权威来源重读，阅读位置与输入保持，刷新本身不产生业务动作

### Requirement: 定稿上方命令候选

Slash 候选 SHALL 位于 composer 上方独立有界列表；Palette、slash、Help 与快捷键 SHALL 复用同一操作身份、说明、目标和可用性定义。方向键 SHALL 浏览候选；Tab/Enter SHALL 先采用可用高亮别名，随后 Enter 才调用既有 handler，采用 MUST NOT 产生业务动作。不可用项 SHALL 显示原因且不可采用/执行。Esc SHALL 只收起候选；以 slash 开头的输入在聊天与回答中 MUST NOT 回退为正文。粘贴、历史回填与 IME 确认 MUST NOT 自动采用、执行或发送。project/events 入口 SHALL 指向同一个项目面板及页签，缺少功能的子项 MUST NOT 伪造可执行能力。

#### Scenario: 采用与执行分开
- **WHEN** 用户输入命令前缀，按 Enter 采用高亮项，再明确按 Enter
- **THEN** 第一次只填入别名且没有业务动作，第二次调用原操作，危险操作仍须原确认

#### Scenario: 回答中错误命令不提交答案
- **WHEN** 回答 composer 输入未知或不可用 slash，或收到粘贴/IME 确认
- **THEN** 错误输入和精确问题绑定保留，不作为答案发送，不自动执行或采用候选

### Requirement: 定稿临时弹窗与明确返回

现有会话/选择、命令、模型及审阅/确认界面 SHALL 沿用 dialog final 的固定框、身份摘要、分区、有界正文和反色选中动作，无色仍有文字/符号标记。命令 SHALL 采用左名称/右短说明；审阅默认返回，审阅/确认期间 Ctrl+P/B/G MUST NOT 穿透，Ctrl+C SHALL 沿原退出流程；批准/交接/危险确认 SHALL 保留原权限、指纹、revision 和目标核验。Esc SHALL 逐层返回并保留调用位置、会话、草稿、光标、滚动及项目栏目。缺少 provider/effort/角色能力 MUST 明示不可用，不提供虚构可保存选择。

#### Scenario: 审阅取消和确认保留原合同
- **WHEN** 用户打开授权或交接审阅后返回，或明确选择确认
- **THEN** 返回不产生业务动作并恢复原上下文，确认只提交原合同要求的准确目标、指纹与 revision

#### Scenario: 选择页不伪造模型能力
- **WHEN** 当前 catalog 只有 Coordinator configurationRef/model 而没有 effort 或 Worker 角色配置
- **THEN** 现有配置保持可选择，缺失分区明示未接通，不把原型 fixture 作为选项

### Requirement: 定稿顶栏与单行会话状态

顶栏与 composer 下方 statusline SHALL 沿用 custom-direct 的信息层级和字段配色；statusline SHALL 常驻选中 Coordinator 模型、推理强度状态和可靠上下文状态，以一行为目标并默认包含已建立的图代际/版本。通知与风险 SHALL 独立有界呈现，MUST NOT 替换核心信息；完整 ID/revision/维护详情 SHALL 在项目详情可读。宽度不足 SHALL 先整体省略普通附加字段；缺少可信数据 SHALL 显示不可用，MUST NOT 填零、使用 Worker 模型或以累计 usage 代替当前 context。缺少 custom 偏好持久化合同 MUST 明示，标准布局通过 MUST NOT 记为完整 custom 功能通过。

#### Scenario: 狭窄宽度仍有核心信息
- **WHEN** 用户在三档尺寸中编辑且出现通知或 blocker
- **THEN** 会话核心信息保持常驻，风险可发现，普通附加项先让位，不以第二行执行摘要覆盖输入空间

#### Scenario: 缺失数据和配置不冒充完成
- **WHEN** effort/context 或用户级偏好尚无可信合同
- **THEN** 对应数据与设置显示不可用，模型不取其他 Worker 值，验收记录明确保留这些功能缺口

### Requirement: 生产界面的原型一致性证据

验收 SHALL 覆盖 design.md 登记的六张原型票 #40/#43/#47/#48/#51/#52，并按 #41/#42/#44/#45/#50 最终语义核对现有生产区域。每票 SHALL 有最终决议、源码、定稿样例及实际生产画面的对应记录，检查布局、层级、边框、留白、标记、配色、选中态和焦点/返回。SHALL 覆盖 120×40、80×24、50×40、彩色/NO_COLOR、Nerd/ASCII；自动检查、原型 fixture 或旧局部证据 MUST NOT 代替此次对照。新增证据 SHALL 单独保存，完整历史、跨会话协议、配置/可信数据等未接通部分 SHALL 逐项登记，MUST NOT 将部分呈现通过称为整票全部功能完成。

#### Scenario: 六票生产画面均有参照
- **WHEN** 验收聊天、输入、项目面板、弹窗、顶栏/statusline、Sidebar/Inspector
- **THEN** 六票分别有定稿与三档实际画面的对应结论，旧 54 组局部证据不被扩大成整体通过

#### Scenario: 部分功能尚未接通
- **WHEN** 某票呈现规则已对齐但真实配置、数据或返回协议仍未完成
- **THEN** 报告写明已对齐区域、实际差异与后继 owner/批次，保留未完成状态，原定稿资产不被覆盖

### Requirement: Authoritative history paging and full original text

正式 TUI SHALL 经应用合同读取当前 Session 的完整已提交原文，元数据 keyset 页 SHALL 同时受条数及字节上限约束，正文 SHALL 按 UTF-8 完整字符边界作独立范围读取。新增消息和压缩 MUST NOT 移动旧游标；不得以深 OFFSET 或整体 Session 切片实现。PgUp/PgDn SHALL 浏览正文和历史，Ctrl+Home/Ctrl+End SHALL 有界到起点/最新，Esc 从回看返回最新；composer 草稿不变。工具详情仍默认折叠，完整保留结果可按范围读取。读取失败 SHALL 保留当前视窗并允许重读；切 Session 后迟到结果 MUST NOT 覆盖当前视窗。未加载/失败/缺失/空历史 SHALL 明确区分，读取不得触发业务动作。

#### Scenario: 全历史与巨大正文
- **WHEN** 用户翻阅超过旧 200 条窗口的历史或大于一次正文范围的中文混排消息/工具结果
- **THEN** 全部原文可通过有界页和范围连续读取，字符不丢失，composer 与定稿 continuous 层级保留

#### Scenario: 游标稳定与最早直达
- **WHEN** 取得历史页后新增消息或保存 Capsule，并使用旧游标或跳到起点
- **THEN** 旧边界保持稳定，起点直接取得附近内容，不遍历全部中间页

#### Scenario: 失败与切会话
- **WHEN** 读取失败或上一 Session 的读取在切换后才完成
- **THEN** 原位置与草稿保持，失败明确可重读，迟到内容不会进入新 Session，也不发送消息或恢复模型

### Requirement: Bounded local transcript viewport

Transcript SHALL 仅读取、解析和布局可见范围及有限前后缓冲，正文和布局缓存 SHALL 分别同时受 8 MiB 与 64 项约束，包含固定版本、可变尾部及派生结构。阅读位置 SHALL 绑定稳定来源身份、内容版本与原文位置；历史追加、流式更新、resize、工具展开及 Session 返回 MUST NOT 将阅读位置改为全历史行号。非当前 Session MUST NOT 预热正文；折叠工具 SHALL 只读取元数据。最旧/最新定位 SHALL 直接读取目标附近，不遍历中间正文。

#### Scenario: 长历史与巨型消息
- **WHEN** 用户阅读 1000、10000、100000 条不同记录或 1/5 MiB 的正文和工具输出
- **THEN** 实际布局只覆盖局部，缓存不随总历史增长，输入和已缓存导航 p95 SHALL 不超过 100ms；冷读取和 SDK 聚合成本单独记录

#### Scenario: 固定阅读版本与返回
- **WHEN** 用户回看后后台继续流式更新或完成响应，并调整终端宽度、开合工具或 overlay
- **THEN** 当前来源版本、原文锚点与草稿保持；回到最新才采用最新版本，迟到其他 Session 的读取被忽略

#### Scenario: 缓存与读取失败
- **WHEN** 缓存达到条数/字节上限或正文暂时无法取得
- **THEN** SHALL 先缩小预读和淘汰远处内容，不保留超限整条消息；失败保留当前画面和位置并允许重读

### Requirement: Range-aware Markdown and streaming preview

普通 Markdown SHALL 在有限块内解析并保留原文位置映射；跨范围的已知上下文 SHALL 延续。巨大或不支持的结构、未知中段上下文 SHALL 完整显示原文，MUST NOT 为每个范围伪造独立文档或在每次更新/finish/resize 解析整条响应。流式预览 SHALL 保留稳定前缀与有限可变尾部，合并刷新不得丢字。完成提交 SHALL 以可信身份关联正式原文；中断 SHALL 明确标记未提交。临时预览不具重启恢复权威。

#### Scenario: 跨范围 Markdown 与中文
- **WHEN** 代码围栏、引用或中英文/emoji 混排跨过正文范围，或者出现巨大单行、表格与列表
- **THEN** 已知上下文保持一致，原文不丢失，未知/巨大结构可读原文，处理范围有界

#### Scenario: 真流式完成与中断
- **WHEN** 真实模型多次分片返回、完整提交，或在途中失败/取消
- **THEN** TUI 可阅读实时前缀，完成后关联正式 entry；失败预览不冒充历史，不触发发送、模型恢复、工具执行或最近事件噪声

### Requirement: Semantic activities and retained details

Transcript SHALL 将相邻且语义兼容的只读查询合为探索活动，将变更动作单列；正文或用户消息 SHALL 结束活动组。跨页 SHALL 保持原 call/结果身份和顺序，MUST NOT 将页边界制造为新活动。Ctrl+T SHALL 切整体紧凑/详细，F4 SHALL 进入活动导航，方向键选择、Enter 原位展开/收起，Esc 返回 composer。详情 SHALL 按需读取完整保留参数与结果并保持有界；已知失败和 unknown SHALL 在紧凑态可见，accepted MUST NOT 表示 Worker 完成。

#### Scenario: 跨页查询与变更动作
- **WHEN** 连续查询跨过元数据页，随后发生变更动作或出现正文
- **THEN** 查询仍属于同一活动、调用顺序可审查，变更动作单列且正文结束该组

#### Scenario: 两种详情与失败
- **WHEN** 用户局部展开或切整体详细，并遇到巨大结果、失败或 unknown
- **THEN** composer 保持可见，完整保留内容可局部阅读，紧凑态不隐藏异常，resize 保持原文锚点

#### Scenario: 未加载与缺失
- **WHEN** 关联还在构建、详情未加载、读取失败或确实没有配对结果
- **THEN** 各状态明确区分，读取失败保留原画面并可重试，不猜测执行成功或失败

### Requirement: Independent bounded transcript search

F3 SHALL 打开当前 Session 独立查询，按字面且忽略大小写搜索全部保留已提交消息、参数和结果，包括折叠及未加载内容。搜索 SHALL 固定启动时的已提交历史上界，分批、有界、可取消，不以前置完整布局或全文 Markdown 为条件，不灌满展示缓存。命中 SHALL 映射原文位置并临时展开详情；Enter/Shift+Enter SHALL 切下一个/上一个匹配，Esc SHALL 恢复原阅读锚点、显示模式和手动展开偏好，聊天草稿不变。扫描未完成、失败与无匹配 SHALL 区分；仅查完才报告无匹配。

#### Scenario: 跨块 Unicode 和折叠详情
- **WHEN** 中文、emoji 或大小写折叠匹配位于正文块边界或未加载的工具参数/结果
- **THEN** 通过有限扫描正确命中原文范围，定位只布局附近内容，退出恢复原显示态

#### Scenario: 固定上界与取消
- **WHEN** 搜索中追加消息、改变查询、切 Session 或取消搜索
- **THEN** 本轮不纳入上界之后的记录，旧请求停止推进且迟到结果不覆盖当前界面；聊天草稿与位置保留

#### Scenario: 失败与继续查找
- **WHEN** 一批扫描没有命中但还有历史，或读取失败
- **THEN** 分别显示继续查找或失败/重试，不冒充没有匹配，恢复沿原搜索边界

#### Scenario: 长历史搜索不阻塞输入
- **WHEN** 用户在1000/10000/100000条记录或1/5 MiB详情中搜索
- **THEN** 每批和搜索工作区受限，输入及已缓存导航 p95≤100ms，完整扫描总成本单独记录

### Requirement: 可搜索同源命令目录
Palette、slash、快捷键和帮助 SHALL 共用稳定命令身份、展示定义及同一操作 handler。Palette SHALL 按名称、中文说明、别名和菜单路径字面搜索，支持直达子项；查询 SHALL 独立于 composer，列表 SHALL 有界且不可用项可发现。真实准入 SHALL 在调用前重验。

#### Scenario: 搜索子项与取消
- **WHEN** 用户从含中文与粘贴块的草稿打开 Palette，搜索 ASCII 或状态栏并取消
- **THEN** 匹配子项可直接定位，不可用原因与无匹配区分，原正文、光标、粘贴块及阅读位置保持

#### Scenario: 相同操作的不同入口
- **WHEN** 用户分别从 Palette、slash 和固定快捷键调用同一操作
- **THEN** 目标、真实准入、handler 和原确认路径一致，查询及候选采用不产生业务动作

### Requirement: 命令结果与页面返回绑定
命令 SHALL 区分打开界面、accepted、rejected 与 unknown；accepted MUST NOT 表示业务完成。slash SHALL 只在确定成功且原输入未被后来编辑时结清对应命令输入；失败、unknown、读取或保存失败 SHALL 保留输入。子页返回 SHALL 保留原入口查询、选择、栏目、Session、问题绑定、草稿和来源锚点；迟到结果 MUST NOT 抢焦点或覆盖新输入。

#### Scenario: 拒绝与等待中编辑
- **WHEN** compact 被拒绝或 unknown，或者等待时用户继续编辑并切换 Session
- **THEN** 原输入与结果归属保持，不清新稿、不重新打开旧页、不切换回旧 Session

#### Scenario: 多级搜索返回
- **WHEN** 从 Palette 查询进入 Session 或模型子页，再逐层 Esc
- **THEN** 恢复原搜索及对象选择，最终回原输入/阅读位置，不产生消息或回答提交
