# Verification

## 验收对象

- Change：`render-bounded-transcript`（#37/#46 的 3B）。
- 输入实现 HEAD：`b15ff20d4fe7d42a218c7259fb0ebc793f24d2ae` 上的未提交工作区实现。
- 最终验收 HEAD：同上；该提交是实施基线，不包含本次未提交实现。
- 验收 Agent：当前主代理 Codex；TUI 原型对照由主代理完成。
- 报告日期：2026-10-03。
- 验收方式：按用户本轮明确要求，以当前工作区现状、上一轮实施上下文和留存证据撰写；本轮没有重新运行测试、性能采集、画面对照或静态检查。

用户本轮明确授权在未固定实现 commit 的状态下创建本文件，覆盖原计划中“固定实现 HEAD 后创建 verification”的时序要求。本报告验收对象是上一轮交付的未提交工作区实现，不将基线 HEAD 当作已包含实现的可复现提交；未进行提交、规格同步或归档。

## 结论

**PASS**，范围限本 change 的 3B 实现及上一轮已完成的证据。9/9 任务完成，5 项 Requirement、11 项 Scenario 均有对应实现与行为或采集证据；限定审计已完成，未留有已知的范围内缺陷或必需审计待办。

生产 TUI 已改用局部正文范围、来源锚点及有界缓存；模型调用消费 SDK stream，预览与权威历史隔离，完整接受后才执行工具。输出/上下文预算、取消、退出、fencing 及不明确 usage 的处理已接通生产宿主。六票定稿的布局与返回约定保持，输入与已缓存导航达到 #53 的 p95 门槛。

本结论依据已有运行结果和实施时的代码核对，不表示本轮独立重跑或对外部 provider、真实 Orca、Windows 的新增验证。

| 维度 | 结果 |
| --- | --- |
| 完整性 | 9/9 任务、5/5 Requirement、11/11 Scenario 有证据 |
| 正确性 | 生产 reader/workflow/宿主接线、关键失败边界、性能与 PTY 证据通过 |
| 一致性 | 沿 D-01–07、IP-01–06 实施；唯一权威正文、六票原型、IC-13 输入保护保持 |

## 核验与修复证据

以下结果均来自上一轮实施与复验，不是本轮新执行结果。详细数据、采集脚本和图片见 [3B 证据报告](../../../artifacts/bounded-transcript/README.md)。

