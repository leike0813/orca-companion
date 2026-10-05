# 手动提交的需求文本

下面几段文本由你在 Companion 里手动提交，用来驱动 `ledger-lab` 的规划与实现。整块复制即可，方括号处按实际情况替换。

提交时不要粘贴参考图、节点编号或 Graph JSON；参考图与字段取值只在操作者一侧核对（见 `contract.json`）。每段文本的提交时机与观察点见 `guide.md`。

## 初始需求（initial）

```
请为我实现一个离线账单分析工具，项目名叫 ledger-lab。使用 Node.js，不引入第三方依赖，入口固定为 src/cli.mjs。

一、命令与参数
  node src/cli.mjs <input.json> --format json|csv --threshold-cents <整数> --line-ending lf|crlf

- --format 可选，默认 json；取 json 或 csv，非法按 INVALID_ARGUMENT 处理。
- --threshold-cents 可选，默认 5000；取值必须是 0 到 1000000 之间的安全整数，否则 INVALID_ARGUMENT。
- --line-ending 可选，默认 lf，取 lf 或 crlf，否则 INVALID_ARGUMENT。
- 未知参数同样按 INVALID_ARGUMENT 处理。

二、输入契约
输入是一个 JSON 数组，最多 100 条。每条记录形如 {"id":"a1","category":"餐饮","merchant":"Star Cafe","amountCents":12000}。
- id、category、merchant 必须是非空字符串；只对去掉首尾空白后的结果做校验，输出保留原值，不 trim、不改大小写、不做归一化。
- id 在数组内唯一。
- amountCents 必须是 0 到 1000000 之间的安全整数。

三、JSON 输出（--format json）
顶层只输出 totalCents、byCategory、largePayments、duplicateGroups 四项，不得多也不得少。
- totalCents：全部记录金额之和。
- byCategory：数组，每项是 {"category","count","totalCents"}；按 category 的 UTF-16 码元升序排列，用字符串的 < 比较，不要用 localeCompare（避免环境相关的排序结果）。
- largePayments：amountCents 大于等于 --threshold-cents 的记录 id 数组，按 id 的 UTF-16 码元升序。
- duplicateGroups：同 merchant、同 amountCents、不同 id 的记录构成疑似重复组；每个组是 id 数组，组内按 UTF-16 升序，组之间按首元素升序。

四、CSV 输出（--format csv）
表头固定为 id,category,merchant,amountCents。
- 严格遵守 RFC 4180 引用规则：字段只要包含逗号、双引号、CR 或 LF 就必须加双引号，字段内的双引号写成两个双引号。merchant 是最容易踩坑的字段。
- 行尾严格等于 --line-ending：lf 用 \n，crlf 用 \r\n，不得混用；文本末尾是否带一个换行可选。
- 行序：初始按 id 的 UTF-16 码元升序。
- category 输出原值，不归一化。

五、错误契约
- 成功时退出码 0，且 stderr 为空。
- 失败时退出码 2，stderr 输出可解析的 JSON，其中稳定错误码只取自：INVALID_ARGUMENT（参数非法）、READ_ERROR（读文件失败）、INVALID_JSON（JSON 解析失败）、INVALID_LEDGER（账单内容非法：记录数超限、重复 id、缺字段、只有空白的字段、金额类型或范围非法）。错误码可以放在顶层 code，也可以放在嵌套字段（如 error.code）；message 文本不被比较。

六、内部模块与协作
按职责拆成可独立实现、可独立验证的模块：
1. 输入契约模块：读取文件、解析 JSON、按第二条校验，产出规范记录。
2. 统计模块：产出 totalCents 与 byCategory。
3. 审计模块：产出 largePayments 与 duplicateGroups。
4. 导出行准备模块：把记录整理成确定顺序的 CSV 行（表头加数据行）。
5. CSV 写入模块：把行按第四条编码成文本。
6. 报告组装模块：把统计与审计结果组装成第三条的 JSON。
7. CLI 集成模块：解析参数，串联以上模块，写出 stdout、stderr 与退出码。
8. 独立文本报告：单独的入口 node src/text-report.mjs <input.json>，只依赖输入契约与报告组装，输出人类可读的最小摘要（例如总金额、分类数、大额与重复数量），不经过 src/cli.mjs。

协作约束：统计与审计只依赖输入契约，二者互相独立；导出行准备也只依赖输入契约。CSV 写入依赖导出行准备；报告组装依赖统计与审计；CLI 集成依赖报告组装与 CSV 写入；文本报告只依赖输入契约与报告组装，使用独立入口，不修改 src/cli.mjs。统计、审计、导出行准备这三个模块应允许并行推进，每条独立工作同时只保留一个执行者。请让各模块有清晰的接口与数据契约。

七、CSV 运行验收材料
CSV 的格式规则（列、引用、行尾、排序）在本需求里已经完整确定，请据此实现，不要因为没有样例就不开工。实际导出验收需要一个具体样例：我会在执行过程中给出一个小的 JSON 输入和一份手写的 CSV 期望。

CSV 的独立验收需要先向我索取该样例；在样例到手之前，其他模块应继续推进，不要因为等这个样例而停下整条流程。

不要依赖任何模板或参考实现；以上接口就是完整规格。
```

