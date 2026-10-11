# 独立复查：输入、导航与回收

审查者：Confucius（`01a12654-a6f3-7cd1-bd93-5e3eb04caf47`）。结论：**限定范围 PASS**，无新阻塞、无剩余检查。

固定 HEAD：`e6203fb43269a49005888daa8bda78735c34907f`。复查首尾均核验 checkpoint v2 及全部 729 个文件；manifest SHA256 为 `5cb776b2d797493f56effd483d09745c1da20da4c0775ad6ce52ee5e21ba010a`。审查只读，未修改文件。

审计范围：submission-loss、turn-authority、navigation-order、mouse-input、deletion-toctou。核对 IP-04–07 及 IP-08 证据、对应 Requirement / Scenario，检查 48 场景 / 114 对画面及代表性 PNG。

| 首轮发现 | 最终复查 |
| --- | --- |
| CAS 冲突后受理回调误删并发草稿 | 两个 App 移除 fallback clearDraft；mounted 回归确认并发草稿保留 |
| 稀疏 GraphQL 被当作删除成功 | 要求自有 node、repository 字段；两个值精确为 null 才证明缺失，反例 unknown 且本地删除为 0 |
| 分段 SGR 污染 composer | 公开 raw stdin 前缀支持 Ink 重组；生产 PTY 确认协议不进入输入，普通 `[` 即时交付 |
| 底部查询失败却提交 frame | 查询移至 frame 提交前；反例 sameFrame:true，原 24–31 行保留 |
| 旧 Session 迟到失败影响新 Session | catch 核验 request generation；A 返回 null，B following / frame.atLatest 均 true |

实际运行以下命令：7 文件、119 项通过。

```sh
pnpm exec vitest run tests/tui/input-protection.test.tsx tests/tui/debug-app.test.tsx tests/tui/transcript-reader.test.ts tests/tui/transcript-mouse.test.ts tests/tui/workspace.test.tsx tests/workflow/agent-turn-driver.test.ts tests/acceptance/ledger-lab-cleanup.test.ts
```

另复跑原 Reader / GraphQL 反例，以及生产 PTY 分段报告和普通 `[` 输入。真实平台、provider、Windows、用户人工体验不属于此次结论；GitHub 按名称删除缺原子身份条件的剩余竞态仍按 D-06 记录。