| Requirement / Scenario / IP-ID | 实现与证据 | 结果 |
| --- | --- | --- |
| Bounded local transcript viewport / 长历史与巨型消息 / IP-01、04、06 | `transcript-reader.ts`、生产 App/Transcript、文件 SQLite；`benchmark.mjs` 的 1000/10000/100000 条不同记录及精确 1/5 MiB 正文、展开工具输出 | 各场景输入与已缓存导航分别至少 100 次采样，p95 均 ≤100ms；正文/布局缓存各受 8 MiB、64 项限制，冷读等成本另列 |
| Bounded local transcript viewport / 固定阅读版本与返回 / IP-01、04、05 | reader 来源身份/append revision/UTF-8 offset、pin 与读取代际；TUI 行为测试及历史/流式/resize/返回 PTY | 回看保持固定来源版本和锚点，返回最新才采用新版本；Session 切换丢弃迟到读取；overlay 返回保持草稿与光标 |
| Bounded local transcript viewport / 缓存与读取失败 / IP-01、04 | `transcript-reader.test.ts`、`transcript-preview-store.test.ts`；有限范围读取、双缓存与故障分支 | 缓存额度包含派生结构和固定版本；失败保留已有 frame/位置；折叠工具只取元数据，非当前 Session 不预热正文 |
| Range-aware Markdown and streaming preview / 跨范围 Markdown 与中文 / IP-04 | Marked 17.0.1、有限解析及已知围栏上下文；reader 最终 9 项测试、中文/emoji 与巨型正文采集 | 已知围栏跨范围延续并在实际关闭后恢复解析；巨大列表/表格和未知中段保留可读原文，不扫描全文前缀 |
| Range-aware Markdown and streaming preview / 真流式完成与中断 / IP-01、02、04、05 | 生产 graph/SDK stream/临时 store 的 `stream-benchmark.mjs`；4 组流式 PTY，workflow/宿主行为测试 | 可读稳定前缀与有限尾部；接受后关联正式 entry；未接受片段不进入历史或工具执行，刷新不恢复模型或制造最近事件 |
| Streaming model response isolation / 分片工具调用 / IP-02 | `model-call.ts`、`nodes.ts`、`graph.ts`；workflow 分片参数、原始 tool chunk 和完整响应测试 | SDK end callback 提供唯一完整响应；可信 step/call/operation 身份及原子接受后才执行工具，未自建全文聚合器 |
| Streaming model response isolation / 中断与租约失效 / IP-02、05 | workflow、`foreground-planning-runtime.test.ts`、`scope-control.test.ts`；真实临时 Git/SQLite 宿主测试 | Cancel 先持久意图再 abort；Exit 中止前台调用但不取消 Scope；Pause 保留在途调用；超限、取消、fencing 不提交片段或普通重试 |
| Streaming model response isolation / 预览存储不可用 / IP-01、02、05 | 临时 store 容量/固定版本/文件故障测试，observer 故障及宿主 query 测试 | 64 MiB/64 响应硬上限；无法保存明确不可用，已有可读前缀保留；预览故障不重复调用或阻止合法完整响应接受 |
| Verified streamed usage / 完整与不明确 usage / IP-02 | workflow 完整、缺失、部分及多个非空报告测试 | 只接受单个完整非空报告；多个报告或缺失/部分字段保留 null，不猜增量/累计规则，不填零或估算费用 |
| Finite output and context read budgets / 默认与非法配置 / IP-03 | `project-config.test.ts`、配置归一化及两处 checkpoint store 装配 | 默认输出 8 MiB、上下文读取 16 MiB；拒绝零、负数、非有限、非安全整数，保留已有 token/条数约束 |
| Finite output and context read budgets / 输出与上下文超限 / IP-02、03、05 | workflow 输出文本/内容块/工具参数预算测试，`checkpoint-store.test.ts` 及宿主装配 | 输出超限中止且不接受片段；上下文元数据/正文/材料累计受限，超限明确阻塞，不以截断或空历史继续；正式原文仍可局部读取 |
| 全部 Requirement / IP-06 | `AGENTS.md`、README、architecture/interface-contracts、TUI workbench/交接及证据报告 | 预算、读取所有权、流式接线、原型与本轮范围已登记；持久 schema 和 IC-13 合同未改动 |

### 已执行命令与结果

