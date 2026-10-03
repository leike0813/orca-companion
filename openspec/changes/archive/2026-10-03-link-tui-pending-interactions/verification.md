# Verification

## 验收对象

- Change：`link-tui-pending-interactions`
- 输入实现 HEAD：`69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`
- 最终验收 HEAD：`69f0aa1781265bb7623cb4bbb3e8ae5722e72bce`
- 验收 Agent：Ampere，`gpt-6-luna`，原生子代理 `01a10222-154a-7c21-b089-dfe68f9252b6`；主代理完成六票源码和画面对照。
- 实现状态：固定的未提交工作区，任务9/9完成；验收期间未改产品代码或测试，不为固定HEAD提交。

## 结论

**PASS**。覆盖当前Ubuntu上的第五批有界问题读取、历史原位问答卡片、跨Session明确进入及返回、输入保护，
以及规定的行为、性能和六票呈现证据。该结论包含首轮全量检查及唯一失败项修复后的复验，不将条件跳过算作通过。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| 有界问题读取 / 页面与精确详情 / IP-01 | `coordination-store.ts` 的 `pending-interactions`、`pending-interaction`、`interaction-body`；`tests/coordination-store.test.ts` | Scope/Session每页20条、精确后页、owner/revision隔离、按版本UTF-8范围通过。 |
| 有界问题读取 / Scope 分页与完整计数 / IP-01 | `projectControllerSnapshot`、`openInteractionCount`、`deriveExecutionFacts`；coordination-store、execution-view、status-command测试 | 展示页与完整计数分开，Finalizer测试覆盖37个待答且摘要页为空；CLI全25个开放身份保留、不返回正文。 |
| 历史提问与权威回答关联 / 重放与恢复 / IP-02 | `userQuestionInteractionId`、持久化 `HistoryCall.operationId`、reader摘要/正文端口；activity-navigation与既有问题创建/重放测试 | 使用可信正向ID，Branch Store拥有Q/state/A，不解析tool返回文案；固定来源重读与同载荷重放保持原身份。 |
| 固定外框项目面板 / 宽屏栏目切换不移动对话 / IP-03 | [PTY证据](../../../artifacts/pending-interactions/README.md) 的#51对照、scope-page画面 | ≥100列占原sidebar区域，对话宽度和位置保持。 |
| 固定外框项目面板 / 窄屏关闭恢复工作区 / IP-03 | saved-return、cursor-return、连续resize画面；input-paths、pty测试 | 窄屏关闭恢复原工作区，全文、光标、粘贴块及原历史锚点保留。 |
| 固定外框项目面板 / 事件和问题不复制权威 / IP-01/02/03 | App只读问题刷新与reader；no-side-effect及PTY证据 | 权威载荷仍在Branch Store，事件不切Session、不提交答案、不派发Worker。 |
| 项目待答有界联动 / 后页跨会话选题 / IP-01/03 | App Scope keyset/`showAnswer`；input-paths与12组PTY操作记录 | 第二页可明确选题，精确核验owner/revision并切到其Session；不受当前Session首20条限制。 |
| 项目待答有界联动 / 后台状态刷新 / IP-01/03 | Scope请求代际/cleanup、交互事件刷新；input-paths、activity-navigation | 丢弃迟到读取、保留选择与焦点；失效项明示变化，不自动打开下一题。 |
| 跨 Session 回答与明确返回 / 保存退出和成功返回 / IP-03 | App `returnAnswer`、`submit`、state reducer；input-paths、PTY保存/受理返回 | 保存成功或确定受理且没有后来编辑才回到原Session、栏目、选择、滚动、阅读锚点和输入。 |
| 跨 Session 回答与明确返回 / 后来编辑与迟到结果 / IP-03 | request generation、返回上下文身份、原submission结算；input-paths | 后来编辑不被覆盖，显式切会话令旧返回失效，晚结果只结清原提交。 |
| 跨 Session 回答与明确返回 / 核验或保存失败 / IP-03 | App进入/返回前flush及owner/revision检查；input-paths | unknown、拒绝、核验失败或保存失败保留原输入和绑定；沿原submission核验，不另建重试。 |
| 历史问题卡片原位阅读 / 回答前后原位阅读 / IP-02 | 同一TranscriptReader的interaction part/version/offset；transcript-reader、activity-navigation | Q/state/A原位呈现与展开；同一步多问参数/卡片/结果按原序列，缓存/锚点、索引未就绪/缺失/失败边界通过。 |

命令与实际结果：

- 验收Agent限定复验：`pnpm exec vitest run tests/coordination-store.test.ts tests/application/execution-view.test.ts tests/application/controller-service.test.ts tests/tui/transcript-reader.test.ts tests/tui/activity-navigation.test.tsx tests/tui/input-paths.test.tsx --maxWorkers=2`：6文件、140项全部通过。
- 实施阶段全量 `pnpm exec vitest run --maxWorkers=2`：150文件/1513项通过、唯一失败为Controller公开字段清单缺少新增 `openInteractionCount`；6文件/12项条件跳过。补入字段后该文件15项全部复验通过。产品代码无后续修改，去重合并覆盖151文件/1514项通过；未把复验重复计数，也未声称另一次完整运行。
- 最终 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate link-tui-pending-interactions --strict`、`git diff --check`通过。
- 普通真实PTY `tests/tui/pty.test.ts`：13项在完整suite内通过，含无TTY门禁、三档 `stty -g` 退出恢复、中文粘贴和resize。
- `node artifacts/pending-interactions/capture.mjs`：12组、147对PNG/文本，三档尺寸、彩色/NO_COLOR、Nerd/ASCII、保存/受理/选择失效/光标与连续resize；主代理完成六票定稿源码和画面对照。
- `node artifacts/pending-interactions/benchmark.mjs`：五场景各100次输入/缓存导航/展示查询；输入p95最大74.73ms、导航最大11.02ms，均低于100ms。正文最大单读16388字节，双缓存低于8MiB/64项；冷读取单列。

验收阶段修复：无。上述Controller字段清单及阅读/返回保护修复已在固定实现交接前完成；验收Agent只读。

## 限定审计

IP-01/02/03要求的限定审计已完成：完整计数与Finalizer、SQL/body读取预算、可信ID、owner/version/UTF-8、
同一步多问顺序、submission/draft revision、异步generation、后来编辑、unknown、保存失败、手工切Session和迟到结果。
前期只读核查指出的返回历史重载竞态、切Session保存失败前过早清除返回上下文、Scope迟到请求已修复并回归。
最终 `gpt-6-luna` 复核源码与6文件140项测试后确认通过，无待处理的必需审计。
主代理拥有的六票呈现验收见独立证据，不由自动测试替代。

## 后续注意事项

当前平台证据限Ubuntu；真实Orca/provider条件测试未启用，Windows未验证，未新增真实OS IME预编辑/候选窗人工证据。
1/5MiB持久回答是压力fixture，不表示当前用户输入允许该大小。
后继provider/effort/角色配置、custom保存和完整历史图/验收摘要不在本轮范围。
实现仍未提交、未归档，主规格同步留给后续显式完成流程。
