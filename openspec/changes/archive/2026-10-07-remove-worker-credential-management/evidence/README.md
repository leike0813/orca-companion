# 实施证据

2026-10-07，Ubuntu 本机。当前实现的检查结果见 [implementation-plan 第九节](../implementation-plan.md#9-实施结果)。历史验收不计入本次结果。

生产 App 通过既有 `scripts/tui-preview.mjs alignment-planning` 和 fake ports 展示，无真实模型任务。三档尺寸为 120×40、80×24、50×40，各检查 color/no-color × Nerd/ASCII 共 12 组；查询、harness 切换、effort、中文手填与返回后的草稿/光标均通过。另检查三档 resize、完整授权审阅及默认返回，结果在 [ui-results.txt](ui-results.txt)。

| 画面 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| Worker 原生模型选择 | [画面](worker-120x40.png) | [画面](worker-80x24.png) | [画面](worker-50x40.png) |
| effort | [画面](effort-120x40.png) | [画面](effort-80x24.png) | [画面](effort-50x40.png) |
| 中文手填 ID | [画面](manual-120x40.png) | [画面](manual-80x24.png) | [画面](manual-50x40.png) |
| Coordinator 表单 | [画面](coordinator-120x40.png) | [画面](coordinator-80x24.png) | [画面](coordinator-50x40.png) |
| 授权审阅 | [画面](review-120x40.png) | [画面](review-80x24.png) | [画面](review-50x40.png) |
| 返回工作区 | [画面](returned-120x40.png) | [画面](returned-80x24.png) | [画面](returned-50x40.png) |

同名 `.txt` 保存可读 frame。已对照 #52 final 原型的层级、区域、配色和默认返回。

从仓库根目录复现角色模型画面检查：

```sh
pnpm build
node openspec/changes/remove-worker-credential-management/evidence/capture-ui.mjs /tmp/worker-ui-recheck
```

原生目录查询不发送用户 prompt；Codex/Claude/pi/OMP 分别返回 14/4/521/913 项，OpenCode 返回空目录并标记 `catalog_empty`。五项生产 launcher/bwrap 哨兵检查均为 `available / host-verify`。这证明本地目录和包装器能力，不证明认证成功或真实角色运行。实际 Orca Session、恢复与隔离端到端矩阵未运行，记为 skip。
