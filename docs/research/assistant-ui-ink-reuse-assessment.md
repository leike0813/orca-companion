# assistant-ui 的 TUI 资产能否被 orca-companion 复用

调研时间 2026-10-06。结论基于上游仓库 `main` 分支源码、npm registry 元数据与官方 Ink 文档的一手阅读，未安装运行该包。

## 结论

**不能复用，而且不是「取舍问题」，是模型层面的不兼容。**建议不引入任何 `@assistant-ui/*` 依赖。

最容易误判的地方在于：assistant-ui 确实有官方的终端包 `@assistant-ui/react-ink`（0.0.48），peer 依赖恰好写着 `ink >=6` / `react ^19`，它自己的 devDependencies 用的正是 `ink ^7.1.1` + `react ^19.3.0` + `ink-testing-library ^4.0.0`——和本项目的依赖三元组逐项相同。技术栈对得上，看起来像是现成轮子。

对不上的不是技术栈，是**谁拥有会话状态**。`react-ink` 的全部原语都挂在同一个假设上：一个 thread 就是一段完整驻留内存的对话，runtime 持有它全部消息。本项目的会话由 LangGraph checkpoint 拥有，历史由 SQLite 权威记录分页供给，界面只读快照和事件。这两套所有权不能同时成立，接上去必然要在中间加一层永久的翻译与身份对账——那正是 AGENTS.md §4 明确禁止的「界面自行推进状态」，也会把 IC-11/12/13 的合同撕开。

下面分三层说明：上游有什么、冲突在哪里、以及哪些单点看起来诱人但仍然不值得。

## 1. 上游现状

assistant-ui 是 React 生态的 AI chat 组件库，主打 Web（Next.js）、React Native、Vue、Svelte，也提供 assistant-stream、assistant-cloud 等配套。仓库 7485 个路径、约 45 个 package，12,416 stars。

与本项目相关的终端资产是两个包：

| 包 | 版本 | 依赖要点 |
| --- | --- | --- |
| `@assistant-ui/react-ink` | 0.0.48 | `@assistant-ui/core`、`store`、`tap`、`assistant-cloud`、`assistant-stream`、`diff@^9`、`parse-diff`、`ink-spinner`、`string-width` |
| `@assistant-ui/react-ink-markdown` | 0.0.47 | `markdansi@^0.3.4`（可选 peer `shiki`） |

`react-ink` 提供约 20 组 headless 原语，覆盖 thread、composer、message、messagePart、toolCall、checklist、chainOfThought、diff、loading、statusBar、threadList、attachment、actionBar、branchPicker、error、suggestion、textInput 等，外加 `useLocalRuntime`、`useRemoteThreadListRuntime`、`createFileStorageAdapter` 和 OSC 通知能力。另有 `examples/with-react-ink` 完整示例与 `ink-testing-library` 测试。

**成熟度是第一个警报。** `react-ink` 首个版本发布于 2026-03-08，至今仍是 `0.0.48`。就在今天（2026-10-06）它连发了 `0.0.47` 和 `0.0.48` 两个版本。`markdansi` 同样停在 `0.3.4`。0.0.x 语义下破坏性变更属于常规操作，一个每周多次发版、契约未冻结的包不适合作为本项目 TUI 的底座——而本项目 AGENTS.md §1 把「维护成本低」列为明确优先级。

## 2. 四处结构冲突

### 2.1 状态所有权

`useLocalRuntime` 直接 re-export 自 `@assistant-ui/core/react`，`useRemoteThreadListRuntime` 同理。这意味着进入 TUI 的会话状态由 assistant-ui 的 store 拥有，`useAuiState(s => s.thread.messages)` 直接读的是它内存中的数组。

本项目的规则正相反。`src/interfaces/tui/ports.ts` 的文件头把这条写成了结构性约束：屏幕与组件只依赖应用层窄端口，不 import Bootstrap、store、Orca adapter 或 workflow；端口刻意不暴露 `CoordinationScopeId` 与 `CoordinationWriter`，因为「模型和界面不得填写 scope、身份、Run 或 operation identity」必须由类型系统保证，而不是靠纪律。`app.tsx` 顶部进一步固定：所有加载都是只读 query，`execute` 只在用户明确动作时调用。

值得注意的细节是，`react-ink` 并**没有**导出 `useExternalStoreRuntime`（它存在于 `@assistant-ui/core/react`，Web 侧才从 `@assistant-ui/react` 暴露）。想在 Ink 里喂外部状态，只能绕过 ink 包直接依赖 `@assistant-ui/core/react`，也就是放弃了这一层抽象，同时保留全部线程模型负担。

