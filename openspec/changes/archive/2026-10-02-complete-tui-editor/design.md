## Context
输入保护基线提供同步 UI store、CAS、单活跃提交及 generation 检查；现有 composer 只保存字符串并在末尾编辑。Pending Interaction 已有回答权威与恢复流程，但没有真实问题正文或提问工具。

## Goals / Non-Goals
实现批准的编辑、粘贴、当前 Session 提问回答闭环。历史、跨 Session 返回、图片、全量 slash 候选和新运行状态机留给 #46 后继。

## Decisions
- **D-01**：UiDraft 全文唯一载荷，cursor 为 UTF-16 grapheme 边界，pasteBlocks 为 `{id,start,end}`，严格验证顺序、范围、身份和光标。编辑纯函数用 Intl.Segmenter，复用宽度渲染；不引依赖。TUI 展示态保存完整 UiDraft，保护模块负责保存，不重新建立发送管线。
- **D-02**：单次粘贴规范换行，在光标插入；超过 1000 code points 才折叠。原子块不可内部编辑，标签显示序号、字符数；位置调整按范围计算。正文最大仍为既有 20000 UTF-16 长度，超限拒绝发送，不截断。viewport 有界并跟随光标，Ink 原生 cursor 放置可见光标。
- **D-03**：当前 Session 面板保留聊天草稿与阅读位置。Shift+Left 打开；面板内 Shift+左右换题，Tab 切选项/自由输入，Enter 直接提交选项标签。Esc flush 后恢复聊天。详情异步读取以原目标身份验结果，新事件不抢焦点。沿用保护模块完整快照和 generation，受理只推进原未变输入。
- **D-04**：应用 Pending Interaction 用例拥有创建与精确查询；store 新增 question/options 权威列、精确读取和 keyset 页≤20。Scope snapshot 只读身份摘要，不复制正文。一个 ask_user 一题，最多八项，标签唯一，允许自由回答；总文字限 20000。可信 operationId 派生 InteractionId，subject 使用可信 Session；载荷相同重放返回已有问题，不同拒绝。先事务写入、回读再事件；不自动 suspend。
- **D-05**：shared Coordinator tools 在模型 schema、普通 registry 与 recovery registry 同时注册。仅通过可信 writer/Fence 用例创建；无任意 SQL 或外部 mutation。回答继续走原 IC-11 提交和 Actionable Work。
- **D-06**：UI schema 更新版本，旧格式数据保留并拒绝打开写入，不自动删库。Coordination 复用现有版本迁移机制新增空 question/options 列；既有交互可显示身份与 subject，自由回答不变，不补造问题。不新增独立升级工具或旧格式 UI 解码。

## Risks / Trade-offs
显示宽度受终端字体影响；验收覆盖 Ubuntu CJK/组合/emoji 与 resize。PTY 字节注入不证明真实 IME，人工证据须单列。查询及 viewer 固定边界；失败、CAS 与 unknown 保留输入。

## Migration Plan
测试与 PTY 使用隔离数据库和项目，不操作用户仓库私有数据库。未支持 UI schema 版本失败关闭。依赖、Git 权限与 Worker 不变。

## Open Questions
无阻塞设计问题。真实目标终端 IME 证据由人工验收提供。
