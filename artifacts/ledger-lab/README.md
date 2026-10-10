# ledger-lab 实测包

这是 `ledger-lab` 样例工程的实测包。本包保留在操作者一侧：目录里没有样例工程，业务需求由你按剧本提交，交给 Companion 的是需求文本。操作指南、业务需求文本、验收程序命令契约与人工观察、映射示例都在这里。

机器可读的规则都在 [contract.json](./contract.json)。字段、别名、脱敏值、错误码、参考图、补丁、执行上限与场景清单以它为准；本文和 [guide.md](./guide.md) 只说明怎么用，不重复这些取值。

## 它是用来做什么的

被测对象是 Orca Companion 本身。你会在本仓库之外的独立 Git 仓库里，以真实用户的身份用 Companion 规划并实现 `ledger-lab`；本目录指导你如何操作、如何采集证据、如何判定结果。

验收关注过程能力：跨 lane 并行、每条 lane 至多一个 Worker、局部阻塞下其他 lane 继续推进、局部汇合与最终汇合、规格修订、原子图补丁、暂停与恢复、退出重入、Worker 恢复、预算不重置、重规划与取消。

准备命令创建私有仓库、`main` 主 checkout、仓库内安装的 ocp，并登记 Orca、打开原生项目终端；模型配置、Scope 最终确认、需求批准、故障注入、业务操作和结论评估仍由操作者完成。工具不生成业务骨架、执行图或验收答案，也不自动循环派发。准备不请求模型；启动/应用核验与显式 `doctor` 可能产生模型费用。

## 创建、查看与回收 round

- `pnpm lab:new` 打包当前构建，创建外置 round、私有 GitHub 仓库与 `main` 主 checkout，安装 tarball、登记 Orca、设置 `origin/main` 并打开原生项目终端；它不配置模型、不创建 Route Map、不运行 `doctor` 或模型探针。
- `pnpm lab:new --profile cancel` 建立独立的 `cancel` round。
- `pnpm lab list [--root /abs/dir]` 列出该 runs 根目录下的 round 与准备、回收状态；不会自动选择最新一轮执行操作。
- `pnpm lab cleanup --run /abs/round` 只预览本轮删除目标与保留项；加 `--yes` 才实际删除。
- `pnpm lab open --run /abs/round` 核对原身份并聚焦记录的终端，仅确定已退出时替换；旧 schema 2 未登记现场可显式补登记，schema 1 保留原有入口。重开不推进业务或启动模型。
- `collect`、`verify-result`、`verify-process`、`report` 均可接收 `--run /abs/round`。原有显式参数仍可使用。
- `--root` 指定绝对路径的外置 runs 根目录。

默认状态根目录为 `$XDG_STATE_HOME/orca-companion/ledger-lab`，未设置时为 `~/.local/state/orca-companion/ledger-lab`。每个新 round 包含 `repo/`、`operator/`、`captures/`、`checks/`、`packages/` 和 `run.json`；`packages/` 保留本轮安装用的 tarball。

每轮在本地 `main` 首次提交并推送，再经公开 Orca 命令登记并打开项目终端。该终端保留原生 shell，只补本轮 `node_modules/.bin` PATH 和明确 `ORCA_CLI_COMMAND`；直接输入 `ocp` 或 `ocp --debug`，不需要全局安装。

普通启动自动核验 repository、Orca 与身份，每项显示真实结果和当前 spinner，失败后按 Enter 显式重试。首次配置按环境、Coordinator、Route Map、最终确认四步进行：共享模型编辑器支持复用连接或新增服务/协议、地址、隐藏 Key 和模型；Route Map 可创建只有固定章节的空地图，也可查看最多 20 个候选并按编号选择。确认后保存 schema 5、核验模型与 tracker，再初始化 Scope/cycle/session。规划与 debug 不要求 Worker Profiles；五个生产角色的 harness、原生模型与 effort 在执行授权前配置并按 Manifest 核验。

`ocp --debug` 不要求 Orca、项目配置或 Route Map，空用户库也可经同一编辑器配置模型；新建或继续仍须用户明确选择，打开前核验模型能力。`open --run` 核验原仓库与绑定，聚焦原终端，仅确定已退出时替换；旧 schema 2 未登记现场可在显式 open 时补登记，不启动模型或业务。

Coordinator 只使用 API Key：复用用户级连接，或在 TUI 中隐蔽输入新密钥；密钥只写入用户级 CredentialStore，项目配置只保存不透明引用。用户级 Provider/凭据库目录要求 `0700`、文件要求 `0600`；既有目录不会被自动改权限，权限不安全时会给出路径、实际权限与修复命令。

准备前需配置 Git 作者身份、登录 `gh` 并启动可达的本机 Orca；Worker harness 使用自己的真实用户认证环境。准备成功表示仓库、安装、登记与终端完成，不表示模型能力或业务验收通过。启动/应用会核验模型能力；需留存诊断报告时显式运行 `ocp doctor`，这些核验可能产生模型费用，准备本身不请求模型。

