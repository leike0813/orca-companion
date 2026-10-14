## 1. 等级与接口

- [x] 1.1 IP-1：实现等级事实源、可选能力组与登记；运行 support/registry 测试。

## 2. 执行与授权

- [x] 2.1 IP-2：实现 schema 21 基础绑定与统一启动/结算/恢复门；运行 storage/delivery/specification 测试。
- [x] 2.2 IP-3：实现 Manifest v5、v4 读取与关闭恢复；运行 authorization/configuration 测试。

## 3. 探测与验收

- [x] 3.1 IP-4：接入资格摘要、按角色 doctor/TUI 与分级矩阵；运行相关行为测试。
- [x] 3.2 IP-5：更新领域/架构合同，运行 typecheck、lint、build、OpenSpec validate 并记录验证结果。
- [x] 3.3 IP-4/IP-5：显式隔离现场验证目标等级，记录真实结果与未验证项。

## 4. 任务级只读与可写 Finalizer

- [x] 4.1 IP-6：移除通用等级的只读条件，更新按角色 doctor 与分级验收；保留 Recovery/纯分析的任务级只读门。
- [x] 4.2 IP-7：扩展 Finalizer 显式授权、schema 22 原子准入/预算、独立 worktree 与恢复；旧授权不扩大权限。
- [x] 4.3 IP-8：实现 Finalizer 修复/最终 HEAD 与复验证据核验、受控 Git 集成、持久交付版本与状态投影。
- [x] 4.4 IP-9：补充修复成功、越界、旧证据/HEAD 错配、重启/幂等与 unknown 行为测试，更新领域/合同与最终 verification。
