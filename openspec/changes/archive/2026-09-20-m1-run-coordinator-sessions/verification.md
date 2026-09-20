# Verification

## 验收对象

- Change：`m1-run-coordinator-sessions`
- 输入实现 HEAD：`14b573fe256fa388ac2a47aecea945bcb9d0f942`（实现位于该 HEAD 上的未提交工作区）
- 最终验收 HEAD：`14b573fe256fa388ac2a47aecea945bcb9d0f942`（验收修复与随后的 D19 修复仍在同一未提交工作区）
- 验收 Agent：Codex（GPT-5）；D19 真实冒烟与随之修复由主 Agent 追加

## 结论

**PASS**。首轮验收的 BLOCKED 边界已由 D19 真实 MiniMax-M3 隔离冒烟补齐：在显式隔离工作区、专用身份与已安装 provider 集成下，13/13 用例通过，覆盖三个真实端点（Anthropic 兼容 `/v1/messages`、OpenAI 兼容 `/v1/chat/completions`、Responses `/v1/responses`）。

首轮验证发现的 Session 恢复、fencing、Wake 准入、原生上下文、tool calls 与配置绑定缺陷均已修复；20/20 项任务、10 个 Requirement、36 个 Scenario 及 IP-1～IP-10 的本地实现证据已核对，默认测试、静态检查、构建和 OpenSpec strict 校验全部通过。D19 冒烟另行暴露并修复 3 个只有真实 provider 才能触发的缺陷（见「D19 真实冒烟」），默认测试随之增至 236 passed。可以归档。

### Summary

| Dimension | Status |
|---|---|
| Completeness | 20/20 tasks；10 requirements；36 scenarios；IP-1～IP-10 均有实现与本地证据 |
| Correctness | 本地 236 tests passed；D19 真实 MiniMax-M3 13/13 通过（3 个端点）；默认运行时冒烟受控跳过 |
| Coherence | IC-03/IC-04、FLOW-02、D1～D19 的本地限定审计通过；`real-provider-smoke` 已由 D19 通过 |

### Open issues

- CRITICAL：无。
- WARNING：无。
- SUGGESTION：`package.json` 直接声明了源码与测试未引用的 `zod`；若确认只是 LangGraph 的间接依赖，可在独立依赖清理中移除。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 全部工件与任务 | `openspec status --change m1-run-coordinator-sessions --json`；`openspec instructions apply --change m1-run-coordinator-sessions --json` | 20/20 tasks；全部工件 done |
| OpenSpec strict | `openspec validate m1-run-coordinator-sessions --strict` | PASS |
| 类型、lint、构建、补丁格式 | `pnpm typecheck`；`pnpm lint`；`pnpm build`；`git diff --check` | PASS |
| 全部默认行为测试 | `pnpm test` | 23 files passed、1 file skipped；236 tests passed、2 skipped |
| IP-9 术语迁移 | `rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` | 无匹配，PASS |
| 前驱与主规格 | `openspec/changes/archive/2026-09-20-m1-persist-coordination-state/`；`openspec/specs/coordination/*` | 前驱已归档且主规格存在，PASS |
| IP-1 / Session identity | `src/domain/coordinator/session-state.ts`；`tests/domain/coordinator-session-state.test.ts` | Wake Batch 不能跨 Session；thread 映射与状态校验通过 |
| IP-2、IP-8 / durable recovery identity | `src/bootstrap/coordinator-runtime.ts:132` 复用 `resumeIncarnation`；`tests/bootstrap/coordinator-runtime.test.ts` | 曾运行但 checkpoint 缺失时 fail closed，PASS |
| IP-2、IP-6 / fencing generation | `src/workflow/coordinator/nodes.ts:152-273`；`tests/workflow/coordinator-graph.test.ts` | 模型调用和 checkpoint 写入紧前复核 fencing；迟到响应不提交，PASS |
| IP-3 / Wake admission | `src/application/coordinator/wake-admission.ts:107-204`；`tests/application/wake-admission.test.ts` | Scope/Session 绑定、先 checkpoint 后 admission、重复恢复去重，PASS |
| IP-4、IP-6 / no-work suspension | `src/workflow/coordinator/graph.ts:42-68`；`tests/workflow/coordinator-graph.test.ts` | 空 Actionable Work 零模型调用并直接 suspend，PASS |
| IP-5、IP-6 / context fail closed | `src/adapters/storage/checkpoint-store.ts:269-355`；`tests/adapters/checkpoint-store.test.ts` | 原生项损坏时 Session unrecoverable，Capsule 独立记录未损坏，PASS |
| IP-6 / opaque native window | `src/workflow/coordinator/context.ts:364-376`；`tests/workflow/context-maintenance.test.ts` | opaque 项以对象身份逐字进入 provider 输入，PASS |
| IP-1、IP-6 / complete model step | `src/workflow/coordinator/context.ts:58-173`；`tests/workflow/context-maintenance.test.ts` | tool calls 随完整响应持久化并还原，PASS |
| D15 / retry boundary | `src/workflow/coordinator/graph.ts`、`nodes.ts` | 只保留 model-call 有限重试；LangGraph node 不再重复配置同一策略，PASS |
| IP-7 / config switch | `src/application/coordinator/model-config-switch.ts:173-277`；`tests/application/model-config-switch.test.ts` | suspended gate、native migration、核验、配置绑定持久化及失败路径通过 |
| IP-7 / capability probe | `src/adapters/agents/capability-probe.ts`；`tests/adapters/capability-probe.test.ts` | 文本、流式首包超时、tool calling、取消、usage 均有证据，PASS |
| IP-10 默认安全边界 | 未配置三个显式 smoke 参数；`pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism` | 整文件受控跳过，无真实调用，PASS |
| D19 真实 MiniMax-M3 冒烟 | `COORDINATOR_SMOKE=1 COORDINATOR_SMOKE_REPO=<isolated-workspace> COORDINATOR_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism` | **PASS：13 tests passed**，含 3 个端点各 4 项行为；观测到真实 prompt cache 命中 |