## C1 规格修订（revision-c1，须在 C1 尚未 Accepted 时提交）

```
请修订导出行准备模块的排序规则：输出行按 amountCents 从大到小排列，金额相同时按 id 的 UTF-16 码元升序。CSV 的列、引用与行尾规则不变，category 仍输出原值。
```

## A/F/R 图补丁需求（patch-afr，须在 A 尚未 Accepted 时提交）

```
请做一次结构性调整，作为整体提交：

1. 新增一个独立的分类归一化前置模块：把 category 按固定映射归一化，餐饮→food、交通→travel，其余保留原值。
2. 统计模块改为使用归一化后的类别聚合 byCategory；CSV 仍输出原始 category。
3. 去掉第 8 项的独立文本报告：移除 src/text-report.mjs 入口与对应模块，不再需要。
```

## CSV 运行验收材料（late，在导出 lane 提问后提供）

这里给出可直接粘贴的完整材料。把下面的通知与选中版本的 JSON、CSV 正文一起粘贴给 Companion；不要让待测系统去读操作指南或本包。

通知模板：

```
这是我提供的 CSV 运行验收样例，请据此完成 CSV 的独立验收。版本：<initial|revised|privacy>；行尾：<lf|crlf>。

业务输入 JSON：
<粘贴下面的 JSON 正文>

手写 CSV 期望（表头 id,category,merchant,amountCents）：
<粘贴下面的 CSV 正文>
```

固定样例的业务输入 JSON（三个版本相同）：

```
[{"id":"b","category":"餐饮","merchant":"Acme, Inc.","amountCents":6000},{"id":"a","category":"交通","merchant":"Line1\nLine2","amountCents":100}]
```

initial 的 CSV 正文（行序 id 升序）：

```
id,category,merchant,amountCents
a,交通,"Line1
Line2",100
b,餐饮,"Acme, Inc.",6000
```

revised 的 CSV 正文（行序金额降序、同额按 id 升序）：

```
id,category,merchant,amountCents
b,餐饮,"Acme, Inc.",6000
a,交通,"Line1
Line2",100
```

privacy 的 CSV 正文（与 revised 相同，merchant 换成 `[redacted]`）：

```
id,category,merchant,amountCents
b,餐饮,"[redacted]",6000
a,交通,"[redacted]",100
```

行尾用你选的 lf 或 crlf；CSV 保留原始 category。样例以你提供的为准，这里只是固定可复用的起点。

## 隐私重规划需求（privacy，须在最终 CLI 尚未 Accepted 时提交）

```
方向有变化，需要按新目标重做：这个工具以后要对内对外分享，所有对外输出的 CSV 里的 merchant 字段必须替换成 [redacted]，避免泄露商户信息。

请在保留已有可用成果的基础上，按这个隐私目标重新规划并继续完成。已经通过验证并且仍然有效的部分可以沿用；未完成或需要改动的部分按新目标处理。
```

## 取消运行的初始需求（cancel）

```
请为我实现一个很小的独立工具，入口固定为 src/count.mjs。使用 Node.js，不引入第三方依赖。

运行方式：
  node src/count.mjs <input.json>

输入是一个 JSON 数组；把数组长度写到 stdout，只输出这个数字。

合法输入退出码 0；文件读不到、JSON 解析失败或输入不是数组时退出码 2。

只实现这一项功能，不要包含账单分析或其他任何功能。
```

## 取消（cancel 短剧本）

取消是 Scope 级控制操作，不做成聊天需求。在某个 Worker 正在运行时，通过界面或命令发起 Scope Cancel；若界面要求确认，按提示确认。需要留痕时可以在取消前补一句：

```
请取消当前 Scope 的执行。
```
