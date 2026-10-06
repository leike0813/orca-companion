## Context

基线为已归档 add-worker-harness-adapters，当前 HEAD f445aee37dfe0a6514b569678754fde3481ee0fb。现有 Worker 与 Coordinator 共用 ProviderConnection/CredentialStore，并复制原生配置与登录态；用户明确要求 Worker 认证归还 harness。领域术语沿 CONTEXT.md，owner 沿 IC-05/09/14。

## Goals / Non-Goals

目标：删除 Worker 凭据与 provider 配置管理；原生模型目录、逐角色选择、精确 Session 恢复和严格只读继续可用。
范围外：凭据迁移或清理、Coordinator 认证重设计、SQLite 迁移、Orca 私有接口、依赖变更、Git 提交、无授权真实项目调度。

## Decisions

### D-01 模型选择与 Coordinator 分离

WorkerModelSelection 为严格对象 `{model, effort, effortCapability, catalogSource}`；capability 为 `{values,source}` 或 null。非空 capability 要求目录来源，非空 effort 要求实际 capability 中的取值；手填 native selector 来源为 null，effort 为 null。WorkerProfile 使用 modelSelection，不含连接、modelRef、options 或 credentialRef。ProviderConnection 删除 codex/nativeWorker，Coordinator 原有 credential（包括 provider 自身环境认证的 harness_login）和 SDK effort optionPath 保持。

项目 schema4、Manifest4；旧版本拒绝，不迁移、不清理用户密钥。Worker 保存只追加 profile/ref，通过既有项目 CAS，零 CredentialStore 访问。输入为按 role 判别联合，Worker 额外连接/秘密/options 字段明确拒绝。同步 verifyWorkerSelection 回调仅核验本次显式查询的有界缓存；输入来源与能力必须匹配，不能伪造。

### D-02 原生环境与启动

WorkerHarness 输入删除 CredentialStore/path，modelSelection 替换 modelConfiguration。stateRoot 仅为 Companion 工件。共享 launcher v2 只保存 executable/args/harness、可选 readOnly、runtimeReportPath 与恢复 expectedStateRoot；继承真实终端 process.env，不覆盖 HOME/XDG/认证/provider。恢复 expectedStateRoot 只核验，不能改变环境。

Codex --no-daemon、inline -c hooks；Claude --settings 只叠加 reporter/security 并保留原生 settings sources；pi/omp 原生 --model provider/id 与 extension；OpenCode --standalone 公开 API 的 Session 创建在真实启动子进程完成。认证配置、登录文件和 provider endpoint 均由原生 harness 拥有，不增加替代管理器。

### D-03 精确会话与只读

worker-runtime 在真实启动环境解析非秘密 native roots；reporter 报告精确 session/transcript/cwd/时间与实际 roots。proof 核验 path containment、ID/header/cwd/窗口，不将工件目录当 native root，也不猜 latest。恢复从原精确 report 与 Task binding 取身份。

所有只读角色经共享 bwrap，根文件系统只读，实际 native 所需状态目录与精确 Companion 工件可写；Git/common dir/仓库/协调库拒写。可写根与受保护路径重叠、根不可证明或包装器失败即 unavailable，不降低权限。探针复用生产 launcher，哨兵读/拒写/回读及 harness 可执行版本共同证明边界。

### D-04 目录与 TUI

WorkerHarness.queryModels({cwd,signal?,env?}) 与 ModelCatalogPort.queryWorkerModels({harness,signal?}) 返回有界非秘密 `{kind:'available',source,models:[{model,effortCapability}]}` 或 unavailable。adapter 用原生公开命令/protocol，不发送 prompt；使用既有有界 process-runner，Claude 可增加有界 stdin。原生目录失败允许未验证手填 selector，effort 不虚构。

沿 #52 final 的三组角色、候选、独立 effort、默认返回和显式应用。Worker 编辑只含 harness/native model，Coordinator 原表单保留。迟到查询按原入口/generation 归属，可取消。当前绑定来自批准 Manifest；保存不改 Session/Task/预算，应用仍完整重新审阅。

## Risks / Trade-offs

原生版本与当前环境能力可能不同，查询/只读/精确绑定失败明确呈现；不会因版本号可读而声称模型鉴权已成功。拒绝 schema3 和 Manifest3 是有意 breaking change。目录查询 provenance 只证明原生候选与能力，不承诺模型网络调用成功。孤儿凭据保留。

## Migration Plan

不自动迁移；用户按 schema4 重建 Worker profiles，原有记录保留且无法作为 v4 授权运行。Coordinator 凭据文件格式与引用不变。

## Open Questions

无阻塞问题。
