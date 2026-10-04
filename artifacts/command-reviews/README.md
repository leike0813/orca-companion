# 第六批 6A：命令与审阅证据

2026-10-04，Ubuntu；基线 `abf8f0c0617972f8277598dfe04257769ba86179`。
实现为 [complete-tui-command-reviews](../../openspec/changes/complete-tui-command-reviews/implementation-plan.md) 的工作区改动，未提交、未归档。

生产 `TuiApp` 和组件经 `scripts/tui-preview.mjs alignment-planning` 运行，全部 Controller/model/backend 端口为隔离 fixture。
画面中的提案、图、授权和模型名称是预览数据；真实字段投影、精确 ID/revision 和 Session 绑定由 Bootstrap 行为测试验证。
没有调用真实模型或 Orca，也未启动开发服务器。

## 采集与操作

```sh
pnpm build
node artifacts/command-reviews/capture.mjs
```

使用已有 tuistory/Ghostty PTY 和图片渲染器。三档 120×40、80×24、50×40，各覆盖彩色/NO_COLOR × Nerd/ASCII。
每组七对基础画面，共84对；彩色/Nerd另采三档授权四个子栏目、退出确认及交接两个子栏目，共21对；连续 resize 再采3对。
总计108对 PNG/同名终端文本。[samples.json](samples.json) 保存实际尺寸、颜色/图标、cursor，[checks.json](checks.json) 保存12组操作观察。

操作：输入“首尾”并把光标放在中间 → Ctrl+P 搜索“选项” → 进入选项搜索 ASCII → Esc 恢复目录原查询 → Esc 恢复聊天并插入“中”，得到“首中尾”
→ Session/模型独立搜索并逐层返回 → 授权五个栏目 → Ctrl+P/B/G 保持原审阅 → Ctrl+C 退出确认默认返回 → Esc 恢复原审阅 → 返回目录原查询
→ 选择交接收件人、prepare 精确提案、三栏审阅 → Esc 取消原提案并返回收件人页 → Cancel 默认返回 → 目录搜索在120→80→50→120连续 resize后保持。
键入和粘贴都更新查询而不执行操作；Enter 才确认当前对象。真实 PTY 测试另覆盖中文折叠粘贴、完整查看、原草稿/光标和退出终端恢复。

| 场景 | 代表画面 |
| --- | --- |
| 中文目录与直达子项、不可用原因 | [120×40](directory-search-120x40-color-nerd.png)、[50×40无色](directory-search-50x40-no-color-ascii.png) |
| 独立子页查询 | [选项](options-search-80x24-color-nerd.png)、[会话](session-search-50x40-no-color-ascii.png)、[模型](model-search-50x40-color-nerd.png) |
| 五栏授权、可信字段分组、默认返回 | [概览](authorization-overview-80x24-color-nerd.png)、[权限](authorization-permissions-80x24-color-nerd.png)、[预算](authorization-budget-80x24-color-nerd.png)、[范围](authorization-workspace-80x24-color-nerd.png)、[完整清单](authorization-complete-80x24-color-nerd.png) |
| 精确交接及责任/依据 | [无色50列](handoff-overview-50x40-no-color-ascii.png)、[责任](handoff-responsibility-80x24-color-nerd.png)、[依据](handoff-binding-80x24-color-nerd.png) |
| 原确认路径与返回 | [Cancel](cancel-default-return-80x24-color-nerd.png)、[Exit](exit-default-return-80x24-color-nerd.png) |
| resize 保持查询 | [80列](resize-search-80x24-color-nerd.png)、[50列](resize-search-50x40-color-nerd.png)、[120列](resize-search-120x40-color-nerd.png) |

## 定稿对照

来源为 [六票定稿对应表](../../openspec/changes/archive/2026-10-03-align-tui-with-approved-prototypes/design.md#d-01六张原型票直接作为设计参照)、[#45](https://github.com/leike0813/orca-companion/issues/45#issuecomment-5936017992)、[#52](https://github.com/leike0813/orca-companion/issues/52#issuecomment-5909125813)，以及 `artifacts/dialog-prototype/final/source.tar.gz` 和三档定稿画面。
原型 fixture 不进入生产；模型配置只承接当前已有的 Coordinator 目录，provider/effort/Worker 角色扩展留给6B。

| 定稿 | 本轮对照与范围 |
| --- | --- |
| #52 dialog final | 目录左右信息栏、搜索位于列表上方、固定圆角框与摘要/分隔线；授权五栏、交接三栏；当前页签有文字标记，长内容有位置提示，默认返回，退出确认恢复原审阅 |
| #47 above-input / #45 命令 | 原候选采用/执行分离保持；目录、slash、固定键位复用命令定义和 handler，独立查询不进入聊天 |
| #40 continuous / #41 阅读 | 子页返回保护原输入/锚点，未更改历史与正文 owner；后续编辑和切 Session 的迟到调用用行为测试核验 |
| #51 tabs | 原项目固定区域与总览/待答/事件入口保持；无目录查询驱动的后台业务动作 |
| #48 custom-direct | 简短顶栏、会话核心与风险行保持；缺失配置仍明确不可用 |
| #43 adaptive | 原图/Sidebar及三档切换保持；只复用已有 Inspector/过滤入口 |

比对覆盖布局、信息层级、栏目、导航及返回；真实值的长短由权威记录决定，不要求生产正文与原型样例相同。
无色终端通过页签括号、选中符号与“当前操作”表达状态。50列审阅页缩短键位提示以完整保留 Enter/Esc。

## 验证边界

行为测试覆盖字面中文/别名/路径、空结果、嵌套确认、独立查询、拒绝/unknown/延迟编辑、显式 Session 模型目录、多提案精确选择及 stale revision。
精确读取悬挂期间 guard 持续保护，受理后读取失败按原提案引用进入 unknown，连按不重建；展示刷新失败另保留已受理事实与原 slash 输入，核验只重读状态而不重发。只读查询被拒绝不证明原 mutation 被拒绝。
生产宿主为写入产生的结果引用做 schema/Scope/版本核验；既有业务记录是唯一权威。无引用异常或已覆盖的控制/模型事实不能证明原结果，保持 unknown。
进程内 guard 不是持久命令账本；重启不自动补发命令，不宣称所有响应丢失都能恢复原请求。

最终命令结果见 [implementation-plan 验收记录](../../openspec/changes/complete-tui-command-reviews/implementation-plan.md#9-验收记录2026-10-04) 和 [verification](../../openspec/changes/complete-tui-command-reviews/verification.md)。
既有有界历史/双缓存及 #53 性能接缝保留，本轮没有重新测量历史 p95。
中文与 emoji 字节往返不充当真实 OS IME 候选窗/预编辑人工证据；本轮未启用真实 Orca/provider 条件测试，Windows 未验证。
