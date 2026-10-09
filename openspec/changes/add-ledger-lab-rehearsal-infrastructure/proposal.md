## Why

ledger-lab 已有业务剧本和验收工具，但每轮实操仍需手工准备仓库、Route Map、模型配置与 Orca 终端，准备过程难以复跑和追踪。将一键演练准备纳入正式基础设施，能降低实测成本，并保留足够现场信息以调查失败。

## What Changes

- 增加 `pnpm lab:new`，构建当前开发版本，为 `main` 或独立 `cancel` 轮次创建外置 canonical 仓库、私有 GitHub 仓库、空 Route Map、最小项目配置与 Orca 终端；完成能力核验后由用户启动演练。
- 增加交互式配置向导与 XDG 设置复用，分别选择 Coordinator 和五个 Worker Profile；首次配置与重新配置先核验用户级 Provider Library 与凭据库，再自动更新公共 Provider/模型目录；沿用现有凭据隔离、原生模型来源与配置 CAS 合同。
- 增加轮次记录、失败保留与身份核验后的重开；现有四个采集/验收命令支持 `--run` 默认路径。
- 提供短命令 `ocp`，保留等价的 `orca-companion` 入口。

直接前驱为已于 2026-10-07 归档的 `remove-worker-credential-management`。本 change 属于 M2 后的本机实测基础设施，补录本次会话已经授权并实现的工作；不会将未完成的实机验收记为通过。Scope 初始化、业务需求、规划审阅与执行授权继续由用户完成；不增加自动业务演练、headless 调度、跨平台支持或项目级模型 fallback。

## Capabilities

### New Capabilities

- `testing/ledger-lab-rehearsal`: 定义轮次准备、设置复用、现场保留、重开与外置采集/验收入口的行为。

### Modified Capabilities

- `tui/scope-initialization`: 扩展「前台入口与 TTY 门禁」，将 `ocp` 与长入口的等价行为纳入合同；Home 与原子初始化规则保持原有归属。

## Impact

- 操作者入口：`package.json`、`artifacts/ledger-lab/{lab,setup,wizard}.mjs` 与该目录指南。
- Bootstrap：`src/bootstrap/{ledger-lab,worker-model-settings,foreground-planning-runtime}.ts`，复用 schema 5、模型设置服务、CredentialStore、原生模型目录和 doctor。
- CLI：`src/interfaces/cli/{main,argv}.ts`，两个 bin 指向同一入口。
- 测试与当前开发文档：相关 bootstrap/acceptance/doctor 测试、根 README 与 AGENTS；不增加依赖，不改变协调数据库或 Execution Authorization schema。
- 外部副作用只发生在新轮次：Git 首次提交与推送、GitHub 新私有仓库/Issue、Orca 仓库登记与终端创建。准备阶段 doctor 会调用模型；现有业务验收工具继续只读采集并输出外置报告。
