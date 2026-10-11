# 下一批 Worker Harness 验收证据

本轮正式纳入 **Command Code、Qwen Code**，两者使用中国区 MiniMax M Plan 的 `MiniMax-M3.1-Flash-Preview`。现有 codex、claude、opencode、pi、omp 保留，共七项注册。

- [Worker 矩阵](ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.md)：45 passed / 2 skipped，覆盖四角色、精确 Session、原 Session resume、Validator 同 Session/context 续接、只读 Recovery 与生产 bwrap；用户全局原生配置 hash 不变。
- [混合 Controller](controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.md)：1 passed，46.15 秒；Command Code 规划/实现，Qwen 验证/恢复/Finalizer。沿原 Scope 恢复，完成人工中断后的 Capsule 与替代 Validator、Git 集成、私有 origin 推送和 deliverable；同 Scope 重启保留 5 bindings、1 Recovery、4 settlements 与原预算。
- [候选表](../../docs/research/next-worker-harness-candidates.md)：18 项逐项结论。固定上游 SHA `cc5c85fb7a43ed52c6cd29157210020cd769d84c` 有其中 17 项内置身份，MiniMax Code 无内置身份。本机 Orca 仍为 1.4.222，源码支持与真实验收分别记录。
- [简明诊断](controller-blocker-investigation.md)、[Controller 限定审计](controller-limited-audit-20261011.md)与[原生安全审计](limited-audit.md)说明修复依据和边界。

真实验收已结束。一次性终端与 checkout 存证后经公开 CLI 回收；累计 135 个终端、21 个 checkout。最后两批见 [早期候选回收](cleanup-early-candidates-completed-20261011.json)与[Controller 回收](cleanup-p0vZXM-controller-completed-20261011.json)。归档位于 `/var/tmp/orca-harness-evidence`；用户认证、原生状态与 transcript 保留。Coordinator 私有配置目录 `/var/tmp/orca-ip04-mixed-controller-K9pR5M/coordinator-config` 保留，秘密不进入仓库证据。

普通测试未开启真实验收时默认 skip，不产生外部操作。重开验收沿精确 Scope/Run 调用正式 retry-session，保留 halted、unknown 原操作对账和整批确认规则。失败现场证据保留原失败结论，不回填为成功。

最终整合检查与未提交实现身份记录在 `implementation-checkpoint-20261011.json`，检查摘要在 `final-checks-20261011.md`。不提交、不 archive，不提前创建 verification。

验证限 Ubuntu x86_64；Windows/arm64 未实测。Command Code/Qwen 的写角色用原生 `--yolo`，无额外 OS 文件隔离；只读角色使用生产 bwrap/seccomp。