### D19 真实冒烟（2026-09-20 19:29 追加）

- 隔离方式：一次性 `/tmp` 工作区，冒烟在其中为每个端点新建一次性 Git 项目；两个 store 按生产路径
  （`<git-common-dir>/orca-companion/{coordination,checkpoints}.sqlite`）落盘；探测身份
  `d19-smoke-final`；跑完自动删除一次性项目，工作区复原为空。
- 端点归一化（输入地址均不含 `v1`，按各家 SDK 的拼接规则补齐后的实际请求路径）：

  | Profile | 集成 | 实际请求 URL | 结果 |
  |---|---|---|---|
  | `anthropic` | `@langchain/anthropic#ChatAnthropic` | `https://api.minimax.cn/anthropic/v1/messages` | 4/4 PASS |
  | `openai` | `@langchain/openai#ChatOpenAI` | `https://api.minimax.cn/v1/chat/completions` | 4/4 PASS |
  | `openai-responses` | `@langchain/openai#ChatOpenAI`（`useResponsesApi: true`） | `https://api.minimax.cn/v1/responses` | 4/4 PASS |

  端点是否可用由环境变量决定：填了哪个端点就测哪个；`COORDINATOR_SMOKE_RESPONSES_BASE_URL` 未设置时
  回退到 `COORDINATOR_SMOKE_OPENAI_BASE_URL`，显式设为 `-` 可单独停用该端点。
- 每个端点覆盖 D19 的四个行为：suspend 结束模型 loop 而前台继续、缩短周期 keepalive 在有限 cycle 内
  停止、手动 compact 得到显式结论、Model Configuration 在重启后仍然生效。
- prompt cache 命中只写入观测输出，不参与任何断言或失败判定（本次三端点均观测到命中，
  cache read 128–512 token）。

#### D19 暴露并修复的缺陷（只有真实 provider 才能触发）

- provider 集成构造时丢弃 `model`：模块解析器只把 `modelOptions` 传给构造函数，模型名静默退回集成默认
  （OpenAI 集成即 `gpt-3.5-turbo`），provider 以 `unknown model` 拒绝；改为构造时显式并入 `model`。
- 系统内容被拆成多条消息：instructions、权威事实与派生 Capsule 各发一条 system，Anthropic 直接以
  `System messages are only permitted as the first passed message` 拒绝；改为合并成唯一前导 system 块，
  历史中出现的 system 消息同样上提。
- 节点消费 Actionable Work 却未告知模型：历史为空时请求只剩 system 消息，provider 以
  `messages must not be empty` / `chat content is empty` 拒绝；`buildMessages` 改为显式接收本次消费的
  work 并渲染为最后一条 user 消息。
- 冒烟自身：`model-config` 场景主动关闭 coordination store 后 `afterAll` 重复关闭导致
  `database is not open`；改为幂等关闭。
- 新增或修订对应回归测试；默认测试由 232 passed 增至 236 passed。

### 验收阶段完成的修复

- 在 model/suspend checkpoint 写入路径注入并复核当前 fencing，迟到 incarnation 不再提交状态。
- 启动装配统一复用 `resumeIncarnation`，删除重复且较弱的恢复判定。
- 空 Actionable Work 从 START 直接进入 suspend；移除重复的 LangGraph node retry policy。
- Native Compacted Window 的 opaque 项在实际模型输入中原样携带；损坏记录改为 fail closed。
- Committed Model Step 持久化并还原标准化 tool calls。
- Wake Batch 同时校验可信 Scope 与 Session 绑定。
- Coordinator Model Configuration 切换新增持久化绑定步骤，持久化失败不报告成功。
- streaming capability probe 对首个 chunk 应用超时，不再可能无限等待。
- 新增或修订对应回归测试；默认测试由首轮的 224 passed 增至 232 passed（D19 阶段进一步增至 236 passed，见下）。

## 限定审计

- 范围：`session-identity`、`maintenance-lane`、`wake-batch-id`、`fencing-generation`、`compaction-order`、`capsule-boundary`、`opaque-native-window`、`provider-injection`、`config-switch`、`real-provider-smoke`。
- 结论：全部通过；`real-provider-smoke` 由 D19 真实 MiniMax-M3 冒烟（13/13，3 个端点）补齐。
- 证据：delta specs、implementation-plan 第 6/8 节、上表源码与测试位置，以及完整门禁命令结果。

## 后续注意事项

- D19 冒烟需要显式输入：`COORDINATOR_SMOKE=1`、`COORDINATOR_SMOKE_REPO`（隔离工作区，必须为空）、
  `COORDINATOR_SMOKE_IDENTITY`（专用身份），端点与凭据来自 `.env.smoke`（已被 `.gitignore` 的
  `.env.*` 忽略）。未显式开启时整文件受控跳过。
- 仍未验证：真实 provider 的原生压缩路径（三个端点均以 `native: unavailable` 构造输入，Companion 目前
  不从 provider 响应探测原生压缩能力），以及 `compaction_degraded` / `context_exhausted` 的真实触发。
- 真实冒烟只覆盖本机 `api.minimax.cn`；其它区域或账号端点需另行确认。
- `package.json` 为 D19 冒烟新增了 `@langchain/anthropic` 与 `@langchain/openai` 两个 devDependency（运行时
  provider 集成仍由用户安装并经 bootstrap 注入）。
- Node.js `node:sqlite` 在当前运行中输出 ExperimentalWarning；不影响本地门禁结论。
