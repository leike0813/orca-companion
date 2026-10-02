## Why

#46 的第二批需要把已保护的输入变成可实际编辑的 composer。按用户批准的方案，同时提前接通当前 Session 的真实异步提问与回答面板。

## What Changes

- 实现 grapheme 编辑、光标、受限多行 viewport 与 Enter/Alt+Enter。
- 超过 1000 Unicode code points 的粘贴以原子块折叠，保存完整正文与范围，提供 `/paste` 查看。
- Shift+Left、`/answer` 和 Palette 打开当前 Session 的底部回答面板，选项 Enter 直接提交，Esc 保留输入。
- 增加可信身份、可重放的 `ask_user` 与有界问题查询；复用已有回答提交、CAS 与故障保护。
- **BREAKING**：UI 草稿粘贴元数据改为 `{id,start,end}`；不兼容旧 UI schema，保留数据库并拒绝写入。

## Capabilities

### New Capabilities
- `coordinator/user-questions`: 当前 Session 的提问持久化、幂等重放与精确读取。

### Modified Capabilities
- `tui/planning-workspace`: 完整多行编辑与键位上下文。
- `tui/input-protection`: 完整光标、折叠范围和展开载荷保护。
- `tui/session-interactions`: 当前 Session 的底部异步回答面板。

## Impact

直接前驱为已归档的 `protect-tui-input`，规划 HEAD 为 `c1964d4913343265d20c4076ff82c5643c6cd30e`。本次是 M2 第二批，不实现历史搜索、完整命令候选、跨 Session 回答回跳或图片。不增加依赖，不提交或归档。涉及 IC-11/12/13、workflow、storage、bootstrap 与 TUI；保留前驱单活跃提交和稳定身份接缝。
