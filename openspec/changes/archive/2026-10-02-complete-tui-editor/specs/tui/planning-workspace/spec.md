## ADDED Requirements

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
