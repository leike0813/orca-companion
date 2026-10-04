# 第六批 6B 模型配置证据

对应 [complete-tui-model-configuration](../../openspec/changes/complete-tui-model-configuration/implementation-plan.md)。基线 HEAD 为 `8f6d1a7e6765a024191043b97fbded2d4a902207`；实现保持未提交。旧原型与前驱证据只读，新的采集保存在本目录。

## 生产画面与操作

运行 `pnpm build` 后执行 `node artifacts/model-configuration/capture.mjs release`。采集挂载生产 `TuiApp`，使用独立内存输入库与明确的 fixture 端口；不连接模型、tracker 或 Orca。fixture 的 provider、effort 与授权字段只用来检查界面，不作为实际运行事实。

第一轮完整采集位于 `final/`：159 对 PNG/同名 UTF-8 文本，清单见 [samples.json](final/samples.json)，12 组操作见 [checks.json](final/checks.json)。每组覆盖 120×40、80×24、50×40之一及彩色/NO_COLOR、Nerd/ASCII组合；另有120→80→50→120连续 resize。

操作顺序：中文正文任意位置编辑 → Palette 打开模型页 → 查看未实现角色原因 → Planner 模型候选 → Tab 独立 effort → 默认返回 → `e` 编辑连接 → 中文连接名 → Harness 登录隐藏 key → managed key 遮罩 → Enter 保存 → 显示尚未应用 → 显式应用打开完整授权审阅 → Esc 逐层返回 → 原光标插入中文 → 项目面板 → 图检查 → 上方 slash 候选。返回后普通草稿为 `首中尾`。遮罩采集使用无效的固定测试字符串；它不是凭据，脚本检查该字符串不出现在屏幕。

## 六票对照

定稿决议、源码和代表画面统一见 [原型 D-01](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)。六票实际决议通过 GitHub comment API 读取；语义依 #41/#42/#44/#45/#50 最终决议。

| 票 | 本轮对应画面 | 核对内容与边界 |
| --- | --- | --- |
| P-40 / #40 continuous | `workspace-*`、`returned-draft-*` | 连续正文、弱助手标记、工具折叠及聊天返回；流式与历史全文保留前驱验收范围 |
| P-47 / #47 above-input | `slash-above-*`、`returned-draft-*` | 圆角输入框，上方独立候选；普通草稿、光标和中文不被设置覆盖 |
| P-51 / #51 tabs | `project-*` | 宽屏原 sidebar 区域，窄屏主区域；固定框、栏目和 Esc 返回 |
| P-52 / #52 dialog final | `roles-*`、`unavailable-role-*`、`model-menu-*`、`effort-*`、`editor-*`、`masked-key-*`、`saved-*`、`reapproval-*` | Coordinator/Planning/Execution分区、独立横向 effort、反色动作与默认返回；未实现角色明确原因 |
| P-48 / #48 custom-direct | `workspace-*`、`returned-draft-*` | 简短顶栏、会话模型单行、独立通知；custom偏好持久化与可靠context由第七批承担 |
| P-43 / #43 adaptive | `workspace-*`、`inspector-*`、`project-*` | 默认侧栏、分区节点卡与三档只读检查；图历史和依据全文由第八批承担 |

首轮查看发现50列模型菜单的 effort 来源换行挤出标题，已改为按显示宽度裁切；`final/` 保留首轮问题原貌。`verified/` 与 `acceptance/` 各159对是中间复采。最终 `release/` 已完成171对，清单见 [samples.json](release/samples.json)，12组操作见 [checks.json](release/checks.json)，没有覆盖前轮证据。最终复采另含 Harness 登录隐藏 key 的画面，并在保存后的草稿返回检查之后清除普通草稿，再输入 `/` 展示真实上方候选；前轮把 `/` 追加到普通草稿末尾，未展示候选，该画面不能作为 slash 验收证据。

代表画面已与六票定稿直接对照：模型角色分区、独立水平 effort、反色动作与默认返回沿用 #52；项目面板仍占宽屏右侧固定框，窄屏独占主区域；正文、圆角输入与返回草稿保留，图邻域与节点卡沿用 adaptive。身份、context 与图进度只按已有可信合同显示，未实现字段明确不可用。原型的 fixture 9/20 进度、常驻 thought 和旧回答键位按最终语义决议处理，不复制为运行事实。

## 实际启动

`real-launch.mjs` 只用系统临时目录中的独立Git项目、临时0700/0600凭据文件和公开Orca terminal命令。key从本机 `.env.smoke` 读入内存，不写命令、argv、截图或报告；临时项目和凭据在采集后清理。`real-startup.json` 保存非秘密启动结果。

2026-10-04 的 [real-startup.json](real-startup.json) 记录 `launched-with-approved-binding`：生产 launcher 经独立 Orca terminal 启动，真实助手回合已观察到，SessionStart 与精确 transcript 的工作目录、隔离 CODEX_HOME 和 Session 身份核验通过；模型为 `MiniMax-M3.1-Flash-Preview`、effort 为 `low`，与固定绑定一致。公开启动命令只有 node/launcher/descriptor，transcript 中未发现 key。managed key 来自临时凭据文件并通过子进程环境注入；文件采集结束后清理。

初次探测等待 SessionStart 的顺序错误：Codex TUI 收到首个 prompt 后才触发 hook。采集已调整为先等待 TUI，再发送短只读 prompt，再核验报告与助手响应。只读沙箱能力探针不调用模型，不能代替此认证和实际模型调用证据。此记录证明本次固定配置的实际启动，不把它扩大为所有 provider、角色和恢复路径的真实集成结论。

## 验证范围

最小验证覆盖配置存储、凭据解析、启动与界面返回。独立审计发现的密钥字段别名、Worker 快照一致性、旧引用改写、Harness 登录误存新 key 和自由文本凭据引用已修复；凭据源由 Bootstrap 显式注入。固定工作区的[独立验收报告](../../openspec/changes/complete-tui-model-configuration/verification.md)结论为PASS，范围及各轮真实退出结果均已记录。

后续独立秘密审计发现带认证信息的连接 URL 能进入项目与 Codex 参数，领域边界和 modelOptions 扫描已复用同一 URL 判定，拒绝 userinfo 与凭据查询参数，保留普通 API 版本参数；配置、保存、Codex 启动与授权相关73项复验通过。审阅失败的迟到回调也已加原调用/导航核验，重新打开的模型页不受旧错误影响；该回归与格式化配置超限检查共41项通过。Delivery/Finalizer fixture 与 launcher 断言调整后36项通过。

最终静态检查、build、严格OpenSpec和diff检查通过。全量检查与最后39个受影响文件的复验按文件去重后为1653项通过/12项条件跳过；最终受影响检查单独为340项通过/2项跳过，普通真实PTY13项通过。全量运行期间候选规则更新导致2项旧实现断言失败，已由冻结后的完整受影响文件复验覆盖；保留各轮真实退出结果，详见[实施记录](../../openspec/changes/complete-tui-model-configuration/implementation-plan.md#9-实施记录2026-10-04)。

平台证据限当前Ubuntu。没有新增OS输入法候选窗/预编辑人工证据；Windows未验证。普通全量检查的条件跳过不计通过，也不代替本轮真实启动。