### 2.2 历史读取模型

这是最硬的一处冲突。

本项目的历史是增量权威记录，经 IC-03/11/12 的 metadata / body / preview 端口读取：目录每页最多 20 项、正文每次最多 64 KiB、锚点绑定 Session 与来源版本与 UTF-8 offset，`src/interfaces/tui/render/transcript-reader.ts` 再用 `marked` 的 `Lexer` 把 token 投影成带 anchor 的 `TranscriptSpan`（plain / strong / emphasis / code / link / heading / deleted 七种样式），配合 8 MiB / 64 项双缓存。搜索高亮、活动分组、工具折叠、翻页返回全部依赖「行与 span 有稳定身份」这一点。

assistant-ui 的做法相反。`ThreadPrimitive.Messages` 遍历内存里的完整消息数组；它确实提供了 `windowSize` / `windowOverscan`，但注释写得很明确：较老的消息通过 Ink 的 `<Static>`「毕业」进终端 scrollback 并停止重绘。

也就是说，它的性能策略是**把历史交给终端缓冲区、从此不可再读**。而本项目的历史是要能被再次读取、再次渲染、跨页搜索、锚点定位的——毕业即终结，无法承担 3A/3B/第四批已经验收的能力。这个差异不是实现细节，是两种产品形态：前者是聊天 App，后者是可审计的协调工作台。

### 2.3 已确认原型

AGENTS.md §9 有一条硬约束：TUI 变更必须对照六票定稿原型实施与验收，未经用户明确批准不得自行重新设计。本项目 TUI 现有 48 个文件，包含 continuous transcript、above-input composer、固定区域 sidebar 与 Graph Inspector、项目面板、Command Palette、回答面板、授权审阅、图依据下钻、模型设置、粘贴查看器等。

`react-ink` 的原语是 thread-centric 的聊天组件，没有 Graph Inspector、没有项目面板、没有跨 Session 待答、没有分栏密度切换、没有基于 Manifest 指纹的授权审阅。它提供的是「怎么画一段对话」，而本项目要解决的是「怎么呈现一个协调 Scope 的运行事实」。交集比看起来小得多。

### 2.4 输入保护

IC-13 要求 `UiDraft.text` 是唯一展开载荷，光标位于 grapheme 边界，折叠粘贴保存唯一身份与非重叠范围，提交先保存完整快照与稳定 `submissionId` 再调用业务用例，容量满额与 CAS 冲突保留输入。

`react-ink` 的 `TextInput` / `useTextBuffer` 是一个受控 buffer 加一个 `PENDING_SYNC_CAP = 64` 的回声去重计数 map，`TextInput.tsx` 里甚至专门处理了「owner 纠正我们自己编辑时光标跳到末尾」的竞态。这个实现是扎实的，但它解决的是**单个受控文本框的双向同步**，不是**受保护的持久化输入**。原生光标、多行视窗、粘贴块、草稿恢复、提交快照——一概没有。

## 3. 单点逐项评估

| 资产 | 判断 | 理由 |
| --- | --- | --- |
| thread / message / composer 原语 | 不可用 | 与 §2.1、§2.3 冲突；且绑定 assistant-ui 消息模型 |
| `MarkdownText` | 不建议 | 语义错位，见下 |
| `useTextBuffer` / `TextInput` | 不可用 | 与 §2.4 冲突；本项目 `composer-editor.ts` 已是 grapheme + 保护模型 |
| `DiffView` 等 diff 原语 | 本项目无需求 | 当前 TUI 不渲染 diff，引入即新增未使用依赖 |
| `StatusBarPrimitive` | 本项目已实现 | `status-line.tsx` 已绑定可信测量来源，AGENTS.md §9 禁止用累计 usage 冒充 |
| `checklist` / `chainOfThought` | 无对应需求 | 本项目 transcript 只显示用户/Agent 消息与折叠 tool 记录 |
| `attachment` | 无对应需求 | 首版无附件通道 |
| `useNotification`（OSC 通知） | 唯一有想象空间 | 与 coordinator 事件语义弱相关，但属于新增能力而非复用，不构成引入整包的理由 |

单独说 `MarkdownText`，因为它看起来最诱人。它把 markdown 一次性渲染成 ANSI 字符串后塞进单个 `<Text>`，内部用 `memo` + 共享 resize 订阅（`WeakMap` 存每个 stdout 一个 store，避免十条以上监听器触发 Node 告警）保证不重复解析。工程上很干净。

