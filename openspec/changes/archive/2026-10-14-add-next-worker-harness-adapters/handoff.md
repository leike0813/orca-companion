# Worker Harness 分级续办交接

当前基线为 `21ddd79` 后的工作区续办，任务见 tasks 6.1–6.4。完整结果、命令和原始工件索引见
[分级续验](../../../docs/research/worker-harness-graded-validation-20261014.md)。
首轮 verification 的 PASS 保留原 12 项范围；没有提交、归档或修改 Orca。

| 候选 | 当前等级 | 已取得的证据与剩余边界 |
| --- | --- | --- |
| Kimi 2.1.1 | enhanced | 四角色、Implementation exact resume、Validator 同 Session 上下文续接和 complete 历史；Recovery/mixed Controller 未验证 |
| Hermes | enhanced | 四角色及相同续接链通过；公开 export 仍为 partial，complete 未成立 |
| Kilo 7.8.8 | basic | 保留先前 Planner/Implementation，追加本轮 Validator 成功；其他角色和续接的 input_accepted 不证明输入进入模型 |
| Cline 3.0.70 | unavailable | 独立 native profile 可进入 MiniMax 界面，但监督接管 unknown；无基础两角色成功证据 |
| Muse / Cursor | unavailable | adapter 已登记；缺 CLI、原生登录、获批模型和真实矩阵绑定 |

等级来自 `worker-harness-qualifications.ts` 的逐能力事实与
`worker-harness-support.ts` 的唯一递进规则。模型回显不参与准入，只读按操作另验。
本轮没有增加 Recovery、mixed Controller 或只读资格；enhanced 不开放 Recovery Utility。

## 当前实现

- Kimi 普通/精确恢复启动使用原生 `--yolo`（Ask When Needed）。新 worktree 仍需原生信任；
  本轮只确认了精确测试目录，没有自动信任未来目录或修改默认权限。
- 真实验收 helper 先等原 Worker 确定结算，再核验同一原生快照；export 的有界重读适用于全部
  inspector。OpenCode/Hermes/Cline 的派生材料与当前覆盖范围共同刷新，仍拒绝不一致来源。
- blocked resume/continuation 的缺失证据保持未证明；只有真实运行后身份/上下文失败才记 failed。
- worker-start unknown 的后续夹具错误证据保留 OperationRef 与 reason。
- 生产公共 DTO、存储、授权合同与 registry 名单保持原结构；新增资格只开放对应角色。

## 保留现场与续办顺序

1. Kimi 的后续 complete 验证需先取得任务级只读拒写与真实 Recovery，然后跑独立 mixed Controller。
   本轮成功现场沿 `/var/tmp/orca-harness-acceptance-ehbi1C`、Run `run_bb51bb16dbd5`；
   不把纯矩阵当 Controller 证据。
2. Hermes 的 complete 仍受公开 export 不覆盖 inactive/compacted 历史限制。调查公开能力，
   不读私有数据库、不复制 Orca 状态机、不用当前上下文快照冒充完整历史。
3. Kilo 本轮现场 `/var/tmp/orca-harness-acceptance-jbiGU2`，失败输入/续接按原 Task/Dispatch
   核验；先解决实际输入与 Session 报告，不重复完整矩阵或追加 Enter 试探。
4. Cline 默认 profile 的两个 Dispatch `ctx_81e0314981ae`、`ctx_44c343d062c0`
   均 stop_unknown，保留原协调 handle `term_9d1b4f62-dc9a-421a-a772-61a841d2b242`
   与 Run `run_0aae1174fdbc`。修正 profile 对照的 Run `run_04187c36aedc`、
   Task `task_2f3eab160b74`、terminal `term_4b741988-7322-4326-a86e-fdf3444a2e69`
   未重发 worker-start；原 request ID 未由旧 helper 保留，空 worker-list 不证明操作未发生。
   对账或用户明确处置旧现场后再推进。独立 provider 文件为用户已批准的原生前置条件，
   不把本机路径硬编码到生产 launcher，不传明文 key。
5. Muse/Cursor 待获准安装、用户原生登录和明确模型后，再补验收 helper 的显式绑定；
   当前不要只设置 harness 开关就运行，也不要假设可复用 MiniMax endpoint。

本轮仅回收已结束验收、已证明 succeeded 且精确匹配原 terminal/fixture 的资源；
失败、unknown、未结 lane、协调终端及所有文件保留。回执和当前验证结果见分级续验报告。
