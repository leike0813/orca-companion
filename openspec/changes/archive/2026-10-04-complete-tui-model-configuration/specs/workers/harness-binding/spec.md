## ADDED Requirements

### Requirement: Codex launch resolves the approved model binding
Codex 普通 Worker、Finalizer、Recovery Utility 和能力探针 SHALL 使用同一配置生成及内部 launcher，解析固定 profile 的 provider/model/effort/options/credentialRef。秘密 SHALL 只进入子进程环境，公开 Orca terminal command 和 CLI 参数 SHALL 只包含非秘密描述符。managed key SHALL 不被既有 Harness auth 覆盖；Harness-login SHALL 沿原认证方式。provider 不可用或凭据缺失 SHALL 阻塞，不自动 fallback。

#### Scenario: 实际进程配置一致
- **WHEN** 启动批准的角色或替代 Session
- **THEN** 子进程实际收到固定 provider/model/effort 和认证，终端命令/持久记录不含 key，精确 Session transcript 可核验模型

#### Scenario: 只读探针与正式启动一致
- **WHEN** 核验 Finalizer/Utility 只读能力并正式启动
- **THEN** 两者使用相同 launcher 与 profile 设置，保持已有 read-only sandbox/control 合同
