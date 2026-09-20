# Spec Kit: workflow, artifact model, and machine-readable contract

调查对象：`github/spec-kit`。事实基线为官方仓库 `main` 分支与最新 release **v1.0.8**
(2026-09-17, https://github.com/github/spec-kit/releases/tag/v1.0.8)；仓库内 CLI 版本号为
`1.0.9.dev0`（[`pyproject.toml`](https://github.com/github/spec-kit/blob/main/pyproject.toml)）。
只使用官方仓库、官方文档与源码。

本文是**事实记录**：逐项给出官方来源，并明确标注哪些能力在 Spec Kit 中**并不存在**，或仅为
prompt/模板约定（不对应任何可校验的机器可读契约）。

## 1. 官方 workflow：三条独立入口

Spec Kit 提供三条**互相独立**的流程入口，不是三个阶段：
Spec-Driven Development（SDD，核心内置）、Bug fixing（扩展）、Idea assessment（扩展）。
来源：[`README.md`](https://github.com/github/spec-kit/blob/main/README.md)。

SDD 的官方顺序为
`constitution → specify → clarify → plan → checklist → tasks → analyze → implement → converge`。
其中 only `/speckit.specify` 是 `/speckit.plan` 前的强制前置，其余为可选质量门。
来源：[`docs/reference/agentic-sdd.md`](https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md)。

`/speckit.*` 命令实为 **agent skill / slash command**，由 coding agent 在会话内逐个调用，
不是终端命令。不同集成使用不同调用语法（`/speckit-*`、`$speckit-*`、`/skill:speckit-*`）。
来源：同页 “Command invocation” 提示，以及
[`docs/reference/integrations.md`](https://github.com/github/spec-kit/blob/main/docs/reference/integrations.md)。

## 2. Artifact 模型

### 2.1 Feature 级产物（每个 feature 一个目录）

官方模板把 feature 目录固定为：

```text
specs/[###-feature]/
├── plan.md              # /speckit.plan 输出
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出
└── tasks.md             # /speckit.tasks 输出（不是 plan 生成）
```

来源：[`templates/plan-template.md`](https://github.com/github/spec-kit/blob/main/templates/plan-template.md)
“Project Structure / Documentation” 段。

路径解析由脚本负责，不靠约定猜测。`FeaturePaths` 明确给出
`spec.md / plan.md / tasks.md / research.md / data-model.md / quickstart.md / contracts/`。
来源：[`scripts/python/common.py`](https://github.com/github/spec-kit/blob/main/scripts/python/common.py)
（`@dataclass FeaturePaths`、`get_feature_paths`）。

当前 feature 的指针存于 `.specify/feature.json` 的 `feature_directory` 字段。
来源：同上 `read_feature_json_feature_directory` / `persist_feature_json`，以及
[`docs/reference/core.md`](https://github.com/github/spec-kit/blob/main/docs/reference/core.md)
对 `SPECIFY_FEATURE_DIRECTORY` 的说明。

### 2.2 Toolkit 级 artifact（与 feature 产物不同的一层）

Spec Kit 另有一套名为 **artifact** 的概念，指“Spec Kit 暴露给项目的任何命令、模板、脚本或 hook”，
来自内置资产、preset、extension 或项目级 override。这是对**工具链自身**的清单，与 `specs/` 下的
feature 产物没有关系。来源：
[`docs/reference/artifacts.md`](https://github.com/github/spec-kit/blob/main/docs/reference/artifacts.md)。

### 2.3 存在的机器可读接口

| 接口 | 形态 | 作用范围 |
| --- | --- | --- |
| `specify artifact list --json` / `specify artifact info <name> --json` | JSON 数组 / 对象 | 工具链 artifact 清单与 composition stack |
| `scripts/python/check_prerequisites.py --json` | 单行 JSON | 解析 `FEATURE_DIR` 与 `AVAILABLE_DOCS` |
| `scripts/python/setup_tasks.py --json` | 单行 JSON | 追加返回 `TASKS_TEMPLATE`、`TASKS_TEMPLATE_CONTENT` |
| `scripts/python/setup_plan.py` 等 | 同构 | feature 目录与模板解析 |
| `specify workflow run/status --json` | JSON 对象 | workflow run 状态（见 §6） |

`artifact` 子命令**强制要求 `--json`**：省略时退出码 2 并在 stderr 输出用法，不产生 stdout。
失败时 stdout 为空，stderr 输出单键 JSON 信封（如 `{"error": "unknown artifact command:nope"}`），
退出码 1；退出码 2 保留给用法错误。来源：`docs/reference/artifacts.md`。

JSON 字段契约见 `docs/reference/artifacts.md` 的字段表与
[`src/specify_cli/artifacts/models.py`](https://github.com/github/spec-kit/blob/main/src/specify_cli/artifacts/models.py)
（`Artifact`、`StackLayer`、`HookArtifact`）。

`check_prerequisites.py` 的 JSON 面很小，只有 `FEATURE_DIR` 和 `AVAILABLE_DOCS`（可选
`TEMPLATE_CONTENT`）；`AVAILABLE_DOCS` 是 `research.md`、`data-model.md`、`contracts/`、
`quickstart.md` 以及按 flag 加入的 `tasks.md` 的存在性列表。并非任务或需求的机器可读投影。
来源：[`scripts/python/check_prerequisites.py`](https://github.com/github/spec-kit/blob/main/scripts/python/check_prerequisites.py)
（`_available_docs`、`main`）。

### 2.4 不存在的机器可读 schema

- `spec.md`、`plan.md`、`tasks.md` 都是 **Markdown**，没有 JSON Schema、没有 IDL、没有
  可解析的结构化定义。仓库内所有 `schema` 相关代码只服务于 workflow overlay 与 catalog
  （`src/specify_cli/workflows/overlays/schema.py`、`tests/contract/test_catalog_schema.py`）。
- `spec.md` 模板中的 `**Status**: Draft` 是模板默认文本；源码树中没有任何代码写入或更新该字段。
  它是 prompt 约定，不是受维护的状态机。
- `tasks.md` 的格式（`- [ ] T001 [P] [US1] description with path`）由 `/speckit.tasks` 命令模板
  用文字规定，并由测试**以字符串断言**方式守护（见
  [`tests/test_tasks_template_constraints.py`](https://github.com/github/spec-kit/blob/main/tests/test_tasks_template_constraints.py)）。
  没有解析器、没有 JSON schema、没有可复用类型。

## 3. Implementation agent 实际消费什么

`/speckit.implement` 的 frontmatter 声明前置脚本：

```yaml
scripts:
  py: scripts/python/check_prerequisites.py --json --require-tasks --include-tasks
```

来源：[`templates/commands/implement.md`](https://github.com/github/spec-kit/blob/main/templates/commands/implement.md)。

其 Outline 明确列出读取清单（按需，不存在的跳过）：

- **REQUIRED** `tasks.md`
- **REQUIRED** `plan.md`
- **IF EXISTS** `data-model.md`、`contracts/`、`research.md`、`/memory/constitution.md`、`quickstart.md`

来源：同文件 “3. Load and analyze the implementation context”。

也就是说：**机器可读输入只有脚本返回的路径与文档存在性**；真正的执行语义全部来自 agent
阅读这些 Markdown。`/speckit.tasks` 模板要求 “each task must be specific enough that an LLM can
complete it without additional context”，这是**自然语言目标**，没有对应的校验器。

`/speckit.converge` 同样只读 `spec.md`、`plan.md`、`tasks.md` 与 constitution
（[`templates/commands/converge.md`](https://github.com/github/spec-kit/blob/main/templates/commands/converge.md)）。
`/speckit.analyze` 是只读的跨产物一致性分析，产出报告，不写文件
（[`templates/commands/analyze.md`](https://github.com/github/spec-kit/blob/main/templates/commands/analyze.md)）。

## 4. spec / plan / tasks 的关联方式

关联**完全靠 Markdown 内的命名约定与建议性文字**，没有外键、没有 ID 解析器：

| 关联 | 机制 | 是否机器可校验 |
| --- | --- | --- |
| user story 编号 | `spec.md` 中 `### User Story N` + `(Priority: P1)` | 文本约定 |
| 任务 → story | `tasks.md` 中的 `[US1]`、`[US2]` 标签 | 文本约定 |
| 需求编号 | `spec.md` 中 `FR-001`、`SC-001` | 文本约定 |
| 任务编号 | `T001` 顺序编号（执行顺序） | 文本约定 |
| 任务依赖 | 相位顺序（Setup → Foundational → 各 story → Polish），以及正文里的 `depends on T012` | 文本约定 |
| 并行性 | `[P]` 标记（“different files, no dependencies”） | 文本约定 |

来源：[`templates/spec-template.md`](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)、
[`templates/tasks-template.md`](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md)、
[`templates/commands/tasks.md`](https://github.com/github/spec-kit/blob/main/templates/commands/tasks.md)
“Checklist Format (REQUIRED)” 与 “Task Organization”。

模板明确写 “**Format validation**” 与 “DO NOT keep these sample tasks”，但这是给 agent 的指令，
不是程序化校验。`/speckit.analyze` 会做跨产物一致性检查，但它**只报告、不修改**，且判定由模型完成。

`tasks.md` 相位结构（模板 + 命令模板一致）：

```text
Phase 1: Setup
Phase 2: Foundational (BLOCKS all user stories)
Phase 3..N: User Story 1..N（按 P1/P2/P3 优先级）
Final Phase: Polish & Cross-Cutting
```

`/speckit.converge` 只允许**追加** `## Phase N: Convergence` 段，不得改写、重编号、重排或删除
既有任务；当代码已满足时 `tasks.md` 必须字节级不变。新任务 ID 由
`T{M+1:03d}` 形式生成（M 为现有最大编号，三位是下限而非上限）。来源：
`templates/commands/converge.md` “Operating Constraints”，以及
`templates/commands/taskstoissues.md` 对 `T\d{3,}` 的说明。

## 5. 验收证据：存在形式，但只在一处且非结构化

**SDD 流程本身没有独立的验收证据产物。** `spec.md` 有 `Success Criteria`、`Acceptance Scenarios`；
`checklists/requirements.md` 是需求质量清单，其模板显式声明
“`[x]` means the criterion has been reviewed and satisfied for requirements quality. It does not
mean implementation work is complete.” 来源：
[`templates/checklist-template.md`](https://github.com/github/spec-kit/blob/main/templates/checklist-template.md)。

`/speckit.implement` 把 checklist 勾选状态当**只读门禁**：统计 checked/unchecked，有未勾选项时
停下来询问，且**不得修改 marker**。来源：`templates/commands/implement.md` 第 2 步。

唯一带结构化证据表的是 **bug extension**：`/speckit.bug-test` 要求写
`.specify/bugs/<slug>/test.md`，含 `Checks Performed` 表格（Check / Command / Result / Notes）、
`Output Excerpts`、`Residual Risks`，并以 `Result: verified | partial | failed` 结案。来源：
[`extensions/bug/commands/speckit.bug.test.md`](https://github.com/github/spec-kit/blob/main/extensions/bug/commands/speckit.bug.test.md)。
同页明确“该命令不得修改源码”。

该结构仅由命令模板文字规定，同样**没有 schema 或解析器**；`verified/partial/failed`
不是被程序消费的枚举。

## 6. 状态与外部 orchestration 接口

### 6.1 Workflow 引擎（真实存在的机器接口，但粒度是命令级）

`specify workflow` 提供可运行的编排层：

- `specify workflow run <source> [--input k=v] [--json]`
- `specify workflow resume <run_id> [--input k=v] [--json]`
- `specify workflow status [<run_id>] [--json]`
- `specify workflow list` / `add`

`--json` 输出的 run 状态形态：

```json
{
  "run_id": "662bf791",
  "workflow_id": "build-and-review",
  "status": "paused",
  "current_step_id": "review",
  "current_step_index": 0
}
```

run 状态枚举：`created`、`running`、`completed`、`paused`、`failed`、`aborted`。失败/中止时
payload 增加 `error` 字段。状态持久化在 run 的 `state.json`，并可由
`specify workflow status <run_id> --json` 事后读取。`--json` 模式下进度输出重定向到 stderr，
stdout 只承载该 JSON 对象。来源：
[`docs/reference/workflows.md`](https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md)。

内置 workflow 只有一条：`Full SDD Cycle`（`speckit`），步骤为
`specify → gate(review-spec) → plan → gate(review-plan) → tasks → implement`；
gate 的 `on_reject: abort`。来源：
[`workflows/speckit/workflow.yml`](https://github.com/github/spec-kit/blob/main/workflows/speckit/workflow.yml)。

step 类型由源码定义：`command`、`prompt`、`shell`、`gate`、`if_then`、`switch`、`fan_out`、
`fan_in`、`do_while`、`while_loop`、`slot`、`init`（对应
`src/specify_cli/workflows/steps/` 下的各子包）。

重要边界：该接口的粒度是**命令/步骤**，不是任务。`tasks.md` 里的 `T001...` 不是 workflow step，
`current_step_id` 指的是 YAML 中的 step id。没有任何接口按 task id 查询状态。

### 6.2 唯一带任务 ID 的外部系统集成

`/speckit.taskstoissues` 把 `tasks.md` 转成 GitHub issues：前置要求 GitHub `origin` remote 与
GitHub MCP server 工具（frontmatter 中声明
`tools: ['github/github-mcp-server/list_issues', 'github/github-mcp-server/issue_write']`）。
标题规范为 `T001: <description>`；先用 `list_issues`（不带 `state`，`perPage: 100`，游标翻页）
按 `\bT\d{3,}\b` 去重，再创建缺失项。来源：
[`templates/commands/taskstoissues.md`](https://github.com/github/spec-kit/blob/main/templates/commands/taskstoissues.md)。

这是单向、尽力而为的转换：没有反向同步，没有 issue→task 状态回写，也不参与 implement/converge。

### 6.3 Hook 与 event（扩展点，非任务生命周期）

命令模板在 `before_*` / `after_*` 时机读取 `.specify/extensions.yml` 的 `hooks.<event>` 段，
按 `enabled`、`optional`、`condition` 决定是否执行，`optional: false` 为强制。
来源：如 `templates/commands/implement.md` 的 “Pre-Execution Checks” 与
“Mandatory Post-Execution Hooks”。

规范 event 名为 `session_start`、`pre_tool_use`、`post_tool_use`、`session_end`、
`user_prompt_submit`、`stop`，定义于
[`src/specify_cli/events.py`](https://github.com/github/spec-kit/blob/main/src/specify_cli/events.py)
（`CANONICAL_EVENTS`）。它们描述 agent 会话生命周期，与 feature 任务状态无关。

## 7. 明确不存在的能力

以下能力在 Spec Kit 中**没有**对应实现（不是“未验证”，是源码/文档中不存在）：

- **任务级 machine-readable schema**：`tasks.md` 无 JSON/YAML 表示，无解析器，无类型定义。
- **任务身份的稳定契约**：`T001` 只是在单个 `tasks.md` 文本内唯一的顺序编号；没有全局 ID、
  没有 UUID、没有跨文件引用机制。任务身份的唯一外部投影是 GitHub issue 标题里的 `T001:` 前缀。
- **机器可读依赖图**：依赖只以相位顺序、`[P]` 标记和自然语言 `depends on T012` 存在。
  没有任何数据结构、也没有工具会构建或校验该图。
- **结构化验收证据**：SDD 路径下无证据产物；仅 bug extension 有一份 Markdown 表格模板，无 schema。
- **任务状态机**：任务状态就是 Markdown 复选框 `- [ ]` / `- [X]`。没有 `pending/running/done`
  枚举，没有按任务的状态查询接口，没有 attempt/重试计数。
- **任务级运行时编排接口**：`specify workflow` 的 run 覆盖的是命令/步骤序列；没有
  “派发任务 → 查询任务状态 → 收事件”的接口。
- **实现与验证的角色分离**：`/speckit.implement` 单命令完成全部任务；没有独立 validator 角色，
  也没有 validator 会话内修复的概念。`/speckit.converge` 是唯一的事后缺口检查，但它只追加任务。
- **对外部 orchestrator 的回调/事件流**：workflow `--json` 是请求-响应式；没有订阅接口。

## 8. 仅为 prompt / 模板约定的部分

| 能力 | 实际实现方式 |
| --- | --- |
| “任务必须可直接执行、自包含” | `templates/commands/tasks.md` 的一句文字要求 |
| 任务格式与 ID 规则 | 命令模板中的文字规范 + 字符串断言测试 |
| `[P]` 并行标记语义 | 模板文字（“different files, no dependencies”） |
| story 独立性、优先级排序 | 模板文字与 `/speckit.analyze` 的模型判断 |
| `spec.md` 的 `Status` 字段 | 模板默认值，无代码维护 |
| checklist 门禁 | 命令模板指示 agent 统计并询问；无程序化 gate |
| converge 的 “append-only” 约束 | 命令模板中的 MUST 列表 |
| constitution 的权威性 | 命令模板声明 “non-negotiable”；由模型解释 |

## 9. 事实摘要

1. SDD 是 `specify → plan → tasks → implement → converge` 的**命令序列**，由 coding agent 逐个调用；
   只有 `specify → plan` 是硬前置。
2. Feature 产物是固定目录下的 Markdown：`spec.md`、`plan.md`、`tasks.md`、`research.md`、
   `data-model.md`、`quickstart.md`、`contracts/`；当前 feature 指针在 `.specify/feature.json`。
3. 机器可读接口只覆盖“路径与存在性”（`check_prerequisites.py --json` → `FEATURE_DIR` +
   `AVAILABLE_DOCS`）与“工具链 artifact 清单”（`specify artifact list/info --json`）。
4. `spec/plan/tasks` 之间靠 Markdown 文本约定关联（`### User Story N`、`FR-001`、`[US1]`、`T001`、`[P]`），
   没有 schema、外键或解析器。
5. 任务身份是单文件内的顺序编号 `T001`，唯一外部投影是 GitHub issue 标题前缀 `T001:`。
6. 没有机器可读依赖图、没有任务状态机、没有按任务查询的状态接口；任务完成度就是复选框勾选。
7. `specify workflow` 是真实编排接口（`run/resume/status --json`，状态 `created/running/completed/paused/failed/aborted`），
   但粒度是命令/步骤，不是任务。
8. 结构化验收证据只在 bug extension 的 `.specify/bugs/<slug>/test.md` 中出现（`verified/partial/failed`），
   SDD 路径没有证据产物；实现与验证未做角色分离。

## 参考链接

- 仓库与 release：<https://github.com/github/spec-kit> · <https://github.com/github/spec-kit/releases/tag/v1.0.8>
- 命令参考：<https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md>
- Artifact 清单与 JSON 契约：<https://github.com/github/spec-kit/blob/main/docs/reference/artifacts.md>
- Workflow 接口：<https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md>
- Spec 持久化模型：<https://github.com/github/spec-kit/blob/main/docs/concepts/spec-persistence.md>
- Core 命令与环境变量：<https://github.com/github/spec-kit/blob/main/docs/reference/core.md>
- 官方站点：<https://github.github.io/spec-kit/>
