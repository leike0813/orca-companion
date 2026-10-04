## 1. 可信项目与会话投影

- [x] 1.1 实施 IP-01/D02 metadata、身份/Claim/模型/预算 DTO 与精确绑定；运行相关 application/host 测试。
- [x] 1.2 实施 IP-01/D03 精确 installed integration context 能力与失效；运行 chat-model-factory/runtime 测试，无能力不造数。

## 2. 当前图验收摘要

- [x] 2.1 实施 IP-02 全图当前合同 Validator 结果去重与共享摘要；运行 execution-view/presentation 测试。

## 3. 有界项目读取

- [x] 3.1 实施 IP-03 精确 store/tracker 查询和批准后授权/预算主体投影；运行 coordination-store/application 测试。
- [x] 3.2 实施 IP-03 项目详情20项/64KiB与UTF-8 continuation、版本失效；运行 host-wiring/详情行为测试。

## 4. 用户偏好持久化

- [x] 4.1 实施 IP-04 schema1/port、默认、文件异常与分区CAS存储；运行 tui-preferences-store 测试。
- [x] 4.2 实施 IP-04 Bootstrap 只读load/显式save装配，验证重启和跨宿主冲突；运行 bootstrap/host 测试。

## 5. 定稿 TUI 接线

- [x] 5.1 实施 IP-05 可信顶栏/单行状态栏、三处共享验收及项目详情固定框；运行 tests/tui。
- [x] 5.2 实施 IP-05 custom编辑/同源预览/Enter保存/默认恢复/Esc，失败CAS和迟到回调保留原上下文；运行相关输入/设置测试。
- [x] 5.3 实施 IP-05 图标即时选择/独立保存/未保存重试与env临时覆盖；运行偏好与no-side-effect测试。

## 6. 生产验收与交接

- [x] 6.1 实施 IP-06 六票三档两色两图标、五状态/返回/失败/连续resize画面与真实PTY、性能证据；采集 artifacts/project-statusline 并逐票核对。
- [x] 6.2 实施 IP-06 文档合同/进度更新及最终 typecheck/lint/test/build/严格OpenSpec/diff检查，记录限制；不提交、不归档、不提前创建verification。
