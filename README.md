# Orca Companion

为范围明确的小型软件项目提供可恢复、可追踪、有预算上限的开发流程。Orca 负责工作区与 agent 执行，Companion 负责项目计划、调度规则、验收与恢复。

当前是 **M0 阶段的工程骨架**：工具链、依赖与目录边界已经就位，还没有运行代码。`build` 脚本等 M0 的实现落地后再加。

## 环境

- Node.js ≥ 24（本仓库验证于 24.12.0，见 `.nvmrc`）
- pnpm ≥ 11（`packageManager` 固定 11.10.0）
- 本机可执行的 Orca CLI（验证版本见 `docs/orca-compatibility.md`）

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装 devDependencies |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint`、`pnpm lint:fix` | ESLint，含类型感知规则 |
| `pnpm test`、`pnpm test:watch` | Vitest |

`pnpm test` 目前带 `--passWithNoTests`，等 `tests/` 下有真实用例后去掉。

## 结构

模块边界、工具契约与里程碑以 `AGENTS.md` 为准，此处不重复。`references/orca` 是只读上游源码（Git submodule），不参与构建、lint、测试与打包。

## 文档

- `AGENTS.md`：项目目标、模块边界、工具契约、里程碑
- `docs/orca-compatibility.md`：上游 submodule 与 Orca CLI 的版本基线，以及已验证和未验证的能力
