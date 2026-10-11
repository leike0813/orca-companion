## 1. 模型配置与真实用量

- [x] 1.1 实施 IP-01：手填/定稿菜单、metadata快照与固定协议effort；运行 provider-library-editor、provider-library、chat-model-factory 相关 Vitest。
- [x] 1.2 实施 IP-02：协议usage、latest step、窗口预算与诚实状态栏；运行 coordinator-graph、project-presentation 相关 Vitest。

## 2. 对话与初始化

- [x] 2.1 实施 IP-03：schema5有界可见投影、旧历史准备、搜索与空会话；运行 checkpoint-store/history 与 transcript-reader 相关 Vitest。
- [x] 2.2 实施 IP-04：即时pending、composer分离、accepted去重与新草稿保护；运行 input-protection、debug-app 相关 Vitest。
- [x] 2.3 实施 IP-05：真实turn状态及Route Map/final spinner；运行 foreground-planning-runtime、workspace、startup-onboarding 相关 Vitest。
- [x] 2.4 实施 IP-06：串行导航/底部及共享区域SGR鼠标；运行 transcript-reader、transcript-mouse 相关 Vitest与PTY检查。

## 3. 仓库回收

- [x] 3.1 实施 IP-07：删除前再核验及后置证明，unknown保留现场；运行 pnpm exec vitest run tests/acceptance/ledger-lab-cleanup.test.ts。

## 4. 集成与证据

- [x] 4.1 实施 IP-08 文档合同/当前change链接同步；openspec validate repair-ledger-lab-verification-findings --strict 与 git diff --check。
- [x] 4.2 完成 IP-01–08 受影响测试、pnpm typecheck、pnpm lint、pnpm build；另存三档尺寸/色彩图标生产画面与PTY证据，记录未执行的真人/真实平台边界。
