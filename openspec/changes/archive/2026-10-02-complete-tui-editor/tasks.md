## 1. 输入与问题权威
- [x] 1.1 IP-01：完整草稿 schema、grapheme 编辑和粘贴范围；运行 editor/store/protection 行为测试。
- [x] 1.2 IP-02：问题创建、幂等重放、精确读取与有界分页；运行 coordination-store/scope-control 测试。
## 2. 生产接线与界面
- [x] 2.1 IP-03：两模式及恢复注册 ask_user，接通 Controller 只读查询；运行 workflow/bootstrap/controller 测试。
- [x] 2.2 IP-04：完整 editor viewport、native cursor、paste viewer、底部回答面板与键位；运行 TUI 行为测试。
## 3. 验收与文档
- [x] 3.1 IP-05：同步合同/帮助/preview，typecheck、lint、test、build、严格 OpenSpec 与 diff 检查通过。
- [x] 3.2 IP-05：隔离真实 PTY尺寸/CJK/resize/粘贴/回答/无色/焦点/退出恢复验收。
- [x] 3.3 IP-05：真实目标终端中文 IME 预编辑与提交人工证据。

人工证据：2026-10-02，用户按目标终端 IME / 回答面板验收请求反馈：“我已完成人工验收，交互似乎是正常的。”终端与输入法名称未提供；此项为用户人工反馈，PTY 字节注入未作为 IME 证据。
