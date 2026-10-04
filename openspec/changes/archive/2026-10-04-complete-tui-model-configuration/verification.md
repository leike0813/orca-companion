# Verification

## 验收对象

- Change：`complete-tui-model-configuration`
- 输入实现 HEAD：`8f6d1a7e6765a024191043b97fbded2d4a902207`
- 最终验收 HEAD：`8f6d1a7e6765a024191043b97fbded2d4a902207`
- 验收 Agent：本次独立 Codex 验收
- 工作区：实现保持未提交；验收仅新增本文件。既有 `README.md` 与 `artifacts/pending-interactions/README.md` dirty 内容保留。

## 结论

**PASS**，适用于本 change 的固定 HEAD 与当前工作区实现。任务清单 13/13 完成；五份 delta spec 的所有 Requirement/Scenario 及 IP-01–07 均有实现和证据。结论限于当前 Ubuntu 验证范围，不表示 Windows、其他 provider/角色的真实集成或未执行的条件跳过路径已验证。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| Immutable versioned model settings；保存与应用独立；冲突和文件失败保留输入；IP-01/02 | 最终受影响检查覆盖 `tests/bootstrap/project-config.test.ts` 与 `tests/configuration`；typecheck、lint、build checkpoint | schema v2、不可变引用、revision CAS、保存不应用及失败保留输入均通过；旧格式/不可信引用和 effort 按实现拒绝。 |
| User credential store with isolated secrets；先存凭据再存引用；缺失凭据和并发写入；IP-02 | 最终受影响检查及实现记录中的凭据存储审计；`/tmp/companion-model-connection-host.log`（7 passed） | 临时 XDG 凭据文件验证新 managed key 应用到最新连接且旧历史保留；权限、锁、CAS、原子替换和安全拒绝路径有测试覆盖。秘密审计未发现未决问题。 |
| Coordinator Model Configuration injects a verified installed chat model；五个 Scenario；IP-03 | 最终受影响检查包含 foreground planning runtime；`/tmp/companion-model-typecheck-checkpoint.log`、`/tmp/companion-model-lint-checkpoint.log`、`/tmp/companion-model-build-checkpoint.log`；`artifacts/model-configuration/real-startup.json` | provider 由安装集成解析，无 allowlist/fallback；凭据和 effort 在完整能力核验后绑定。隔离真实启动的 SessionStart/transcript 与固定模型、low effort、身份及认证路径一致，记录不含 key。 |
| Model-bound authorization and explicit model reapproval；重新批准生效于新任务；陈旧审阅或重复批准；IP-04 | `tests/application/authorization-service.test.ts`、`tests/bootstrap/execution-authorization.test.ts`、`tests/coordination-store.test.ts`（最终 full/affected 证据）；CodeGraph 核验 `approveExecutionAuthorization`、`recordModelReauthorization` | 完整 Manifest 指纹与 Scope revision CAS 产生追加授权；只改模型绑定，保留 generation、Run、权限、限额和预算。陈旧输入拒绝；相同载荷重放只回读原记录，不重复授权或派发；replanning、cancelling、未决 intent fail closed。 |
| Materialized tasks retain exact model authorization；老任务结果和重试；unknown 和重启；IP-05 | `tests/application/materialize-work-package.test.ts`、`tests/application/advance-execution.test.ts`、`tests/bootstrap/execution-delivery.test.ts`、`tests/recovery`、`tests/bootstrap/foreground-execution-runtime.test.ts`；CodeGraph 核验 `dispatchProfileFor`、`pinnedAuthorizationOf`、`resolveLocator` | 新 Task 固定授权 ID/version/profile；retry、Validator 修复/替代 Session、settlement 和 recovery 沿原 binding。Utility 使用创建时独立 profile。身份、scope/run/generation/contract/attempt 或绑定缺失时阻塞；unknown 沿原 OperationId 对账，不重派。 |
| Approved role model settings and independent effort；四个 Scenario；IP-06 | 最终受影响检查 37 files / 340 passed / 2 skipped；`/tmp/companion-model-latest-candidate.log`（3 files / 58 passed）；`/tmp/companion-model-connection-host.log`（7 passed）；`artifacts/model-configuration/release/` | 候选按 provider/model 去重并保留最新连接；应用选择该可见引用，effort 独立且受可信能力约束。当前 Coordinator/Worker 代表配置映射正确。默认返回、编辑保留、遮罩、显式保存/应用/批准与迟到结果归属通过；render/resize 不触发业务副作用。 |
| Codex launch resolves the approved model binding；实际进程配置一致；只读探针与正式启动一致；IP-03/05/07 | Codex launcher/read-only probe 行为检查、最终 affected 检查、`artifacts/model-configuration/real-startup.json` | managed key 只经子进程环境解析，Harness login 沿原认证且拒绝覆盖为新 managed key；公开 argv/terminal 描述符不含秘密。只读探针与正式启动共用配置 launcher，保留 read-only sandbox。 |
| 三档生产画面对照；六票原型一致性；文档与验收合同；IP-07 | `artifacts/model-configuration/README.md`、`artifacts/model-configuration/release/samples.json`、`checks.json`；`node scripts/tui-preview.mjs --help`；checkpoint 中 `openspec validate complete-tui-model-configuration --strict`、`git diff --check` | 已直接核对六票代表图片及来源；release 有 171 对 PNG/文本及 12 组操作，覆盖三档、颜色/图标与 resize。真实启动及所有要求证据在限定范围内齐备。 |

