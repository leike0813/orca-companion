# Verification

## 验收对象

- Change：`remove-worker-credential-management`。
- 起草日期：2026-10-07，Ubuntu 本机。
- 输入实现 HEAD：未固定；对象为本次实施后的未提交工作区，规划基线为 `f445aee37dfe0a6514b569678754fde3481ee0fb`。
- 最终验收 HEAD：无；本次未提交代码。
- 验收 Agent：主对话 Agent，按用户要求直接复用实施上下文与已有证据起草，未委派独立验收 Agent。
- 权威输入：[proposal](proposal.md)、[design](design.md)、[implementation-plan](implementation-plan.md)、[tasks](tasks.md) 与本 change 的八份 delta specs。

## 结论

**PASS，限实施阶段已有证据覆盖的范围。** 本报告按用户明确要求起草，没有重新运行测试、探针、画面对照或独立代码审查，也不表示已对一个固定的实现 commit 完成独立验收。

Worker 凭据与原生 provider 配置管理已移除：角色配置只绑定 harness 与 `modelSelection`，启动继承 Harness 的真实环境，认证与登录态交由 Harness/Orca 管理；Companion 的 CredentialStore 只服务 Coordinator。原生模型目录、精确 Session 证明与恢复、只读包装器、原 Task 授权绑定及预算规则按既定边界保留。

| 维度 | 已有证据支持的结果 |
| --- | --- |
| 完整性 | 8/8 实施任务完成，IP-01–05 的代码、接线、界面、文档和 fixtures 已落实。 |
| 正确性 | 实施阶段最终全量测试 2087 项通过、16 项条件跳过；类型、lint、构建与严格 OpenSpec 检查通过。 |
| 一致性 | D-01–04 的模型选择分离、原生环境、精确会话/只读边界、目录与 TUI 设计已落实；六项限定审计结果已登记。 |

真实 Orca 角色 Session、真实恢复与隔离端到端矩阵本轮未运行，记为 **SKIP**；不能以历史矩阵或本地模型目录查询将其计为 PASS。现有证据也不证明模型网络调用或鉴权成功。

## 核验与修复证据