但本项目要的不是「把一段 markdown 画出来」，而是「把一段 markdown 变成带身份的行与 span」。搜索高亮要 span 区间，锚点要行偏移，活动分组要按角色与 activityId 归并，工具折叠要在 detail 层切换解析粒度。一次性渲染成 ANSI 字符串恰好丢掉了这些信息。真要用，等于把它当黑盒再写一套解析器去还原身份——那不如继续用现有的 `marked` Lexer 投影。

## 4. 一个值得借鉴的实现细节

`MarkdownText` 的共享 resize 订阅值得记一笔：它明确注释了「每实例各挂一个监听器，在一个 thread 渲染超过十条 markdown 消息时会触发 Node 的十监听器告警」，因此用 `WeakMap` 把 stdout 映射到单一 store。

本项目目前不存在这个问题——`app.tsx` 在根组件单点调用 `useWindowSize()`，宽度是渲染输入而非业务状态，resize 只触发重排不重新查询。所以这只是印证了现有结构正确，不是待修问题。记下来是因为如果将来 transcript 改为按行惰性挂载组件，这个陷阱会重新变得相关。

## 5. 追问：只复用 transcript 模块 / 源码级迁移

许可不是障碍——`LICENSE` 确认为 MIT（Copyright (c) 2026 AgentbaseAI Inc.）。但把源码读进去之后会发现，「只复用 transcript」这个选项在技术上不成立。

**因为 assistant-ui 的 transcript 模块里几乎没有 transcript 逻辑。**逐个文件看：

| 文件 | 规模 | 实质内容 |
| --- | --- | --- |
| `MessageRoot` | 6 行 | `<Box {...boxProps}>{children}</Box>`，零逻辑 |
| `ThreadRoot` | 5 行 | 同上 |
| `MessageContent` | ~150 行 | 纯 store 管道，用 `useAuiState` / `useAui` / `PartByIndexProvider` 按 part 类型分发 renderer |
| `MemoMessage` | 30 行 | React `memo` + provider 包装 |

真正算算法的地方只有两处，都不是 transcript 本体：`ThreadMessages` 的 windowing（约 30 行，靠 Ink `<Static>` 毕业）和 markdown 渲染（完全委托给 `markdansi`）。

所以「复用 transcript 模块」的实际含义是：搬几个 Box 包装，再搬一整套必须逐个改成读本项目 port 的 store 管道。而管道恰好就是 §2.1 的冲突源。净效果是搬 200 行、删 200 行、依赖树上多出 9 个包。源码级迁移同理——它绕过了「要不要引入依赖」的问题，但绕不过「这部分代码必须重写才能用」的事实。

### 唯一有价值的窄片段：`useTextBuffer`

它确实有本项目 `composer-editor.ts` 没有的东西：word-wise 移动（`move-word-left` / `move-word-right`）、kill 系列（`kill-word-backward` / `kill-start` / `kill-end`），以及 `preferredColumn`（上下移动后记住目标列）。

但逐项对照后差距很小：

| 能力 | 本项目 | `useTextBuffer` |
| --- | --- | --- |
| grapheme 移动 | ✅ | ✅ |
| home/end、Ctrl+A/E | ✅ | ✅ |
| 上下移动记忆目标列 | ✅（`editorLayout` + 最近列 `reduce`） | ✅ |
| 多行视窗、原生光标 | ✅ | 部分 |
| 原子粘贴块身份 | ✅（`UiDraft.pasteBlocks`） | ❌ |
| 组合符合并后修正光标与块边界 | ✅（`replace()` 第 38–50 行） | ❌ |

真正缺的只有 word-wise 操作与 kill 系列，约 20 行，自己加即可。迁移整个 `useTextBuffer` 反而会丢掉 `pasteBlocks` 身份模型和那段 grapheme 合并修正——后者是这块代码里最硬的活。

## 6. 关于「自研 transcript 不可靠」

这个担忧有一半站得住，得分开说。

**站得住的部分：**`transcript-reader.ts` 595 行高密度逻辑，单测只有 7 个（另加 `controller-service.test.ts` 与 `activity-navigation.test.tsx` 的间接覆盖）。这个比例偏薄。更具体的例子是 `layout()` 收尾那行：

```ts
if (text.length > 0 && (!stopped || direction === 'end') || !stopped && lines.length === 0) push();
```

运算符优先级微妙，正是藏 bug 的地方。整份文件行极长、缩进压缩，可审查性也确实偏差。

