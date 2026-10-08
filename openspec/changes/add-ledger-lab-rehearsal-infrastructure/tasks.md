本清单补录已获授权的实现；工程完成项在核对当前代码与证据后回填。真实验收与最终审计单列，准备框架不承担完整业务剧本的自动执行。

## 1. 前驱接缝与可复用设置

- [x] 1.1 核验前驱 archive、schema 4、IC-14 与 Scope/Orca/验收接缝（IP-01–05）；检查 `git rev-parse HEAD`、前驱目录和 implementation-plan 第 1 节引用的主规格。
- [x] 1.2 复用生产模型服务与凭据实例，补齐首次配置、五角色、可信目录、CAS、取消与隐藏输入（IP-01）；运行 T1 的两份 bootstrap 测试和 setup 向导用例，核对 PTY 输入后 raw 状态恢复。

## 2. 准备隔离轮次与失败现场

- [x] 2.1 实现空 canonical 项目、私有 GitHub 仓库/Route Map、本地 Git 初始化与 credential helper、Orca 登记、外置启动器和 doctor（IP-02）；运行 setup acceptance，检查轮次只含最小项目且无 Scope/Run/Task/业务 src。
- [x] 2.2 实现阶段持久记录、取消与 unknown 无重试/清理（IP-02）；运行 setup acceptance 的 unknown create 与阶段取消用例，检查 create 次数和保留的 failed 记录。

## 3. 重开与轮次验收入口

- [x] 3.1 按原 Git/Orca 身份重开 terminal，拒绝 branch/path/origin/worktree 漂移（IP-03）；运行 setup acceptance 的重开成功/拒绝用例。
- [x] 3.2 为原四命令补 `--run` 默认路径、只读唯一 Scope 与空模板绑定（IP-03）；运行 setup acceptance、collector/process/result 回归，检查缺 Scope 拒绝、人工内容保留和空成品 BLOCKED。

## 4. 短命令与当前指南

- [x] 4.1 发布等价 `ocp`/`orca-companion` bin，补 CLI shebang 与帮助（IP-04）；运行 doctor 测试及 `node dist/src/interfaces/cli/main.js --help`，核对两个 bin 指向同一主入口。
- [x] 4.2 更新根 README/AGENTS 与 ledger-lab README/guide/capabilities（IP-04）；核对 `pnpm lab --help`、手工 Home/授权流程和能力限制与当前代码一致，运行 `git diff --check`。

## 5. 工程验证与最终验收

- [x] 5.1 完成 T1/T2/T3 并记录工程证据（IP-05）；执行 implementation-plan 第 6 节的 Vitest、typecheck、lint、build、diff 检查，写入 evidence/checks.json，标明 mock 与未验证边界。
- [ ] 5.2 使用用户在向导选择的可用模型，在独立 main/cancel 轮次完成真实框架验收（IP-02–05）；运行 `pnpm lab:new`、`pnpm lab:new --profile cancel`、`pnpm lab open --run /abs/round`，手动进入 Home 初始化后运行 `pnpm lab collect --run /abs/round`，保存去秘密的 GitHub/Orca/doctor/采集证据。当前没有配置，此项未运行。
- [ ] 5.3 在获准固定最终实现 checkpoint 后完成 implementation-plan 第 8 节的独立限定审计并移交最终验收（IP-05）；核验 `git rev-parse HEAD`、Requirement/Scenario 证据矩阵和审计结论，缺证据不勾选。全项完成后才进入 verification artifact。
