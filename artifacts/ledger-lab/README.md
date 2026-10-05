# ledger-lab 实测包

这是 `ledger-lab` 样例工程的人工实测包。本包保留在操作者一侧：目录里没有样例工程，业务需求由你按剧本手动提交，交给 Companion 的只有你手工粘贴的需求文本。操作指南、业务需求文本、验收程序命令契约与人工观察、映射示例都在这里。

机器可读的规则都在 [contract.json](./contract.json)。字段、别名、脱敏值、错误码、参考图、补丁、执行上限与场景清单以它为准；本文和 [guide.md](./guide.md) 只说明怎么用，不重复这些取值。

## 它是用来做什么的

被测对象是 Orca Companion 本身。你会在本仓库之外的独立 Git 仓库里，以真实用户的身份用 Companion 规划并实现 `ledger-lab`；本目录指导你如何操作、如何采集证据、如何判定结果。

验收关注过程能力：跨 lane 并行、每条 lane 至多一个 Worker、局部阻塞下其他 lane 继续推进、局部汇合与最终汇合、规格修订、原子图补丁、暂停与恢复、退出重入、Worker 恢复、预算不重置、重规划与取消。

本目录不自动驱动 Companion，不注入故障，不提供样例实现或空骨架。指南里写的手动操作只授权你人工执行，不授权任何自动化。

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
| `lab.mjs` | 命令行入口：`collect`、`verify-result`、`verify-process`、`report`。 |
| `collector.mjs` | 只读采集器，写出 `evidence.jsonl`。 |
| `process-verifier.mjs` | 过程核验，产出 `process.json`。 |
| `result-verifier.mjs` | 成品核验，产出 `result.json`。 |
| `report.mjs` | 合并过程、成品与人工观察，产出 `acceptance-report`。 |
| `common.mjs` | 共享工具：读合同、外置路径断言、独占新建 JSON。 |

子命令、证据样本（`evidence.jsonl`）、过程报告（`process.json`）、退出码与采集语义见 `guide.md` 第 1 节。版本规则、默认值、行尾与输出语义以 `contract.json` 为准。

## 运行前置

- 在本仓库根目录用 Node 24 运行验收包。
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
