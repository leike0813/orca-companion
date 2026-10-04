# 本次任务临时工作树回收

2026-10-04，按用户「把本次任务建立的临时工作树都回收掉」的指令完成回收。

本次范围由 `real-acceptance/fixture-*.json` 与 Orca 公开工作树目录交叉确认：16 个隔离验收仓库、12 个角色 Worker 工作树，共 28 个工作区。包括 GB01、初始 Luna、Cutover b、执行 c–i、Recovery j/m/o、retire k/l/n。关联的 71 个终端均由公开 `terminal close --worktree <exact-id> --all` 确认关闭。

先保存工作树文件、未提交规格、Git 记录和 Companion SQLite 状态，再通过公开 `worktree rm` 删除 12 个 Worker 树。Orca 保护仓库主工作树路径，16 个验收仓库改为通过公开 `project setup-delete` 撤销对应 host setup/仓库登记；确认无其他 Git 工作树及登记后，按 fixture 清单逐项删除目录。8 个空的 Worker 父目录与空回收站一并清除。

原占用合计 3,103,756 KiB（约 2.96 GiB）。压缩快照保存在：

[orca-companion-graph-basis-reclaimed-20261004.tar.gz](/home/joshua/Workspace/Artifact/orca-companion-graph-basis-reclaimed-20261004.tar.gz)

快照共 936,623 字节，包含 28 个工作区的文件和状态，已通过 `tar -tzf` 检查。压缩包路径从文件系统根目录起算；它是历史证据快照。隔离 Codex HOME 整体排除，未归档其登录凭据、缓存和其他会话索引，不能据此直接恢复 Worker Session。

复核结果：原 28 个路径均不存在，16 个 Orca 仓库和 host setup 登记均不存在。回收后首次复核时，主项目 HEAD 为 `41b2f1e636c110441a0a344fc20749911b085201`，原 Git porcelain 状态逐字节一致。最终复核期间，主工作区出现并行的 OpenSpec 主规格同步与 change 归档改动，因此最后的 Git 状态已不同；本次回收未操作这些文件，检测到的改动原样保留。主项目代码、交付记录、验收日志和报告保留；新增的本目录只记录回收过程。16 个 `-xdg` 配置侧目录保留，它们不是工作树。

`inventory.json`、`audit-before.json`、`archive.json`、`archive-contents.txt` 记录范围和快照；`close-*.json`、`remove-*.json`、`deregister-*.json` 是公开操作回执，`filesystem-removal.json`、`verification.json` 与 `verification-final.json` 记录目录回收和两次复核。验收报告中原现场的 paused/保留状态描述的是本次回收之前的事实；后续只读检查应使用已保存报告或快照。

本次使用 [orca-cli skill](/home/joshua/.agents/skills/orca-cli/SKILL.md)，未发送督办消息或启动新 Worker。