以下结果均来自实施阶段，不是本次起草重新执行的检查。持久化汇总见 [checks.json](evidence/checks.json) 与 [实施结果](implementation-plan.md#9-实施结果)。

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| IP-01；不可变模型设置、逐角色 harness、可信目录来源、旧 schema/Manifest 拒绝 | `tests/configuration/**`、`tests/domain/execution-authorization.test.ts`；`model-configuration.ts`、`project-config.ts`、`model-settings.ts` | Worker 保存零凭据访问，严格拒绝连接/秘密/options 字段；schema4 / Manifest4，追加 profile 与 CAS，手填无 effort，伪造来源拒绝。相关检查通过。 |
| IP-02；显式 WorkerHarness 注册表、无凭据启动、精确绑定/恢复 | `tests/adapters/agents/**`、`tests/application/worker-harness-registry.test.ts`；共享 launcher、native/OpenCode/Codex adapters | 五个注册项使用原生环境与逐次模型参数；按精确报告、transcript、cwd、窗口和实际 roots 证明身份，恢复核验原 root。相关检查通过。 |
| IP-02；原生模型目录有界、可取消，失败允许手填 | `tests/adapters/agents/worker-model-catalog.test.ts`、`tests/process-runner.test.ts`；本机原生无 prompt 查询 | 总时限30秒，最多4096项、1 MiB/20000行；取消、超限、不可识别及空目录返回不可用，effort 只取实际能力。目录与 runner 专项22项通过。 |
| IP-02；只读能力由实际执行证明、生产与探针共用包装器 | wrapper/launch 既有测试；五项生产 launcher/bwrap 哨兵探针 | 五项均为 `available / host-verify`；输入可读，workspace/Git/协调库拒写，精确状态及工件可写。路径重叠与无法证明的边界拒绝。 |
| IP-03；批准模型绑定、原 Task 重试/恢复、Recovery Capsule、Finalizer、doctor | `pnpm exec vitest run tests/bootstrap --maxWorkers 2`；恢复与集成专项 | Bootstrap 17文件/169项通过；恢复与集成专项20项通过。Worker 接线只传 modelSelection，原授权与预算不变，集成恢复读取原报告的实际 root。 |
| IP-04；角色模型/独立 effort、Coordinator 表单、目录取消与返回 | `tests/tui/model-settings.test.tsx`、`tests/tui/host-wiring.test.ts`、`tests/tui/session-lifecycle.test.tsx`；[界面证据](evidence/README.md) | Worker 连接/凭据表单移除，Coordinator 表单保留；切换 harness、中文手填、查询取消与迟到处理通过。三档尺寸、12种颜色/图标组合、resize、完整授权审阅和返回草稿/光标检查通过。 |
| IP-05；当前领域/架构/合同/约束、preview 与 acceptance fixtures | AGENTS、CONTEXT、README、architecture、interface-contracts、compatibility、TUI handoff 与相关 fixtures | 当前边界已同步；历史记录与用户原有未提交文件保留，不修改上游、依赖或 lockfile。 |

实施阶段最终命令结果：

| 命令 | 已记录结果 |
| --- | --- |
| `pnpm typecheck` | exit0 |
| `pnpm lint` | exit0 |
| `pnpm build` | exit0 |
| `pnpm test --maxWorkers 6 --reporter=default --reporter=json --outputFile.json=/tmp/companion-stable-test-results.json` | exit0；183文件通过、7文件条件跳过；2087项通过、16项条件跳过，共2103项，耗时410.29秒。 |
| `openspec validate remove-worker-credential-management --strict` | exit0 |
| `git diff --check` | exit0 |

本机原生目录检查：

| Harness | 版本 | 已记录结果 |
| --- | --- | --- |
| Codex | 0.160.0 | 14项 |
| Claude | 2.1.291 | 4项 |
| OpenCode | 2.0.21 | 退出码0、输出为空；正确返回 `catalog_empty`，可手填未验证 exact ID。 |
| pi | 1.0.0 | 521项 |
| OMP | 18.4.10 | 913项 |

验收阶段修复：**无**，本次仅起草报告。实施阶段的关键修复为共享目录查询开始时使旧缓存失效，避免取消刷新后继续接受旧来源；新增 host-wiring 检查及最终全量检查已通过。集成恢复读取实际 native root、重规划恢复保留 Manifest 版本，以及三档模型菜单高度/返回行为的修正已包含于最终实现和证据。

## 限定审计

本节复用 [implementation-plan 第九节](implementation-plan.md#9-实施结果) 的六项实施审计，不声称本次重新审计。

| 范围 | 已记录结论与依据 |
| --- | --- |
| zero-worker-credential | Worker port、launcher、目录查询与角色保存均不接收/读取 CredentialStore；配置测试核验零调用，host-wiring 核验手填不创建凭据文件。Coordinator 解析保留。 |
| native-env | descriptor2 继承真实 process.env；report 只含非秘密路径；无原生认证复制、链接、provider 配置写入或 HOME/XDG/认证覆盖。 |
| exact-session | Session 身份由精确报告及 transcript 共同证明，resume 核验原 root，不按最新文件或终端输出猜测；adapter 与恢复测试覆盖。 |
| readonly-overlap | realpath 后检查 native writable roots 与仓库/Git/common dir/协调状态的重叠；OpenCode 外部 DB 路径进入边界，无法证明即不可用。测试与五项本机哨兵通过。 |
| original-task-binding | dispatchProfileFor/pinnedProfileFor 及 Retry、恢复、Finalizer、集成沿原 Task 授权/profile 读取；不退回当前默认配置，不重置预算。 |
| catalog-provenance | 只接受当前未取消查询的目录来源及能力；查询开始使旧缓存失效，迟到结果不能恢复缓存；手填 model 的来源与 effort 均为 null。 |

已有上下文未记录未解决的 CRITICAL 实现问题；本次没有进行新的独立审查，不能据此声明不存在其他缺陷。

## 后续注意事项

- 项目 schema4、Manifest4 与 launcher descriptor2 是有意的 breaking change。旧格式明确拒绝，不自动迁移或清理凭据；Coordinator 凭据文件及引用格式不变。
- OpenCode 本机目录为空属于已处理的不可用状态，不保证手填模型可成功鉴权或运行。
- 真实 Orca 角色启动、恢复及端到端矩阵保留为未运行项；未来需要这些结论时，在显式隔离项目与专用身份中执行对应验收。
- 本报告只适用于已登记证据对应的实现工作区，不是固定 commit 的独立验收证明。尚未提交、同步主规格或归档；Ubuntu 以外的平台不在本轮证据范围。
