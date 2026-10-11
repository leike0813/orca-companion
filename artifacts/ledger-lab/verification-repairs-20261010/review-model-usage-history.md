# 独立复查：模型、用量与历史

审查者：Pauli（`01a12654-a41e-76c1-9ada-51454200b526`）。结论：**限定范围 PASS**。IP-01–03 的 Standards / Spec 及 immutable-snapshot、usage-semantics、bounded-projection 均通过，无新阻塞。

固定 HEAD：`e6203fb43269a49005888daa8bda78735c34907f`。结束时核验 v2 manifest SHA256 `5cb776b2d797493f56effd483d09745c1da20da4c0775ad6ce52ee5e21ba010a`、全部 729 文件哈希及最终 PTY manifest（48 runs、114 pairs、failures=[]），全部一致。未修改源码。

| 首轮发现 | 最终复查 |
| --- | --- |
| Editor 校验/保存失败丢输入 | 保留声明、窗口文本及焦点；Enter 正常进入动作区 |
| 重复 ID 恢复旧 modelRef | 精确 ref 优先；fallback、manual、catalog 均采用最新记录 |
| Anthropic 不完整 usage 被接受 | 两个原反例均返回 null；完整累计输出取末值 |
| Pending display 回退 raw | 阅读显示准备状态，搜索拒绝，均不读取 raw |
| 持久游标绕过批次预算 | 长度先验、完整 Zod 校验；游标与正文共用 64 KiB |
| 截断/非法 JSON 发布投影 | 严格 grammar、EOF、depth 64；非法结构不登记来源 |
| 项目预算冒充模型容量 | 容量取 backend / 声明窗口；请求预算取项目 / 窗口较小值 |

独立运行以下命令：五文件 106 项通过，usage 筛选 5 项通过（19 项因筛选跳过），模型配置相关三文件 22 项通过。

```sh
pnpm exec vitest run tests/adapters/history-display-projection.test.ts tests/adapters/checkpoint-store.test.ts tests/tui/provider-library-editor.test.tsx tests/tui/transcript-reader.test.ts tests/application/history-search.test.ts
node node_modules/vitest/vitest.mjs run tests/workflow/coordinator-graph.test.ts -t 'usage|Anthropic|configurationRef|Committed Model Step'
node node_modules/vitest/vitest.mjs run tests/configuration/provider-library.test.ts tests/adapters/chat-model-factory.test.ts tests/application/project-presentation.test.ts
```

复跑 `/tmp/ocp-repair-review-repros/editor-duplicate-catalog.mjs`，原 editor / usage 反例符合预期；另完成 88 个 grammar 边界检查、depth 64 / 65 与读取计费检查。

结论基于冻结源码、调用路径及合成检查；真实 provider / platform 和用户人工体验不在本次结论内。