**站不住的部分：**行为证据比通常的「手搓」扎实得多。`artifacts/bounded-transcript/` 里有真实文件 SQLite 上的基准——1k / 10k / 100k 条记录、1 / 5 MiB 正文、含中文 emoji 与巨型单段；真实 PTY 下 81 对画面，覆盖 120×40 / 80×24 / 50×40 三档、彩色与 NO_COLOR、Nerd 与 ASCII 共 12 种组合；输入 p95 ≤ 86.66 ms、缓存导航 p95 ≤ 9.73 ms，门槛是 100 ms。7 个单测挑的也正是最容易错的边界：CJK 响应内 UTF-8 锚点跨 resize 保持、已知围栏跨范围延续并在真实闭合行后恢复 Markdown、预览前缀在读取期间冻结、缓存预算在多宽度多范围下保持有限、读取失败保留原视窗。

风险的真实形态不是「手搓所以不可靠」，而是「单元级覆盖偏薄 + 可审查性差」。这个问题用加测试解决，成本远低于迁移，而且不必引入一个每周多次发版的 `0.0.x` 依赖。

具体建议：给 `layout()` 补属性测试——随机 UTF-8 偏移 × 宽度 × 内容，验证不变量（偏移单调、每行 `[start, end)` 落在源范围内、spans 重建原文与源一致、光标始终落在 grapheme 边界）。这是能真正证伪「不靠谱」的证据。

## 7. 若要推翻本文结论

我的判断基于源码阅读，没有安装运行。以下任一情况出现，结论应当重新评估：

1. 上游发布 1.0 且冻结线程模型契约。届时「运行时适配层」的成本会显著下降，但 §2.2 的历史毕业机制冲突依然存在。
2. 上游为终端场景提供 cursor 分页或 range 读取的 history adapter。`ThreadHistoryAdapter` 类型已被 re-export，值得盯它是否往有界读取方向演进——目前内置实现是 `AssistantCloudThreadHistoryAdapter`，面向 assistant-cloud，不适用于本地 SQLite 权威记录。
3. 本项目决定放弃可审计历史、改用聊天式终端。考虑到 AGENTS.md §8 把可恢复、可追踪列为核心承诺，这个前提不太可能成立。

唯一值得花半小时验证的动作，是在隔离目录里装 `@assistant-ui/react-ink-markdown` + `markdansi`，用本项目真实 transcript 样本测一次「渲染宽度、中文混排、宽字符裁切、1 MiB 正文耗时」并与现有 `marked` 投影对照。结论大概率是渲染更快、但拿不到 span 身份，因此仍然不用——不过这能把「不采用」从推理变成实测。

## 8. 一手来源

| 事实 | 来源 |
| --- | --- |
| 产品定位、stars/downloads | [assistant-ui.com](https://www.assistant-ui.com/)、[GitHub repo](https://github.com/assistant-ui/assistant-ui) |
| 包清单与 peer 依赖 | [`packages/react-ink/package.json`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/package.json)、[`packages/react-ink-markdown/package.json`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink-markdown/package.json) |
| 版本与发布时间 | [npm `@assistant-ui/react-ink`](https://www.npmjs.com/package/@assistant-ui/react-ink)、[npm `markdansi`](https://www.npmjs.com/package/markdansi) |
| 运行时装配方式 | [Ink 安装文档](https://www.assistant-ui.com/docs/ink)、[Custom Backend](https://www.assistant-ui.com/docs/ink/custom-backend)、[Adapters](https://www.assistant-ui.com/docs/ink/adapters) |
| 历史毕业机制 | [`ThreadMessages.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/thread/ThreadMessages.tsx) |
| Markdown 渲染方式 | [`MarkdownText.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink-markdown/src/MarkdownText.tsx) |
| 输入缓冲实现 | [`useTextBuffer.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/textInput/useTextBuffer.ts)、[`TextInput.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/textInput/TextInput.tsx) |
| 终端示例 | [`examples/with-react-ink`](https://github.com/assistant-ui/assistant-ui/tree/main/examples/with-react-ink) |
| 许可 | [`LICENSE`](https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE)（MIT，AgentbaseAI Inc.） |
| 原语实质规模 | [`MessageRoot.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/message/MessageRoot.tsx)、[`MessageContent.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/message/MessageContent.tsx)、[`MemoMessage.tsx`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/internal/MemoMessage.tsx) |
| 输入缓冲能力清单 | [`useTextBuffer.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/src/primitives/textInput/useTextBuffer.ts) 的 `TextBufferAction` 联合 |
| 本项目对照事实 | `package.json`、`src/interfaces/tui/ports.ts`、`src/interfaces/tui/render/transcript-reader.ts`、`src/interfaces/tui/input/composer-editor.ts`、`src/interfaces/tui/app.tsx` |
| 本项目自研证据 | `artifacts/bounded-transcript/README.md`、`artifacts/bounded-transcript/measurements.json`、`tests/tui/transcript-reader.test.ts` |