初始化 Scope 后可采集并填写外置映射与观察：

```sh
pnpm lab collect --run /abs/round --watch
pnpm lab verify-result --run /abs/round --version initial
pnpm lab verify-process --run /abs/round
pnpm lab report --run /abs/round
```

首次采集会把空的 `operator/mapping.json`、`operator/observations.json` 绑定到实际 Scope；请按旁边的示例填写，空模板不会产生通过结论。核验默认读取本轮最新采集和报告，其他轮次不会混用。

准备失败时保留 round 供检查，不自动重试、清理或回滚；遇到结果不明时不得换身份重做。`open` 核验原 round 并聚焦原终端，确定退出时替换，未登记的旧 schema 2 可显式补登记；不重跑仓库创建、安装或业务步骤。

回收前先停止本轮启动的 ocp 与 Worker，处理/释放相关 Worker、关闭相关终端，再执行 `orca project setup-delete --setup <repoId>` 解除登记。`cleanup` 不结束进程、不注销项目、不删除整个 round：远程仓库与本地 checkout 各自记录结果，仓库外的 `run.json`、`packages/`、`operator/`、`captures/`、`checks/` 与外置报告都保留。旧 schema 1 round 仍可查看并按原入口使用，但没有本地目录身份与远程不可变 ID，`cleanup` 会拒绝删除并给出原路径与远程名称，需人工核对后手工处理。

## 文件

| 文件 | 用途 |
| --- | --- |
| `contract.json` | 唯一规则来源：业务合同、参考图、补丁、执行上限、场景清单。 |
| `cases.json` | 成品验收的输入与期望数据；没有参考实现。 |
| `prompts.md` | 你手动提交给 Companion 的分阶段业务需求文本。 |
| `guide.md` | 主剧本、取消短剧本、条件检查表、状态定义与时机错过处理。 |
| `mapping.example.json` | 把参考图节点映射到真实 WorkPackageId 的示例，可带可选 `controlLanes`。 |
| `observations.example.json` | 人工观察与四维体验评估的示例。 |
| `capabilities.md` | 当前产品能力缺口，以及由此产生的验收限制。 |

验收程序模块：

| 模块 | 用途 |
| --- | --- |
| `lab.mjs` | 命令行入口：round 准备/列表/回收/重开、`collect`、`verify-result`、`verify-process`、`report`。 |
| `collector.mjs` | 只读采集器，写出 `evidence.jsonl`。 |
| `process-verifier.mjs` | 过程核验，产出 `process.json`。 |
| `result-verifier.mjs` | 成品核验，产出 `result.json`。 |
| `report.mjs` | 合并过程、成品与人工观察，产出 `acceptance-report`。 |
| `common.mjs` | 共享工具：读合同、外置路径断言、独占新建 JSON。 |

子命令、证据样本（`evidence.jsonl`）、过程报告（`process.json`）、退出码与采集语义见 `guide.md` 第 1 节。版本规则、默认值、行尾与输出语义以 `contract.json` 为准。

## 运行前置

- 在本仓库根目录用 Node 24 与 pnpm 运行实测包。
- 采集器通过构建产物（`dist/`）加载应用的只读端口，先执行 `pnpm build`；用仓库现有依赖即可，不需要额外安装，也不调用模型。
- 命令与参数用 `node artifacts/ledger-lab/lab.mjs --help` 查看。
- 缺少 `dist/`，或目标 Scope 不存在时，样本里对应的来源会带 `status:"unavailable"`，相关检查不会被判为通过。
- `report` 会在仓库外创建 `--out` 的父目录；`--out` 目标目录必须尚不存在。

## 路径与安全

所有运行期产物都必须落在被测仓库之外。

- 被测仓库是独立目录，只保留 `ledger-lab` 的源码与 Git 历史。
- 采集证据、验证报告、人工观察、映射和最终报告写到仓库外的绝对路径，例如 `/abs/out`、`/abs/report-dir`。
- 采集器只读，不写被测仓库，不确认 Delivery，不派发，不恢复模型。
- 不要把运行期产物提交回本仓库或被测仓库。

## 参考图只在操作者一侧

`contract.json` 里的 `referenceGraph` 只用于你核对规划质量。提交给 Companion 的需求文本不要粘贴节点编号、依赖或 Graph JSON，`prompts.md` 已经按这个约束写好。

## 状态与结论

每个场景记成五选一：`PASS`、`FAIL`、`BLOCKED`、`NOT_COVERED`、`INCONCLUSIVE`，定义见 `guide.md`。过程报告是 `checks` 数组加一个组内总 `status`，没有顶层 `statuses`；`unknown` 等场景不会自动 `PASS`，细节见 `guide.md` 第 1.2 节。人工声明不等于机器 `PASS`；你对结果的认可要用 `assessment` 单独标注。体验部分看四个维度：清晰度、干预次数、问题处理、可复跑性。
