## Why

M1 需要真正可恢复的 Coordinator Agent 宿主：仓库当前只有 M0 的 Orca 控制基线与固定契约，`src/workflow/` 仍是占位目录，模型 loop、Coordinator Session 与上下文维护都没有实现。缺这一层，Route Planning、Execution Coordination 与 TUI 都没有可挂载的运行时。

## What Changes

- 新增 Coordinator Session 运行时：每个 Session 独占一个 checkpoint 线程，LangGraph StateGraph 承载模型循环，checkpoint 耐久度为同步写入，checkpoint store 与前驱的 Branch Coordination Store 分离。
- 新增单写者与恢复约束：Runtime Lease 与递增 fencing generation 复用前驱的 CAS 接缝，迟到进程不得写入 checkpoint 或执行副作用；checkpoint 不可恢复时 fail closed。
- 新增 suspend / resume 闭环与维护 lane：模型 loop 结束后前台 Controller 与确定性对账继续运行；挂起期间可在 lease 与 fencing 保护下执行 best-effort keepalive，受有限 maintenance cycle 约束，被 Actionable Work 抢占，并在 Pause/Cancel 时停止。
- 新增上下文维护：provider-native 压缩优先，Context Capsule 回退，必要时一次机械 Shake；无法收敛时以显式 `compaction_degraded` 或 `context_exhausted` 结束。checkpoint 分开保存 Native Compacted Window owner metadata 与可移植 Capsule，system/project instructions、tool schema 与最新权威事实按当前配置重新注入。
- 新增 Coordinator Model Configuration 注入、启动前能力核验与运行中切换：只在 Session suspended 且无模型相关操作在途时切换，切换前持久化 checkpoint 并清空旧 cache 与 maintenance 计划，不兼容 native window 先迁移 Capsule，不自动 fallback。
- 术语迁移：本 change 统一采用 Canonical 术语 Coordinator Model Configuration；`CONTEXT.md` 与 `AGENTS.md` 中现有的 Coordinator Profile 属于待迁移术语，二者的术语同步纳入 apply 阶段文件范围，但不在本 change 的起草阶段编辑。
- 不在本 change 内实现：TUI 与 CLI 交互界面、Worker 派发与生命周期、Route Planning 语义操作、Execution Graph 编译与授权、验证与归档。

## Capabilities

### New Capabilities

- `coordinator/session-runtime`: Coordinator Session 的模型 loop 宿主、checkpoint 归属、单写者运行时与恢复身份。
- `coordinator/wake-suspension`: 可恢复挂起、best-effort 维护 lane、Actionable Work 投影与 Wake Batch 恢复准入。
- `coordinator/context-maintenance`: 有界模型输入的派生视图、原生压缩优先与降级路径、原生窗口与 Capsule 的分离归属、上下文故障关闭。
- `coordinator/model-configuration`: Coordinator Model Configuration 到 chat model 的注入、启动前能力核验与运行中切换约束。

### Modified Capabilities

无。`openspec/specs/` 当前为空，本 change 只新增 capability，不修改既有需求。

## Impact

- 代码：`src/workflow/`、`src/application/`、`src/adapters/storage/`、`src/adapters/agents/`、`src/interfaces/cli/`、`src/bootstrap/`。扩展 M0 的单一 `doctor` 命令，不创建第二个 doctor 入口。
- 术语：apply 阶段需同步 `CONTEXT.md` 与 `AGENTS.md` 中的 Coordinator Profile 术语为 Coordinator Model Configuration；本 change 不修改这两个文档的其它内容。
- 依赖：只新增 LangGraph 及其 SQLite checkpointer；边界 DTO 延续 M0 的窄校验器约定，不为此再引入 schema 依赖。
- 事实源：不新增业务权威。Session checkpoint 只保存对话与 loop 进度；Wake Batch source admission 作为跨库补齐所需的共享协调事实，通过前驱 schema migration 写入 Branch Coordination Store。
- 不改变：Orca CLI adapter、Worker Harness adapter、Route Map 与 Execution Graph 语义、TUI。
