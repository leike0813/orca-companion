# Codex transcript 调研样例

对应 [裁决 transcript 的回合呈现与导航](https://github.com/leike0813/orca-companion/issues/41)。结论与固定源码引用见 [研究报告](../../docs/research/codex-transcript-display-and-interaction.md)。

2026-10-01，本机 `codex-cli 0.159.3`、Node.js 24.12.0、项目已有 `tuistory 0.11.0`。PNG 是本机 Codex 真实终端渲染；消息、工具结果与事件由 localhost WebSocket 固定假服务提供。没有请求模型、执行样例工具或连接真实 app-server。所有样例身份与消息都是 fixture。

| 样例 | 说明 |
| --- | --- |
| [紧凑活动](owned-compact-100x30.png) | 主视图中显示探索摘要及 Show details，composer 常驻 |
| [整段详细模式](owned-detailed-100x30.png) | Ctrl+T 后工具显示实际保留的完整命令与输出 |
| [阅读时有新活动](owned-new-activity-100x30.png) | 原阅读视窗与“未发送草稿”保留，新内容通过提示发现 |
| [局部活动展开](owned-local-disclosure-50x30.png) | F4 选择活动、Enter 原位展开，底部提示相应导航键 |
| [内容搜索](owned-search-50x30.png) | F3 打开底部 Find，搜索工具输出而不改 composer 草稿 |
| [窄屏紧凑视图](owned-compact-50x30.png) | 静态内容稳定后按 50 列重新排版 |
| [Terminal 历史阅读层](terminal-transcript-100x30.png) | --no-alt-screen 启动后，Ctrl+T 打开独立 TRANSCRIPT 层 |

文本记录包括稳定画面和部分中间态，不能把每个 `.txt` 都当作最终验收截图：`owned-live-tail-50x30.txt` 是 resize 后即时帧，可见截边；后续稳定帧才正确换行。`owned-compact-restored-100x30.txt` 来自多步操作，不用来证明精确搜索返回锚点。

## 复现

从项目根目录运行 `node artifacts/codex-transcript-research/fixture-server.mjs`，服务打印动态端口。它只监听 localhost，使用现有 tuistory 的 ws 依赖，返回限定的假协议数据；不需要凭据。将下列 `<port>` 换为打印值：

```sh
pnpm exec tuistory launch -s codex-transcript-research --cols 100 --rows 30 --background -- codex --remote ws://127.0.0.1:<port> -c analytics.enabled=false -c tui.animations=false
pnpm exec tuistory -s codex-transcript-research press pageup
pnpm exec tuistory -s codex-transcript-research snapshot --trim
```

该 fixture 针对 0.159.3 的协议，不是通用 mock backend。初始画面提供 30 行中文列表、一个搜索工具结果及保留输出。

- `Ctrl+T` 比较 compact/detailed；`F4 → Enter` 比较局部活动展开；`F3` 搜索 `fixture output 10`。
- 在非底部阅读且 composer 有草稿时，向 `http://127.0.0.1:<port>/live` 发 GET 推送固定文本 delta；向 `/complete` 发 GET 推送完成事件。检查视窗、草稿及新活动提示。
- 启动命令追加 `--no-alt-screen` 可比较 Terminal 模式的 Ctrl+T 阅读层；其 footer 明示 `q close` 与 `esc browse prompts`。
- 结束后关闭自己创建的 tuistory session，再停止 fixture 进程。服务输出的 `port` 和 `methods.log` 属于临时调试记录。

只发送研究导航按键，不提交普通 prompt；fixture 未实现 `turn/start`，提交会得到明确的假服务错误。它也不提供真实历史分页、工具执行、复制剪贴板或问答流程；这些行为的研究结论须参照报告中的源码证据与验证限制。

本轮确认了 Owned/Terminal 两种入口、工具详情、F3 搜索、新活动提示、草稿保护和静态 resize。没有验证真实 Provider 的流式行为、真实长会话分页、鼠标选区/clipboard、终端 raw 复制及所有异常路径。