**验证汇总。** 固定 checkpoint 的静态 typecheck、lint、build、strict OpenSpec、`git diff --check` 和 preview help 均通过。最终受影响命令为 `pnpm exec vitest run tests/tui tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/execution-finalizer.test.ts tests/bootstrap/project-config.test.ts tests/configuration --maxWorkers 4 --reporter=default --reporter=json --outputFile.json=/tmp/companion-model-affected-final.json`，结果 37 files、340 passed、2 条件跳过；普通真实 PTY 13 项通过。最新候选 TUI 复验 58 passed，隔离 managed-key host 回归 7 passed。

全量命令 `/tmp/companion-model-final-tests.log` 的原始结果为 **156 files passed、1 failed、6 skipped；1650 passed、2 failed、12 skipped，exit 1**。两项失败来自运行期间文件已载入旧 dedupe 实现、断言已更新的单个 model-settings 文件；冻结代码后的 affected 检查覆盖该文件并全通过。按完整文件名以 affected 检查替换 full 中重叠文件并去重后，最终口径为 **163 distinct files、1653 passed、12 条件跳过、0 failed**。原始 full exit 1 保留，不记作通过；本验收未重复运行 full，也未另跑用例。

验收阶段修复：无。实现阶段已记录的修复与审计结果见 `implementation-plan.md` §9；本验收未改 product 或 planning 文件。

## 限定审计

已完成实现计划要求的秘密传播、CredentialStore/project CAS 与原子保存、模型-only reapproval policy、Task 授权/profile pin 与 generation/attempt 结算、TUI render 无副作用和异步迟到归属，以及六票画面对照审计。独立确认最新候选对同 provider/model 保留最新连接，宿主提交该连接的最新不可变引用且保留当前可用 effort。未发现未决缺陷。审计使用固定 checkpoint 源码、CodeGraph 精确符号路径、既有行为测试/日志及已保存证据；未读取真实 key，未访问或修改 `references/orca`。

## 后续注意事项

真实启动证据仅覆盖记录中的隔离 Orca/Codex 与 MiniMax 配置；其他 provider、角色及恢复路径的真实集成不在该证据范围。Windows 与新增 OS 输入法预编辑行为未验证。12 项条件跳过保持为跳过，不计入通过。
