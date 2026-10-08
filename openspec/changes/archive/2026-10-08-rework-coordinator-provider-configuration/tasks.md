## 1. 配置与目录

- [x] 1.1 IP-01：定稿 schema5 与固定协议 DTO，核验引用与旧格式拒绝；pnpm test tests/bootstrap/project-config.test.ts。
- [x] 1.2 IP-02：用户连接/模型库、CredentialStore复用及项目快照保存；pnpm test tests/configuration。
- [x] 1.3 IP-03：发布 catalog、公共更新、发现与版本缓存回退；pnpm test tests/configuration/provider-catalog.test.ts。

## 2. 模型调用

- [x] 2.1 IP-04：生产依赖、固定协议 factory 和 SDK reasoning 补丁；pnpm test tests/adapters/chat-model-factory.test.ts。
- [x] 2.2 IP-04：有界响应恢复和真实工具续接探针；pnpm test tests/adapters tests/workflow。

## 3. 用户入口

- [x] 3.1 IP-05：bootstrap/Home/doctor/TUI 同源连接与模型选择；pnpm test tests/tui tests/bootstrap。
- [x] 3.2 IP-05：ledger-lab同源简洁交互式配置；pnpm test tests/acceptance/ledger-lab-setup.test.ts。

## 4. 文档与验收

- [x] 4.1 IP-06：调用方/共享fixture/实机生成器/exports与当前文档及lab delta同步；pnpm typecheck。
- [x] 4.2 IP-06：提供120×40、80×24、50×40可审阅画面并记录用户决议；用户于2026-10-08接受当前功能，明确将TUI美化与完整视觉对照留待后续，本轮不宣称视觉一致性通过。
- [x] 4.3 IP-06：完成必要全仓库检查及限定审计；pnpm typecheck、pnpm lint、pnpm build、pnpm test --maxWorkers=4、git diff --check、openspec validate rework-coordinator-provider-configuration --strict；结果与默认并发失败记录见 implementation-evidence.md。
