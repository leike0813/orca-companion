# Codex CLI 0.160.0 的长 transcript 机制与本票修正建议

本报告服务于 [裁决长 transcript 的分页、虚拟化与懒加载机制](https://github.com/leike0813/orca-companion/issues/53)。按用户要求核对最新 Codex CLI 后，阅读版本、内存计量、独立搜索和可变尾部限制四项修正已获确认并合入 [最终决议](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)。本报告保留源码研究依据，产品性能验收由后续实施完成。

## 基线与方法

2026-10-02 查询官方 GitHub releases/latest，最新稳定版为 [0.160.0](https://github.com/openai/codex/releases/tag/rust-v0.160.0)，发布时间 2026-10-01T20:19:13Z。解引用 tag `rust-v0.160.0` 得到 commit `a956835d020762cb2b570053af06f643a11c0ecc`。下文源码链接固定此 commit。

下载官方 tag 的源码归档至系统临时目录，按入口追踪真实调用，核对已有源码测试。未安装或升级 Codex，未构建上游，未启动真实用户会话或调用模型。此前 [0.159.3 的研究](./codex-transcript-display-and-interaction.md) 与 PTY 资产仍作为旧版依据；本报告不把它们说成 0.160.0 的复验。

逐文件比较旧研究 commit `01fc69f4026735edfdf6789820549727a4867b11`：新版本的 `transcript_view/layout.rs`、`search.rs`、`snapshot.rs` 和 `app/history_pagination.rs` 与旧版字节完全相同。`transcript_view.rs` 有变化，因此所有结论仍以新快照实际源码为准。官方 [Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 介绍交互和恢复入口，没有证明下述底层读取量或内存上界。

## 视窗有界与整条布局是两个层次

`TranscriptView::render` 从阅读锚点或末尾反向找到视窗起点，只画当前终端区域；`move_rows` 按所需显示行数移动，`near_start` 靠近已加载开头一屏时触发历史需求。它没有为整段历史预先建立总显示高度。这与本票的局部视窗方向一致。[视窗与绘制](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view.rs#L167-L273)、[定位与移动](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view.rs#L480-L615)。

但 `current_layout` 缓存未命中时调用 cell 的完整展示函数，再构造 `TextLayout`；`TextLayout` 持有整条逻辑文本及显示行。只绘制视窗不代表单条长消息的解析、换行与内存也按内容范围受限。[整条布局入口](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout.rs#L116-L193)、[TextLayout 数据与重排](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/text.rs#L43-L89)。

## 缓存：64 项 / 8 MiB 不是总内存硬上限

`LayoutCache` 使用 64 项与 8 MiB 文本长度上限，键包括 cell 所有权、宽度、呈现方式、帧和动画状态；主题/颜色变化会清理缓存。最近访问移到尾部，旧记录淘汰。[缓存与失效](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout.rs#L13-L14)、[get 与 evict](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout.rs#L200-L276)。

关键例外：evict 仅在记录数大于 1 时继续执行，源码明确保留单条超大 layout，避免可见时反复重排。其字节统计只累加 `layout.text().len()`，不包括所有样式、显示行、Arc、snapshot 或正文对象。这是缓存策略，不是进程 RSS 或全量布局占用的证明。同文件的测试验证最近项复用、旧项淘汰；未提供十万条历史或超大单条的内存/延迟验收。[缓存测试](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout_tests.rs#L93-L139)。

App 将分页结果转为 cells 后前插到 `transcript_cells`，本条路径未淘汰远处已加载 cells。搜索需要历史时复用同一分页路径，因此局部布局缓存有界不能推导正文保留有界。[页面接线](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app/history_pagination.rs#L98-L124)、[前插与持续加载](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app/history_pagination.rs#L251-L308)。

本票应保留双限方向，明确超大正文按范围提供，不能把“一条完整消息”作为豁免。可见、已固定、解析尾部与搜索工作区也消耗内存；需要将这些计入各自预算或单独报告，不能只给缓存 Map 求和。

## 阅读稳定：身份与位置还需要内容版本

Codex 的锚点为 `EntryKey + offset + row_bias`，EntryKey 是进程内 cell 的 Arc 指针或 Live 标记；index 是定位加速提示，不是身份。[锚点结构](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view.rs#L50-L78)、[resolve](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view.rs#L597-L615)。这支持前插和 reflow，但指针不能直接作为 Companion 跨重新读取的身份。

用户读到 live 或可变 cell 时，Codex 固定当时的显示版本。Snapshot 共享 cells 所有权，固定可见布局及 live 尾部；底层继续接收更新，用户离开后再回到当前历史。resize 对固定版本重新换行。跨页合并活动也保护正在阅读的组，避免摘要变更破坏 offset。[版本固定](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/snapshot.rs#L34-L120)、[活动替换](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/mutations.rs#L28-L130)。

这里的 snapshot 在首次创建时复制已加载 cell 的引用数组，不复制每条正文，但会保留这些对象的所有权。它不是“只保留当前视窗正文”的方案。Companion 可采用版本固定的行为，使用可信 entry/content revision 与局部内容范围实现，避免照搬全历史引用数组。

## 搜索：分批匹配不等于完整链路有界

Codex 的 TUI Find 是逐帧、字面且 Unicode 小写折叠的匹配。查询最多 4096 字节，每帧最多处理 8 个 entries，匹配窗口为 16 KiB 加查询重叠；只保留一个命中和正在扫描的 layout。跨窗口重叠防止边界漏匹配，并把折叠字符映射回原 offset。[状态与常量](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L1-L81)、[扫描循环](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L319-L388)、[重叠与原位置映射](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L696-L732)。相关测试覆盖 Unicode offset、跨窗口命中和扫描让出执行。[搜索行为测试](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search_tests.rs#L81-L144)。本报告仅阅读这些测试，未运行。

搜索临时进入详细呈现，保存搜索前位置/模式；查到未加载历史就请求旧页。等待、读取失败、扫描耗尽分别表达，失败需显式重试，不伪装无匹配。[搜索进入](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L86-L106)、[状态提示](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L643-L685)。

限制在准备工作：`search_layout` 调用普通 `layout`，再扫描 `layout.text()`，因此一条大消息仍可能先完整渲染和换行；16 KiB 约束的是匹配步骤。查找正文已进入展示 cell，不是独立、直接从权威存储读取的有界搜索通道。resize、presentation 或 live 内容变化可重启搜索；这也不同于本票的“固定已提交历史上界”。[准备 layout](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L553-L568)、[变化与重启](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/search.rs#L275-L315)。

建议 Companion 搜索保留纯内容匹配与源位置映射，不以完整 Markdown/终端布局为前置条件；按范围扫描加入必要的跨界重叠，命中后才布局附近内容。搜索内容应覆盖可读的正文与活动详情，排除按钮/状态提示等控件文案；原文、可读文本和显示行之间的映射要明确，避免换行、resize 或 Markdown 样式改变命中身份。

## 到历史起点的差异

Codex 的 `jump_to_beginning` 标记 LoadingBeginning，随后不断加载旧页，所有旧页到达才跳到开头。[跳转入口](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view.rs#L362-L372)、[继续加载](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app/history_pagination.rs#L292-L308)。单次请求分页，不代表这次导航的总读取有界。

本票已有“直接加载最早内容附近”的决策应保留，不复制 Codex 的逐页填满路径；明确验收到起点不读取所有中间页。精确索引成本与不可读时的状态由应用读取合同处理。

## 后端和流式专项证据

后端权威存储及实际读取链路见 [存储研究](./codex-0160-transcript-storage.md)；长单条、Markdown 和流式布局见 [渲染研究](./codex-0160-transcript-rendering.md)。修正已与这些证据汇合，经用户确认后记录在最终决议中。

后端 Paginated 路径以 JSONL 为权威、SQLite item_json 为可重建全文投影，使用 ordinal keyset。非 ephemeral 且 LocalThreadStore 有 state DB 的新线程创建路径选择 Paginated，旧格式与其他条件另有全量路径。TUI 先取 turn 元数据再分页取 items，读取侧限条数、整条反序列化，未提供内容范围字节读取。我们已有 SQLite checkpoint 与首版单一正文约束，保留直接改造权威记录的方向即可，无需增加 JSONL + 全文投影维护。[游标](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/thread-store/src/local/thread_history/read.rs#L30-L45)、[TUI 读取预算](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app_server_session/history.rs#L30-L115)。

流式 `StreamingRender::append` 常态保留更早顶层块、重算最后一块；巨大单段落或表格仍可能每次解析累计全块，带语言标记的顶层代码围栏有受限快路径。引用定义等源级变化会触发 recompute；成熟 parser 本身不保证增量成本。定稿消息和 `TextLayout` 仍按完整单条重新布局。[append 与例外](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/render.rs#L122-L236)、[围栏快路径](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/code_fence.rs#L33-L122)。因此“只更新增长尾部”必须加上尾部自身的范围预算，完成/resize 也不能忽然切回整条富文本重算。

## 未发布主分支的相关变化

用户询问“最新 Codex CLI”，本报告以最新稳定发布为主，并额外检查同日官方 main 固定快照 `d25c114d494ddb693290b76bf5e5f64ecbdb38fc`，避免忽略未发布更新。此项仅定向比较相关文件，不声称完成全部 main 核验。

main 的分页前端 `app/history_pagination.rs`、流式 `streaming/controller.rs`、`streaming/render.rs`、`streaming/code_fence.rs`、定稿消息 `history_cell/messages.rs` 和 `transcript_view/text.rs` 对比 0.160.0 完全相同；`thread_history/read.rs` 的差异为 lineage resolver 新增参数，所比较代码未增加字节分页。布局淘汰仍保留单个超大项，未改变总内存结论。[main 缓存](https://github.com/openai/codex/blob/d25c114d494ddb693290b76bf5e5f64ecbdb38fc/codex-rs/tui/src/transcript_view/layout.rs)。

值得借鉴的变化在搜索呈现：main 不再一进入 Find 就切整个 transcript 为详细模式，而是通过 `search_presentation` 给命中项临时展开，手动展开偏好及固定阅读版本保持独立。它还加入查询编辑与命中阅读两种状态。这里是体验状态优化，不是正文范围读取：`search_layout` 仍调用 `entry_layout(full_content: true)`，live 搜索仍构造完整 `TextLayout`。[命中展开与完整搜索 layout](https://github.com/openai/codex/blob/d25c114d494ddb693290b76bf5e5f64ecbdb38fc/codex-rs/tui/src/transcript_view/search_presentation.rs#L13-L110)、[搜索状态](https://github.com/openai/codex/blob/d25c114d494ddb693290b76bf5e5f64ecbdb38fc/codex-rs/tui/src/transcript_view/search.rs#L53-L127)。

本票已有“搜索临时展示匹配详情，退出恢复显示模式”的体验合同，建议沿用仅命中附近临时展开。main 的 Esc/Enter 行为与本项目已裁决键位不同，不据此次性能研究重新改变键位。

## 已确认修正的范围

以下取舍已纳入最终决议，其中第 1、2、3、5 项对应用户确认的 Q16–Q19，第 4 项保留既有方向：

1. 阅读锚点补充内容版本及原文位置映射。流式阅读和跨页活动重组时固定当前局部显示版本，后台继续更新；离开或回到最新再接入当前版本。固定的是当前范围，不能复制或持有全历史对象。
2. 缓存计量补充可见/固定范围、解析尾部和扫描工作区；64 项 / 8 MiB 继续作为起始配置，不能宣称等于进程 RSS。超大单条也遵守范围上限，不保留整条豁免。
3. 搜索从读取合同取得正文与详情的有界可读文本，不先完整渲染消息。跨块重叠与 Unicode 位置映射保留原文定位，命中后才生成附近显示布局；搜索的临时展开不改变长期展开偏好。
4. 持久存储方向、稳定 keyset、最早/最新附近直接定位、正文按范围读取和有效模型上下文边界保持不变。这些适应本票的要求；Codex 的逐页填满、完整 item 读取和派生正文副本不提供更简单的替代方案。
5. 流式可变尾部必须单独受限。多语义块只重算尾部不够，尾部可能是一整张巨大表、一整段列表或段落；超出可安全处理范围就进入已有的完整原文阅读路径，按范围显示，不在完成或 resize 时强制全量富文本。全局引用定义等后到内容改变语义时，局部失效与可读降级需要明确，不承诺任意 CommonMark 结构都可直接分块解析。

上述修正不改变已有视觉、键位、Committed Model Step 或未提交片段重启取舍；具体公共字段和函数边界由后续 OpenSpec 核定。
