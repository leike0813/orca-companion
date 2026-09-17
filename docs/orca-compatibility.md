# Orca 兼容性基线

记录 Companion 依赖的 Orca 侧事实：上游源码快照、本机运行时版本、已经核验的能力，以及尚未验证的部分。运行时能力必须通过当前安装的 Orca 版本核验，不能从 submodule 源码推断。

## 上游源码快照

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/stablyai/orca.git` |
| 路径 | `references/orca`（Git submodule，只读） |
| 固定 commit | `de15227a1d321840ea35c6bb2d0cc01e3409e5f1` |
| commit 时间 | 2026-09-17T03:00:17-07:00 |
| commit 标题 | `feat(terminal): search match count + Cmd+F focus parity (#9035)` |
| 克隆方式 | `git submodule add --depth 1`，浅克隆，工作区约 280 MB |

该目录不参与构建、lint、测试与打包，边界见 `AGENTS.md` 第 3、4 节。

## 验证环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 24.04.4 LTS（Linux 6.8.0-139-generic x86_64） |
| Orca CLI | 1.4.198，`/home/joshua/.local/bin/orca` |
| Orca runtime | 未核验 |
| Node.js | 24.12.0 |
| pnpm | 11.10.0 |
| 记录时间 | 2026-09-17 |

## 已核验

- `orca --version` 输出 `1.4.198`。
- `orca --help` 输出命令分组：startup、diagnostics、agent discovery、accounts、skills、hosts、environments、environment recipes、automations 等。

骨架阶段没有执行任何会改变 Orca 状态或绑定身份的命令，到此为止。

## 尚未验证

下列能力属于 M0 的证明目标，目前均未核验，不能当作既成事实：

- coordinator 身份、runtime、Run、worktree 与 consumer 的绑定方式；
- 受支持的 `--json` 输出 schema 与退出码语义；
- 事件与请求收据的读取、确认与重放语义；
- 终端 handle 在 runtime 重启后的重新解析与映射；
- provider session 的续用能力；
- Windows 11 上的进程调用、路径与终端行为。

## 变更规则

升级 submodule 是有明确目的的变更，需要同时给出对应 adapter 的回归结果。不要执行 `git submodule update --remote`。
