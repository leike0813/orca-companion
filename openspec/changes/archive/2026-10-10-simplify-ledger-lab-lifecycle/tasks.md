## 1. 基线与合同移交

- [x] 1.1 核验 archived core、主规格和冻结接缝（IP-01–06）；运行 `git rev-parse HEAD`、`git status --short`、`openspec list --json`、`openspec list --specs --json`，按 implementation-plan 第1节核对当前符号和共享编辑边界。
- [x] 1.2 完成同路径 lab delta 移交和批次说明纠偏（IP-01）；更新原 active lab 受影响规划，保留其未完成真实业务验收；两份 change 分别运行 `openspec validate <change> --strict`。

## 2. 记录与仓库内安装

- [x] 2.1 提取唯一 run-record 模块，落实 schema 2、schema 1 读取和有界 list（IP-02）；扩展 setup acceptance，运行 `pnpm exec vitest run tests/acceptance/ledger-lab-setup.test.ts`，检查早期失败、missing repo 和列表截断。
- [x] 2.2 prepare 创建仓库、pack/install、提交推送并登记 Orca、打开原生项目终端（IP-03/07）；删除 lab 独立模型设置与 doctor，运行 setup acceptance，证明准备无模型请求。
- [x] 2.3 落实 package files allowlist、安装来源记录及安装失败现场（IP-03/06）；运行 `pnpm build` 和 implementation-plan T3，检查真实包的运行时 JSON 与本地 bin 可启动，不依赖开发路径。

## 3. 显式回收

- [x] 3.1 实现 cleanup 只读预览、`--yes` 及本地/远程身份核验（IP-04）；运行 `pnpm exec vitest run tests/acceptance/ledger-lab-cleanup.test.ts`，覆盖预览无mutation、同名/同路径替换、dirty可回收、已知运行/登记拒绝和证据保留。
- [x] 3.2 实现独立目标状态、删除前写入、unknown对账和部分失败再次显式处理（IP-04）；复用同一cleanup测试，检查远程删除不自动重复、已完成项跳过、旧schema零删除、写记录失败停止副作用。

## 4. 重开、证据与用户配置流程

- [x] 4.1 schema2 open 核验登记并聚焦原终端，仅已退出时替换；未登记旧schema2在显式open补登记；保持采集与离线报告边界（IP-05/07）。
- [x] 4.2 共享模型编辑支持空库debug与普通初始化；安装包真实PTY使用bare ocp/debug并验证聊天/工具/退出（IP-06/09）。
- [x] 4.3 普通启动自动逐项核验，首次配置步骤卡片及最终显式确认；Route Map创建/选择具有branch隔离持久操作与unknown对账（IP-08/09）；完成相关行为测试。
- [x] 4.4 更新根README/AGENTS、lab guide与IC-12/14/16、architecture和specs，使登记、启动、初始化与debug流程一致（IP-01/06–09）。

## 5. 验证与实操移交

- [x] 5.1 完成相关Vitest、typecheck、lint、build、两份change严格校验和diff检查；记录合成/本地PTY边界，跳过项不计通过（IP-01–09）。
- [x] 5.2 在明确获准的独立main轮次执行T4框架生命周期验收（IP-03–06）；人工TUI配置/Orca登记/Scope初始化、采集、退出/注销、回收预览与明确删除；保存脱敏真实平台证据。cancel档案的轮次隔离由既有setup acceptance覆盖；真实Scope Cancel归原lab业务验收。现场暴露的TUI缺陷保留记录，完成本项不表示这些缺陷已修复。
- [x] 5.3 按用户要求由实施者直接编写verification.md（IP-01–09），不派独立验证Agent；记录本轮工程检查与未执行真实平台验收，原lab真实业务任务保持实际状态。
