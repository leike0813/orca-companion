# OpenSpec：schema、artifact graph 与 apply 输入的机器可读契约核验

调查对象：本机安装的 OpenSpec CLI **1.13.1**（`@fission-ai/openspec`，npm 包，`type: module`，`engines.node >= 20.19.0`）。
事实基线为安装产物本身：`/home/joshua/.nvm/versions/node/v24.12.0/lib/node_modules/@fission-ai/openspec/`
（`bin/openspec.js` → `dist/`、`schemas/`），并以官方文档
[cli.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md)、
[customization.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md)、
[opsx.md](https://github.com/Fission-AI/OpenSpec/blob/main/docs/opsx.md) 交叉核验。
仓库内同版本生成的 skill 位于 `.agents/skills/openspec-*/SKILL.md`（frontmatter `generatedBy: "1.13.1"`）。

结论先行：**OpenSpec 对「artifact 依赖图 + 文档存在性 + 任务勾选进度」提供了真实、稳定、可用 JSON 读取的契约，
足以被外部 coordinator 只读驱动；但它在任务粒度上没有 schema、没有状态机、没有事件流。**
schema（`schema.yaml`）与 change 元数据（`.openspec.yaml`）都有 zod 定义的机器可读结构；artifact 的
`requires` 边、就绪/阻塞状态、apply 输入（`contextFiles`、`progress`、`tasks`、`state`）都是 JSON。
**但任务身份只是 `tasks.md` 中按位置生成的自增序号，插入一行即全表漂移**；也没有任务级依赖、角色、
workspace、验收证据字段。因此能可靠读的是「计划是否成形、apply 该读哪些文件、还剩几个勾」；
「这个任务是什么、依赖谁、归谁做、做完的证据在哪」仍全部是 Markdown/prompt 约定。
另外 `dist/core/artifact-graph/` 是内部实现，**不在包的公开导出面**，外部程序应走 CLI JSON 而非库 API。

## 1. 核验基线与证据等级

| 项 | 值 | 来源 |
| --- | --- | --- |
| 安装 CLI | 1.13.1，`/home/joshua/.nvm/versions/node/v24.12.0/bin/openspec` | `openspec --version` |
| npm 包 | `@fission-ai/openspec`，re-export `dist/index.js` → `cli/index.js` + `core/index.js` | 包内 `package.json`、`dist/index.d.ts` |
| 本仓库 root | `/home/joshua/Workspace/Code/JavaScript/orca-companion`（`openspec/` 已初始化，`config.yaml` 仅含 `schema: spec-driven`） | `openspec list --json` → `root.source: "nearest"` |
| 使用的 schema | `spec-driven`（`proposal → specs → design → tasks`） | `openspec schemas`、包内 `schemas/spec-driven/schema.yaml` |
| 记录时间 | 2026-09-18 | — |

证据等级：

- **[实测]** 本机只读命令的真实输出（含在 `/tmp` 一次性临时工程中跑完整 lifecycle 的观测；**本仓库未被写入任何 change**）。
- **[契约]** 安装包内的 zod schema、`.d.ts`、内置 `schema.yaml`，或官方文档的明确声明。
- **[未核验]** 未执行到的路径，明确列出（见 `10）。

核对方式：`openspec <cmd> --json` 的输出与 `dist/core/artifact-graph/*.d.ts`、`dist/core/project-config.d.ts`、
`dist/core/change-metadata/schema.d.ts`、`dist/core/change-status-policy.d.ts` 的类型定义逐字段对照。

## 2. 磁盘模型与解析规则

```text
openspec/
├── config.yaml                      # 项目配置：schema / context / rules / operations / store / githubCopilot
├── schemas/<name>/                  # 项目级自定义 schema（版本控制）
│   ├── schema.yaml
│   └── templates/*.md
├── specs/<capability-path>/spec.md  # 权威主规格（archive 时被写入）
└── changes/
    ├── <change>/
    │   ├── .openspec.yaml           # change 元数据
    │   ├── README.md                # 仅当 new change 带 --description 时生成
    │   ├── proposal.md / specs/**/*.md / design.md / tasks.md
    └── archive/<YYYY-MM-DD>-<change>/   # 归档后的整份 change 快照
```

**根解析（实测）**：从当前目录向上找最近的 `openspec/`。无根时 `list --json` 返回 `"root": null` 且
`status[]` 带 `code: "no_openspec_root"`，**退出码 1**——这是答案，不是崩溃。
显式 root 可用 `--store <id>`（注册的独立 store）指定；skill 把它描述为「选定后全程粘性」。

**schema 解析优先级（契约，docs/opsx.md）**：CLI `--schema` > change 的 `.openspec.yaml` > 项目 `config.yaml` 的 `schema:` > 默认 `spec-driven`。
**schema 目录解析顺序（契约，`dist/core/artifact-graph/resolver.d.ts`）**：
1. 项目级 `<root>/openspec/schemas/<name>/schema.yaml`
2. 用户级 `${XDG_DATA_HOME}/openspec/schemas/<name>/schema.yaml`
3. 包内置 `<package>/schemas/<name>/schema.yaml`

`openspec schema which <name>` 返回 `Source: project|user|package` 与 `Path`。

## 3. schema.yaml：真正的机器可读契约

`schema.yaml` 由 zod 校验（`dist/core/artifact-graph/types.d.ts` 的 `SchemaYamlSchema`，`.strip` 模式）：

```yaml
name: <string>            # 必填
version: <int>            # 必填
description: <string?>    # 可选
artifacts:                # 必填、有序数组；数组顺序决定并列就绪时的先后
  - id: <string>          # 必填，命令与 rules 的键
    generates: <string>   # 必填，输出路径，支持 glob（如 "specs/**/*.md"）
    description: <string> # 必填
    template: <string>    # 必填，templates/ 下的文件名
    instruction: <string?> # 可选，自由文本 prompt
    requires: [<id>...]   # 可选，默认 []
apply:                    # 可选
  requires: [<id>...]     # apply 阶段前置 artifact
  tracks: <string?>       # 承载勾选的 artifact 输出（spec-driven 为 tasks.md）
  instruction: <string?>
```

**逐字段的类型与默认值来自 zod，不是文档推断**：`requires` 有 `Default([])`，`instruction`/`tracks` 为 optional，
`tracks` 可为 `null`。schema 操作自带告警：`schema.d.ts` 的 `findApplyTracksWarning` 明说
`tracks` 与某 artifact 的 `generates` **字符串必须完全相等**，否则 `list`/`status` 会退化为统计顶层 `tasks.md`。

**自定义 schema 完整可用（实测）**：`openspec schema fork spec-driven my-flow` 生成
`openspec/schemas/my-flow/{schema.yaml,templates/*.md}`；`schema validate my-flow` → `✓ Schema 'my-flow' is valid`；
`new change second --schema my-flow --json` 把 `schema: my-flow` 写进 change 的 `.openspec.yaml`，
后续 `status --json` 的 `schemaName` 即为 `my-flow`，且 `schemas --json` 报告 `source: "project"`。
**自定义 schema 与内置 schema 走完全相同的驱动路径，不需要 coordinator 特殊处理。**

注意：`schema` 子命令文本输出带 `Note: Schema commands are experimental and may change.`；
`schema fork ... --json` 在 1.13.1 下**未产生任何 stdout**（副作用文件正常创建）。

## 4. 命令 → JSON 契约对照

所有下列命令都支持 `--json`；**stdout 承载 JSON，人类进度提示（如 `- Loading change status...`）走 stderr**。
错误以信封形式返回：`{"status": [{"severity","code","message","target?","fix?"}]}`，**退出码 1**。

| 命令 | JSON 顶层字段 | 关键枚举 |
| --- | --- | --- |
| `list --json` | `changes[], root` | change `status`：`complete` / `in-progress` / `no-tasks` |
| `list --specs --json` | `specs[{id,title,requirementCount}], root` | — |
| `status --change <id> --json` | `changeName, schemaName, planningHome, changeRoot, artifactPaths, isPlanningComplete, isComplete, applyRequires[], nextSteps[], actionContext, artifacts[], root` | artifact `status`：`done` / `skipped` / `ready` / `blocked` |
| `instructions <artifact> --change <id> --json` | `artifactId, outputPath, resolvedOutputPath, existingOutputPaths[], instruction, template, context?, rules?, dependencies[], unlocks[], planningHome, skipped?/warning?` | — |
| `instructions apply --change <id> --json` | `contextFiles{}, progress{}, tasks[], state, instruction, context?, operationGuidance?, missingArtifacts?, missingPrerequisites?` | `state`：`ready` / `blocked` / `all_done` |
| `instructions archive --change <id> --json` | `changeName, context?, operationGuidance?, root` | 只读，不改动任何文件 |
| `validate <item> --json` | `items[{id,type,valid,issues[],durationMs}], summary{totals,byType}, version:"1.0", root` | `version` 为信封版本 |
| `show <change> --json` | `id, title, deltaCount, deltas[{spec,operation,requirement{text,scenarios[{rawText}]},requirements[]}], root` | `operation`：`ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` |
| `show <spec> --type spec --json` | `id, title, overview, requirementCount, requirements[{text,scenarios[{rawText}]}], metadata{version,format}, root` | 支持 `--no-scenarios` 精简 |
| `templates --json` | `{artifactId: {path, source}}` | — |
| `schemas --json` | `[{name, description, artifacts[], source}]` | `source`：`project`/`user`/`package` |
| `new change <id> --json` | `change{id,path,metadataPath,schema}, root` | — |
| `archive <id> --yes --json` | `archive{change,archivedAs,path,specsUpdated,totals{added,modified,removed,renamed},warnings[]}, root` | 失败时 `archive: null` + `status[]` |
| `doctor --json` | `root{path,source,healthy,status[]}, store, references, status[]` | 健康问题仍 **exit 0** |
| `context --json` | 工作集 brief（root + references） | — |

**一个必须处理的坑（实测）**：错误信封在 1.13.1 下**同时可见于 stdout 与 stderr**
（`2>/dev/null` 与 `1>/dev/null` 两次都拿到完整 JSON），退出码 1。
coordinator 不能只看退出码，也不能假设 stderr 才是错误通道；应把 stdout 当唯一解析对象并容忍 exit 1。

## 5. artifact 依赖图与状态：可读，且是确定性的

依赖图在 `status --json` 里被完整投影（`dist/core/artifact-graph/instruction-loader.d.ts` 的 `ChangeStatus`）：

- `artifacts[]` 每项含 `id, outputPath, status, requires[], missingDeps?`；
  `requires` **在每种状态下都存在**（即便该 artifact 已 `done`），因此调用方可以自行计算传递闭包。
- 数组顺序即依赖序：`graph.d.ts` 明说 `getBuildOrder()` 用 Kahn 算法，**并列就绪时按 `schema.yaml` 中 artifacts 的声明顺序**打破平局
  （注释解释了历史上按字母序会把 `design` 排在 `specs` 前的问题）。所以「第一个 `ready`」就是「下一个该写的 artifact」。
- `isPlanningComplete` 只表示**全部非 skipped 的规划 artifact 是否已存在**；`isComplete` 是它的兼容别名，同值。
  **它不包含 tasks 的完成度**——任务进度必须另取（见 `7）。
- `skipped` 来自 change 的 `skip_specs: true`（实测：`specs` 状态变为 `skipped`，`instructions specs --json` 返回
  `skipped: true` + `warning`，明令不得创建该文件）。

**完成判定只有一条规则：文件是否存在。** `state.d.ts` 的 `detectCompleted` 就是「在 change 目录里扫文件」，
`outputs.d.ts` 负责 glob 展开与排序。**没有注册表、没有状态数据库、没有版本号、没有 attempt 计数。**
这对 coordinator 是好消息（无外部状态可漂移）也是坏消息（没有 CAS/乐观锁语义）。

**artifact 身份不是契约**：`id` 由 schema 定义，跨 schema 不通用；`outputPath` 是相对路径且**可以是 glob**
（`specs/**/*.md`），所以「一 artifact 一文件」不成立，必须用 `existingOutputPaths[]` 拿具体文件。

## 6. apply 输入：外部实现 agent 实际消费什么

`openspec instructions apply --change <id> --json` 是唯一为「执行」设计的机器入口（实测完整输出）：

| 字段 | 实测值示例 | 语义 |
| --- | --- | --- |
| `contextFiles` | `{"proposal":[abs], "specs":[abs...], "design":[abs], "tasks":[abs]}` | **artifact id → 具体文件绝对路径数组**，随 schema 变化 |
| `progress` | `{"total":3,"complete":1,"remaining":2}` | 来自 `apply.tracks` 指向的文件 |
| `tasks` | `[{"id":"1","description":"1.1 Do the thing; verify with echo ok","done":false}]` | 见 `7 |
| `state` | `ready` / `blocked` / `all_done` | 阻塞时附 `missingArtifacts[]`、`missingPrerequisites[]` |
| `instruction` | `"Read context files, work through pending tasks..."` | 来自 `schema.yaml` 的 `apply.instruction`，**自由文本** |
| `context` / `operationGuidance` | `"Tech stack: TypeScript, Node 24."` / `["Run focused tests first"]` | 来自 `config.yaml`，**advisory** |
| `root` | `{"path":...,"source":"nearest"}` | — |

实测阻塞形态（change 尚无 tasks）：`state: "blocked"`、`missingArtifacts: ["tasks"]`、
`missingPrerequisites: ["proposal","specs","design","tasks"]`、`contextFiles: {}`。

**`context` 与 `operationGuidance` 是 prompt 级契约，不是可执行门禁**（官方 cli.md 明说
`"These are behavioral contracts for generated agents, not enforceable CLI checks."`）。
它们可以影响 agent 行为，但 coordinator 无法程序化验证 agent 是否遵守。
`instructions archive` 同理，只返回 `context`/`operationGuidance`/`root`，**不包含静态 archive 流程、不检查 delta、不写主 specs**。

## 7. tasks 状态：能读勾选，不能读语义

**解析规则（契约，`schema.yaml` 的 tasks instruction + skill）：** 复选框内**只有 `x`/`X`**（大小写与空格无关，`- [ x]` 也算完成）即完成；
其余一切标记都算未完成——`- [ ]`、`- []`、`- [~]`、`- [-]`；**没有复选框的行完全不参与统计**。

**任务 id 是位置序号，不是文本里的编号（实测）：**

```text
tasks.md:      - [ ] 1.0 New first      → {"id":"1","description":"1.0 New first"}
               - [ ] 1.1 First          → {"id":"2","description":"1.1 First"}
               - [ ] 1.2 Second         → {"id":"3","description":"1.2 Second"}
```

即在文件顶部插入一行后，**其后所有任务 id 依次 +1**。`description` 保留原始的 `1.1` 前缀，但那是文本、不参与 id。
结论：**`tasks[].id` 不能作为跨会话、跨读数的稳定身份**；任何「把某个 Orca Task 绑到某个 OpenSpec 任务」的映射，
必须落在 coordinator 自己的存储里，并额外用内容指纹或你自己定义的稳定 id 来对账。

**任务粒度的字段只有三个**：`id`、`description`、`done`。没有依赖、没有角色、没有 workspace、没有验收条件、没有 attempt。
官方 tasks instruction 里「每个任务必须说明如何验证完成」「按依赖排序」「小到一个会话能做完」全是**给模型的文本要求**，
没有解析器、没有校验器。community schema `anvil` 的文档更是直说：
`"OpenSpec only checks that artifacts exist, so enforce the gate with your own CI or hook."`

## 8. change lifecycle

1. **建**：`openspec new change <name> [--schema] [--goal] [--description]`。名称强制 kebab-case
   （`dist/core/id.d.ts` 的 `KEBAB_ID_REGEX`，允许前导数字如 `100-add-feature`）。
   落地 `.openspec.yaml`（`schema` 必填）＋可选 `README.md`。
   `--goal` 只写进元数据的 `goal` 字段（实测），**不出现在 `status`/`list` 的 JSON 里**。
2. **规划**：逐个 artifact 由 agent 依据 `instructions <id> --json` 的 `template` + `instruction` + `context`/`rules` 写文件。
   无 API 提交、无注册步骤；**写完文件即「完成」**。
3. **校验**：`openspec validate <change> --json` 返回 `items[].valid` 与 `issues[]`。
4. **执行**：`instructions apply --json` → 逐条改勾选。
5. **归档**：`openspec archive <id> --json [--yes] [--skip-specs] [--no-validate]`。
   **未完成任务时拒绝**（实测：`archive: null` + `code: "archive_tasks_incomplete"` + `fix: "Complete the tasks or rerun with --yes."`，exit 1）。
   成功后：delta 合并进 `openspec/specs/<capability>/spec.md`，change 整体移到
   `openspec/changes/archive/<YYYY-MM-DD>-<name>/`，返回 `specsUpdated`、`totals{added,modified,removed,renamed}`、`warnings[]`。
   归档后该 change **从 `list`/`status`/`instructions` 的全部 active 视图中消失**（实测）。

change 元数据（`.openspec.yaml`）同样有 zod 契约（`dist/core/change-metadata/schema.d.ts`）：
`schema`（必填）、`created?`、`goal?`、`affected_areas?: string[]`、`initiative?: {store,id}`（strict）、
`skip_specs?: bool`、`retire_capabilities?: bool`。

## 9. 明确不存在 / 仅为 prompt 约定的部分

| 能力 | 实际情况 |
| --- | --- |
| 任务级 schema | 无。只有 `{id, description, done}`；无依赖、无角色、无验收字段 |
| 任务稳定身份 | 无。id = 文件内位置序号，插入即漂移 |
| 任务状态机 | 无。状态 = Markdown 勾选，只有完成/未完成两态；无 attempt/重试计数 |
| 任务级依赖图 | 无。只有 artifact 级 `requires`；任务顺序靠文本说明 |
| 结构化验收证据 | 无任何产物或字段 |
| 事件/订阅流 | 无。全部请求-响应轮询 |
| 内容门禁 | 无。文档明说 OpenSpec 只检查 artifact 是否存在 |
| 「自包含、可直接执行」 | tasks instruction 里的一句文字要求 |
| `opsx:*` slash 命令 | 是 agent skill（本仓库 `.agents/skills/openspec-*`），不是终端命令；真正的驱动路径是 CLI `--json` |
| 库级 API | `artifact-graph` 不在公开导出面：`dist/core/index.js` 只 re-export global-config / references / store / planning-home / openspec-root；根导入 85 个命名导出中无 `ArtifactGraph` |
| 文档漂移 | skills 提到 `list --json` 有 `schema` 字段「if present」，**1.13.1 实测无此字段**；`schemaName` 只在 `status`/`instructions` 里 |

## 10. 未核验

以下路径本 ticket 未执行，**任何依赖它们的结论还只是假设**：

- `--store` / 注册 store / references（linked context）路径——只跑了 `store list --json`（返回空）与 help。
- `config.yaml` 的 `store:` 指针解析与「store 未注册」错误分支。
- `validate` 的失败判定：无 scenario 的 requirement、零 delta 且未设 `skip_specs`、`--strict` 的具体行为。
- 归档失败/回滚路径（文档描述了 specs 恢复与 staging 清理语义，未复现）。
- Windows 行为（本机 Ubuntu）；包不声明平台限制，但未验证。
- `openspec update`、`view`、`workset`、`feedback`、`completion` 等命令。
- `schema fork ... --json` 的预期输出契约（实测为空）。
- 深层子路径导入（`@fission-ai/openspec/dist/core/artifact-graph/...`）是否可用；根导入可用已实测。

## 事实摘要

1. 安装版本 1.13.1；`schema.yaml`（`SchemaYamlSchema`）与 change 元数据 `.openspec.yaml`（`ChangeMetadataSchema`）都有 zod 定义的机器可读契约，`requires` 与 `apply.tracks` 的语义有类型保证。
2. artifact 依赖图可读且确定性：`status --json` 的 `artifacts[]` 含 `requires`/`status`/`missingDeps`，数组为 Kahn 拓扑序、并列按 schema 声明序。
3. 完成判定只有「文件是否存在」，没有注册表、状态库、版本号或 attempt 计数。
4. apply 的机器入口是 `instructions apply --json`：`contextFiles`（artifact → 绝对路径）、`progress`、`tasks`、`state(ready|blocked|all_done)`、`missingArtifacts`/`missingPrerequisites`。
5. 任务状态就是 Markdown 勾选（仅 `x`/`X` 算完成），`tasks[].id` 是位置序号，插入一行即整体漂移，不能当稳定身份。
6. 任务粒度无 schema、无依赖、无角色、无验收证据、无 attempt；「自包含可执行」只是 prompt 文字要求。
7. 自定义 schema 与内置 schema 走同一驱动路径（`schema fork`/`validate`/`which` 可用），无需 coordinator 特殊处理。
8. 错误信封在 stdout 与 stderr 同时可见且 exit 1；`--store`、references、validate 失败判定、Windows 等路径未核验。

## 参考

- 仓库：<https://github.com/Fission-AI/OpenSpec>（npm `@fission-ai/openspec` 1.13.1）
- CLI 参考：<https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md>
- 自定义 schema：<https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md>
- OPSX 工作流：<https://github.com/Fission-AI/OpenSpec/blob/main/docs/opsx.md>
- 安装包内类型：`dist/core/artifact-graph/{types,graph,state,resolver,schema,outputs,instruction-loader}.d.ts`、
  `dist/core/project-config.d.ts`、`dist/core/change-metadata/schema.d.ts`、`dist/core/change-status-policy.d.ts`、`dist/core/id.d.ts`
- 内置 schema 与模板：`schemas/spec-driven/schema.yaml`、`schemas/spec-driven/templates/*.md`