| 命令 / 检查 | 上一轮结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test --maxWorkers=4` | 147 个文件、1433 项测试通过；6 个文件中的 12 项按条件跳过 |
| `pnpm exec vitest run tests/tui/transcript-reader.test.ts --maxWorkers=1` | 在全库复验后补充 3 项 Markdown 回归用例，最终 9 项通过 |
| `pnpm exec vitest run tests/tui --maxWorkers=4` | 包含上述新增用例的最终 TUI 复验：28 个文件、193 项通过；2 个文件中的 2 项按条件跳过 |
| workflow 与宿主限定测试 | workflow 7 个文件、96 项通过；前台宿主 17 项通过；其余相关预算、store 与控制测试纳入全库复验 |
| `node artifacts/bounded-transcript/benchmark.mjs` | 7 个场景均达到输入/已缓存导航 p95≤100ms；最大输入 p95 为 86.66ms，最大缓存导航 p95 为 9.73ms |
| `node artifacts/bounded-transcript/stream-benchmark.mjs` | 精确 1/5 MiB 响应经生产 graph/SDK/SQLite 完成；流中无权威 assistant，接受后各恰好一条正式 entry |
| 真实 PTY 检查与 `node artifacts/bounded-transcript/capture.mjs` | 81 对 PNG/文本及操作证据；三档尺寸、彩色/无色、Nerd/ASCII 的 12 种组合，另含历史与流式场景 |
| `openspec validate render-bounded-transcript --strict` | 通过；最后一次在任务全部勾选后执行 |
| `git diff --check` | 通过；最后一次在交付报告和任务更新后执行 |

全库 1433 项与最终 TUI 193 项存在重叠，不累加；全库结果早于随后新增的 3 项 reader 用例，后者由最终 reader/TUI 复验覆盖。条件跳过不计入通过。

### 修复记录

本轮撰写报告期间无代码修复。上一轮实施与复验已完成以下修复，相关结果包含于上述最终证据：

- 修复局部 frame 首行角色标记遗漏，恢复已批准的用户标记与 Agent 圆点。
- 修复宿主复制 LiveSession 导致 graph closure 看不到后续 abort/fencing 状态的问题，改为共享同一真实 Session 对象。
- 收紧 usage 完整性判定；部分报告及多个非空报告均不产生费用事实。
- 修复临时 store 硬容量、分片代理对和失败后前缀读取边界。
- 补全已知代码围栏跨范围关闭与后续解析，并验证巨型列表/表格采用有界原文回退。

## 限定审计

依据 implementation-plan §8，以下审计在上一轮实施和复验中完成，本轮仅登记结论。

| 审计范围 | 结论与证据 |
| --- | --- |
| 生产接线与唯一权威正文 | App 使用独立 metadata/body/preview 端口；宿主核验 Scope/Session，读取不启动模型。临时文件只承载 preview，正式正文仍由原子接受与 checkpoint store 拥有 |
| 局部读取、布局与巨大结构 | 独立 reader 拥有有限范围、有限工作轮次、Markdown/宽字符布局和双缓存；1千/1万/10万及 1/5 MiB 实测达标，派生上下文计入预算 |
| 来源锚点与版本 | 正式 entry 与预览分别绑定可信来源/revision/UTF-8 位置；固定预览只 pin 同一文件前缀，未复制全文；历史追加、resize 和工具切换不计算全历史行号 |
| 取消、fencing、重试与工具接受 | signal/fencing 在 stream 和原子接受前复核；预算、取消、失去 lease 非重试；普通 provider 故障仍有限重试；部分结果不成为工具输入 |
| IC-13 输入与 overlay 返回 | 草稿/光标与正文阅读解耦；12 组项目/图/Cancel 返回均保留“首中尾”插入位置，stream/resize 不抢焦点；未改变输入持久化合同 |
| 六票原型一致性 | 主代理直接读取定稿决议、源码和画面，对照 #40 continuous、#47 above-input、#51 tabs、#52 final、#48 custom-direct、#43 adaptive；代表图片和观察见证据报告，不以测试替代视觉验收 |

无尚待处理的 CRITICAL 或 WARNING 级范围内问题；未触发公共合同越界、持久 schema 迁移、原型重设计或额外依赖授权。

## 后续注意事项

- 本报告绑定未提交工作区及现有证据；基线 SHA 不能单独复现本次实现。未来提交或修改产品后，应按实际状态更新验收对象，不能把本结论自动套用到其他版本。
- 性能门槛仅覆盖输入和已缓存导航。部分冷读、finish 或原子提交超过 100ms；`aggregateAfterChunkMs` 包含 SDK、合同解析及同步接受，不是纯 SDK 聚合时间。
- SDK 仍聚合完整响应；缓存额度不代表全进程 RSS 固定。性能进程还持有测试夹具、React/Ink 与数据库资源。
- 未知 Markdown 中段及巨大/不支持结构显示可读原文；临时 preview 不提供重启恢复权威，真实文件不可用时不伪造正文。
- 本次证据限 Ubuntu / Node 24.12.0 / pnpm 11.10.0；流式采集使用本地真实 SDK streaming fake 与生产 graph，未连接外部 provider 或 Orca。OS 输入法预编辑/候选窗人工验收及 Windows 未验证。
- 第四批活动分组/完整详情、F3 搜索、Ctrl+R 历史及后续配置不属于本 change，不能据此宣称已完成。用户原有工件迁移改动保持原状。
