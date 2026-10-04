## 1. 固定配置合同

- [x] 1.1 IP-01：实现 domain 配置 DTO、项目 schema2 和引用/effort 校验；运行 `pnpm exec vitest run tests/bootstrap/project-config.test.ts`。

## 2. 配置与凭据保存

- [x] 2.1 IP-02：实现 CredentialStore 权限、锁、CAS、原子替换与安全错误；运行 `pnpm exec vitest run tests/adapters/storage/credential-store.test.ts`。
- [x] 2.2 IP-02：实现不可变项目保存与 ModelSettingsService，覆盖先key后引用及失败保留；运行 `pnpm exec vitest run tests/configuration`。

## 3. 实际模型注入与启动

- [x] 3.1 IP-03：Coordinator 凭据/effort 注入及切换全部能力核验；运行 `pnpm exec vitest run tests/adapters/chat-model-factory.test.ts tests/bootstrap/foreground-planning-runtime.test.ts`。
- [x] 3.2 IP-03：实现 secretless Codex launcher 并复用只读探针；运行 `pnpm exec vitest run tests/adapters/agents/codex-launch.test.ts tests/adapters/agents/codex-read-only-probe.test.ts`。

## 4. 授权与持久绑定

- [x] 4.1 IP-04：Manifest2、完整 model-only 重授权与唯一 ID/CAS；运行 `pnpm exec vitest run tests/application/authorization-service.test.ts tests/bootstrap/execution-authorization.test.ts`。
- [x] 4.2 IP-04：coordination schema16 与 materialization pin 读写；运行 `pnpm exec vitest run tests/coordination-store.test.ts`。

## 5. 派发与恢复接线

- [x] 5.1 IP-05：新Task用当前配置，Retry/旧结果用原binding，unknown/restart不重复；运行 `pnpm exec vitest run tests/application/materialize-work-package.test.ts tests/application/advance-execution.test.ts tests/bootstrap/execution-delivery.test.ts`。
- [x] 5.2 IP-05：Validator替代Session/修复保持原profile，新Utility独立pin；运行 `pnpm exec vitest run tests/recovery tests/bootstrap/foreground-execution-runtime.test.ts`。

## 6. 定稿模型界面

- [x] 6.1 IP-06：角色分组、provider/model候选、独立effort与默认返回；运行 `pnpm exec vitest run tests/tui/session-lifecycle.test.tsx tests/tui/command-reviews.test.tsx`。
- [x] 6.2 IP-06：内存配置编辑/key遮罩、save/apply/review与迟到归属；运行 `pnpm exec vitest run tests/tui`。

## 7. 证据和最终验收

- [x] 7.1 IP-07：更新当前文档与例子，六票三档/颜色/图标/CJK/resize生产画面对照保存到独立目录；检查 `artifacts/model-configuration/README.md` 的逐票记录。
- [x] 7.2 IP-07：隔离Orca/MiniMax真实启动，精确transcript核验model/effort/credential，完成限定审计；运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`、`openspec validate complete-tui-model-configuration --strict`、`git diff --check` 后交固定checkpoint验收。
