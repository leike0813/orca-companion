# Kilo `--mini` 输入协议与 session 生命周期（源码事实）

固定快照：Kilo 7.8.8，commit [`e2887f08e5a6394299c810ba508f358aaf4c5bc3`](https://github.com/Kilo-Org/kilocode/tree/e2887f08e5a6394299c810ba508f358aaf4c5bc3)（Kilo 是 opencode fork，CLI 源码在 `packages/opencode/`）。UI 层依赖外部 `@opentui/core`、`@opentui/keymap`、`@opentui/solid` **0.5.11**（[package.json](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/package.json) L42-43、L88），本文对它们的引用来自 npm 发布包内的已编译代码，不是 Kilo 仓库源码。

## 结论

1. mini 的提交键不是渲染器默认，而是 Kilo keymap 层：`input.submit` 默认绑定 `return`（CR），`input.newline` 只含 `shift/ctrl/alt+return` 与 `ctrl+j`；`prompt_submit` 默认是 `none`。LF（`linefeed`）没有默认绑定。
2. 焦点在 managed textarea 上时，opentui 会给该 textarea 置 `traits.suspend`，渲染器自带键表（默认 `return`→newline、`meta+return`→submit）被跳过；控制字符又永不写入缓冲区。因此 **CR 提交、LF 静默丢弃**。
3. 渲染器从不输出 `?2004h`；只有收到 `ESC[200~…ESC[201~` 才走 paste 分支，一次性原样插入（含换行）。宿主注入裸多行字节时，其中每个 CR 都会被当作提交。
4. 自动补全菜单可见时，`prompt.autocomplete.select` 同样绑定 `return`，Enter 会选中候选项而不提交。
5. 启动无 prompt：`kilo --mini`（无 `--session/--continue`）在启动微任务里就创建 session 并发布 `session.created`；该路径不经过 `KiloHeadless.mark`，权限询问需要在 footer 里人工回答。
6. `session.created/deleted` 是 durable 事件：projector 插入 session 行并在同一事务提交后才通知监听者，所以 reporter 在 `session.created` 里嵌套 `kilo export <ID>` 能查到该 session——但此时 `messages` 为空。
7. 插件 `event` hook 是 `void` 触发、不 await、不 catch：handler 内 throw 不会进入 publish 的 Effect 失败路径，Kilo 源码中也没有「插件抛错 → 删除 session」的调用路径。
8. 每次 CLI 启动（含 `export`）都会 `wal_checkpoint(PASSIVE)` + `DatabaseMigration.apply` + `compat`，即 export 进程在启动阶段是写者；WAL 允许并发读，但与 mini 的写锁冲突时会耗尽 5s busy_timeout。

## 输入提交链（源码定位）

| 环节 | 位置 |
| --- | --- |
| `<textarea onSubmit={props.onSubmit}>` | [run/footer.prompt.tsx L269](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/footer.prompt.tsx#L269) |
| `onSubmit` → `submitPrompt(clone(draft))` | 同上 [L1221](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/footer.prompt.tsx#L1221) |
| `submitPrompt`：菜单可见先 `select()`；空文本提示 `empty prompt ignored` | 同上 [L1165-L1180](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/footer.prompt.tsx#L1165) |
| footer 派发到 prompt 队列 | [run/footer.ts L749](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/footer.ts#L749)、[run/runtime.queue.ts L317](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.queue.ts#L317) |
| 每轮 `runPromptTurn`（带 model/variant/files） | [run/runtime.ts L651-L672](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.ts#L651) |

键位（Kilo 侧默认值，均可被用户 keybind 配置覆盖）：

- [tui/src/config/keybind.ts L158](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/config/keybind.ts#L158) `prompt_submit: "none"`
- [L168](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/config/keybind.ts#L168) `input_submit: "return"`；[L169](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/config/keybind.ts#L169) `input_newline: "shift+return,ctrl+return,alt+return,ctrl+j"`
- [L222](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/config/keybind.ts#L222) `"prompt.autocomplete.select": "return"`
- mini 生命周期确实安装该层：[run/runtime.lifecycle.ts L198-L199](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts#L198) → [tui/src/keymap.tsx L229-L232](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/keymap.tsx#L229)（`enabled` 条件仅为 managed textarea 获得焦点），别名 `enter`→`return` 在 [keymap.tsx L110-L116](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/keymap.tsx#L110)。

opentui 侧（`@opentui/core@0.5.11` 发布包 `index.bun.js`）：

- `defaultTextareaKeyBindings`：`{name:"return",action:"newline"}`、`{name:"linefeed",action:"newline"}`、`{name:"return",meta:true,action:"submit"}`（L8745-L8800）。这是渲染器自带默认，Kilo 用 managed layer 覆盖它。
- `EditBuffer.handleKeyPress`：仅在 `traits.suspend !== true` 时查自带键表；之后只有首字符码 ≥32 的序列会被写入，`firstCharCode < 32` 直接返回（L8917-L8939）。
- `registerTextareaMappingSuspension`（`@opentui/keymap@0.5.11` `src/addons/opentui/index.js` L313-L350）在 focused editor 上置 `traits.suspend`；`registerManagedTextareaLayer`（同文件 L435-L457）用 command 名 `input.submit`/`input.newline`（L100-L142）注册层。
- stdin parser 识别 `BRACKETED_PASTE_START = Buffer.from("\x1B[200~")` / `...END`（chunk `chunk-node-70eg2nhg.js`）；`EditBuffer.handlePaste` 把解码文本原样 `insertText`（L8914-L8916）。Kilo 的 `RunPromptBody onPaste` 只做布局刷新（footer.prompt.tsx L270-L273）。发布包中没有 `?2004h` 的写出点。

## 启动无 prompt 的行为

- 入口：`kilo --mini` 走 [run.ts L1159-L1189](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run.ts#L1159)（要求 TTY stdout，[L341-L343](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run.ts#L341)）→ `runInteractiveLocalMode`（[run/runtime.ts L742](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.ts#L742)），session 解析本身是惰性的。
- 但 `eagerStream()` 对新会话返回 false（[runtime.ts L145-L147](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.ts#L145)），随后 `queueMicrotask(() => ensureStream())`（[runtime.ts L712-L720](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.ts#L712)）→ `ensureSession()`（[runtime.ts L210-L227](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run/runtime.ts#L210)）→ `session()` 的创建分支 `sdk.session.create({ title, permission })`（[run.ts L609-L626](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run.ts#L609)）。该调用不传 agent/model，`--model` 只在每轮 `runPromptTurn` 生效。
- 首屏：`session.first = true` 时 placeholder 为 `Ask anything...`（footer.prompt.tsx L289-L296），`state.shown` 为 false，启动期不渲染历史。
- 权限：新会话 mini 不进入 `execute()`，而 `KiloHeadless.mark(sessionID)` 只在 `execute()` 内（[run.ts L780](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/run.ts#L780)）。只有 `--session/--continue` 的恢复路径走 `execute → runInteractiveMode`。含义：新会话 mini 的 `permission.asked` 需要 footer 应答（`onPermissionReply`，runtime.lifecycle.ts L236-L241；`run/footer.permission.tsx`），无人应答就会挂住。

## session 生命周期发布与插件 hook

- 事件定义带 durable 选项（`aggregate: "sessionID"`，[schema/src/v1/session.ts L548-L553](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/schema/src/v1/session.ts#L548)），Created/Updated/Deleted/MessageUpdated… 在 [L618-L680](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/schema/src/v1/session.ts#L618)；`session.error` 是非 durable 的独立事件（L698-L704）。
- durable publish 顺序：`db.transaction(..., { behavior: "immediate" })` 内先跑 projectors 再提交（[core/src/event.ts L246-L345](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/event.ts#L246)，projector 循环 L330），提交返回后才 `notify(event, true)`（[L399](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/event.ts#L399)）。
- `session.created` 的 projector 就是插 `session` 行（[core/src/session/projector.ts L230-L253](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/session/projector.ts#L230)）；发布点 [session/session.ts L665](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/session/session.ts#L665)。v2 服务同构：[core/src/session.ts L244](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/session.ts#L244)。
- `session.deleted` 只在 `Session.remove` 路径发布（[session/session.ts L745](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/session/session.ts#L745)）。本快照中没有找到「启动即删除空 session」的调用点；显式删除入口是 `kilo session delete`（[cli/cmd/session.ts L63](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/session.ts#L63)）与 TUI 对话框；保留策略 `kilocode/session/retention.ts` 需要显式开启 `enabled`。
- 插件 hook：[plugin/index.ts L265-L272](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/plugin/index.ts#L265) 先按 `event.location?.directory !== ctx.directory` 过滤，再 `void hook["event"]?.(...)`。EventV2 监听器外层的隔离（[event.ts L408-L414](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/event.ts#L408)，只 `logError("Event listener failed")`）只覆盖同步段，hook 的异步 reject 不在其中。

因此：`session.created` 处理器里 throw 不会让 publish 失败，也不会触发 `Session.remove`；它只是 CLI 进程里的未处理 rejection。是否因此终止进程属于 Bun 运行时行为，源码未覆盖。

## `kilo export ID --pure` 与运行中进程的关系

- `--pure` 是全局选项 → `KILO_PURE=1`（[src/index.ts L73-L83](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/index.ts#L73)），外部插件整体不加载（[plugin/index.ts L191](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/plugin/index.ts#L191)），嵌套 export 不会再次加载 reporter 插件。
- export 只做读查询：`svc.get(sessionID)` + `svc.messages({sessionID})`，输出 `{info, messages}`（[cli/cmd/export.ts L288-L296](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/opencode/src/cli/cmd/export.ts#L288)）；无 session 锁、无 in-progress 判定。
- 但每个 CLI 进程建库时都会写：`PRAGMA busy_timeout=5000`、`journal_mode=WAL`、`wal_checkpoint(PASSIVE)`、`DatabaseMigration.apply`、`compat`（[core/src/database/database.ts L31-L39](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/core/src/database/database.ts#L31)），且先 `DbPreflight.assertWritable(filename)`（同文件 L46）；`src/index.ts L86` 的 `KiloCli.bootstrap` 还包含 telemetry、legacy JSON→SQLite 与 auth 迁移。
- WAL 下并发读可行；但 export 进程在启动阶段参与写，若此刻 mini 持有写锁，export 会在 5s busy timeout 后失败，源码内没有更长等待或重试；Companion 侧 `spawnSync` 的 7s 上限是外部约束。
- 时间点：`session.created` 触发时 session 行已提交（projector 在事务内、notify 在提交后），export 能查到该 ID；但消息尚未产生（由 `message.updated` projector 追加），得到的 `messages` 是空数组。

## 对下一次实验的直接含义（仅源码事实）

- 想让注入的多行文本整体落入 composer 而不触发提交，源码上唯一现成通道是 bracketed paste：`ESC[200~` + 文本 + `ESC[201~`。裸写 LF 不产生换行；裸写 CR 立即提交当前草稿。
- 提交前要让 `@` 菜单处于隐藏态：cursor 落在「行首或空白后的 `@` + 后续无空白」的 token 内时，Enter 会选中补全项（footer.prompt.tsx L1168-L1173 + keybind.ts L222 + [tui/src/prompt/display.ts L38-L48](https://github.com/Kilo-Org/kilocode/blob/e2887f08e5a6394299c810ba508f358aaf4c5bc3/packages/tui/src/prompt/display.ts#L38)）。
- 报告若在 `session.created` 里取 export，只会拿到空 `messages`；需要等 `message.updated` 之后。
- 启动即出现的 `session.error` / `session.deleted` 尚未由本快照源码解释，需要在原生日志里确认是哪条 delete 路径触发。

## 未知与冲突

- Orca `worker-start` 实际写入终端的字节（是否 bracketed、CR 还是 LF）不在 Kilo 源码内，需另行取证。
- keymap 层未匹配键（尤其 `linefeed`）是否还有其它兜底路径未逐条追完；「LF 被丢弃」由 suspend + 控制字符守卫推出，未在真机复验。
- 未处理 reject 是否终止 Bun 进程：无源码依据。
- `@opentui/*` 为外部依赖，此处结论基于 0.5.11 发布包（与 Kilo 锁文件一致）；若用户 keybind 配置覆盖 `input.submit`/`input.newline`，结论随之改变。

## 本机复验命令（只读源码，不启动 harness）

```sh
REPO=/tmp/kilosrc   # git init; git remote add origin https://github.com/Kilo-Org/kilocode.git;
                    # git fetch --depth 1 --filter=blob:none origin e2887f08e5a6394299c810ba508f358aaf4c5bc3; git checkout FETCH_HEAD
rg -n 'input_submit|input_newline|prompt_submit' $REPO/packages/tui/src/config/keybind.ts
rg -n 'registerManagedTextareaLayer' $REPO/packages/tui/src/keymap.tsx
rg -nF 'submitPrompt' $REPO/packages/opencode/src/cli/cmd/run/footer.prompt.tsx
rg -n 'db.transaction|notify\(event as Payload, true\)|Event listener failed' $REPO/packages/core/src/event.ts
rg -n 'busy_timeout|wal_checkpoint|DatabaseMigration.apply|assertWritable' $REPO/packages/core/src/database/database.ts
rg -n 'void hook\["event"\]|flags.pure' $REPO/packages/opencode/src/plugin/index.ts
```

opentui 侧（npm 发布包）：

```sh
cd /tmp/kilo/npm/core/package   # npm pack @opentui/core@0.5.11 解包目录
rg -nF 'defaultTextareaKeyBindings' index.bun.js   # L8745 起
rg -nF 'traits.suspend !== true' index.bun.js      # L8917 handleKeyPress
grep -c '\[?2004h' index.bun.js                    # 无匹配：渲染器不开启 bracketed paste
```
