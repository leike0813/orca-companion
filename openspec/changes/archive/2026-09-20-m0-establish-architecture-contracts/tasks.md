## 1. 规范文档

- [x] 1.1 实施 IP-1：新增 `docs/architecture.md`，完成 `MOD-01`–`MOD-07`、`FLOW-01`–`FLOW-04`、Mermaid 架构/时序图及等价文字说明；运行 `rg -n 'MOD-0[1-7]|FLOW-0[1-4]|```mermaid' docs/architecture.md`
- [x] 1.2 实施 IP-2：新增 `docs/interface-contracts.md`，完成 `IC-01`–`IC-12` 的 owner、canonical path、字段来源、校验、版本、错误、时序、消费者与测试 seam；运行 `rg -n '^## IC-(0[1-9]|1[0-2])' docs/interface-contracts.md`

## 2. 治理入口

- [x] 2.1 实施 IP-3：更新 `AGENTS.md`、`README.md` 与 `openspec/config.yaml`，加入合同文档触发指针并把规划包改为十一项串行链；运行 `rg -n 'architecture\.md|interface-contracts\.md|十一|11' AGENTS.md README.md openspec/config.yaml`

## 3. 下游 change 收敛

- [x] 3.1 实施 IP-4：更新 `m0-orca-control-baseline` 的 proposal/design/implementation-plan，使其直接前驱为本 change、baseline 为 `predecessor-contract`，并导入 `MOD-04`、`IC-01`、`IC-02`、`IC-12`、`FLOW-01`；运行 `openspec validate m0-orca-control-baseline --json`
- [x] 3.2 实施 IP-4：更新 `m1-persist-coordination-state`、`m1-run-coordinator-sessions`、`m1-plan-and-authorize-execution` 的 design/implementation-plan，加入各自 create/extend/consume 合同与漂移门；逐项运行 `openspec validate <change> --json`
- [x] 3.3 实施 IP-5：更新 `m1-admit-work-package-specifications` 与 `m1-execute-and-validate-work-packages`，固定 Specification、Worker、Delivery 的唯一 owner 与 canonical path；逐项运行 `openspec validate <change> --json`
- [x] 3.4 实施 IP-5：更新 `m1-recover-execution` 与 `m1-evolve-execution-graph`，固定 Recovery、Handoff、Wake、Delivery 与 GraphHistory 的 create/extend/consume 边界；逐项运行 `openspec validate <change> --json`
- [x] 3.5 实施 IP-6：更新两个 M2 TUI change，明确只消费/扩展 `IC-11`、`IC-12` 且 React 组件不拥有业务规则；逐项运行 `openspec validate <change> --json`

## 4. 全链审计

- [x] 4.1 实施 IP-7：运行合同 ID、唯一 owner、canonical path、旧路径、重复 Requirement 与尾随空白审计；确认每个后继 implementation plan 都引用 `docs/interface-contracts.md`
- [x] 4.2 实施 IP-7：运行 `openspec validate --all --json`、逐项 `openspec instructions apply --change <change> --json` 与 `git diff --check`；确认本 change 的其余任务均完成、十个后继仍为 apply-ready，且未创建 `verification.md`
