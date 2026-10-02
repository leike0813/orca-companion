## 1. 前驱核验与聊天呈现

- [ ] 1.1 IP-01：核验 `complete-tui-editor` 已验证归档、主规格及冻结接缝，记录实际实施 HEAD 与原型参照；运行 `openspec list --json`、`git rev-parse HEAD`、`git status --short`，按 implementation-plan 第 1 节完成核对。
- [ ] 1.2 IP-01：生产 transcript 对齐 continuous 标记、色边、留白及紧凑工具，保留真实正文与展开身份；运行 `pnpm exec vitest run tests/tui/workspace.test.tsx tests/tui/execution-workspace.test.tsx`。

## 2. 输入与当前 Session 回答

- [ ] 2.1 IP-02：圆角 composer、共享内宽、正确行列预算和 native cursor，保持完整编辑与粘贴保护；运行 `pnpm exec vitest run tests/tui/composer-editor.test.ts tests/tui/width.test.ts tests/tui/workspace.test.tsx tests/tui/input-paths.test.tsx tests/tui/input-protection.test.tsx tests/tui/pty.test.ts`。
- [ ] 2.2 IP-03：回答问题/选项/自由输入统一视觉，保持真实状态、精确绑定和 Esc 恢复；运行 `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/interaction-card.test.tsx tests/tui/session-lifecycle.test.tsx`。

## 3. 行为与原型一致性验收

- [ ] 3.1 IP-04：完成相关行为回归及无副作用检查，类型/lint/build/严格 OpenSpec/diff 检查通过；执行 implementation-plan 证据矩阵中的命令。
- [ ] 3.2 IP-04：主 agent 完成生产组件的三档彩色/NO_COLOR 画面、中文多行/粘贴/回答/Esc/禁用状态逐项原型对照，使用既有 tuistory/PTY 入口将证据另存 `artifacts/tui-prototype-alignment/`，更新交接页的独立进度与证据；原型样例保持完整。
