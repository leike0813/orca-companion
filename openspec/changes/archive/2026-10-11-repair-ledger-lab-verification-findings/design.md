## Context

直接依据为前驱 verification 的 T4 缺陷及用户批准方案；HEAD e6203fb。模型库与固定协议 adapters、IC-04 checkpoint、IC-11 history、IC-13 input 和 IC-16 debug 已存在。原型以 docs/dev/tui-implementation-handoff.md、#40 continuous、#47 above-input、#52 dialog final、#48 custom-direct 及其定稿源码/画面为准。

## Goals / Non-Goals

覆盖全部十一项 TUI 反馈及远程回收竞态收敛；普通/debug 共享实现。不新增依赖、通用 SDK options、附件上传、远程原子删除假设、业务剧本验收或 UI 重设计。

## Decisions

### D-01 模型定义与菜单

domain/model-configuration.ts 为 metadata schema owner；ModelDefinition 添加可选 contextWindow、inputModalities 与来源，配置与 debug 保存完整不可变快照。窗口为正安全整数，模态唯一非空含 text。旧缺失字段为未知，不修改历史引用。用户库 saveModel/catalog 保留精确匹配 metadata。ProviderLibraryEditor 分离候选搜索与手填/metadata 状态，复用 DialogFrame/ActionRow 与独立横向 effort。adapter 声明固定协议预设，OpenAI reasoning.effort、Anthropic outputConfig.effort、Gemini thinkingLevel；不开放路径编辑，声明与真实 probe 分开。

### D-02 真正 usage 与输入上限

SDK normalized usage 是 input/cache 归一来源。OpenAI 最终 usage 与 Gemini 已转换增量按真实请求汇总；Anthropic 首段包含输入及 output seed，后续 output 累计，adapter 校正为最后累计输出，禁止直接累加。模型 step 持久化 usage，按 Session/configuration 获取最新 committed step metadata，不读取全部正文。精确当前输入优先；否则显示明确的上次请求观察及窗口来源，新输入标历史、换配置失效。窗口将 context 输入预算限制为 min(project budget, window)，不改 project budget。缺 usage/window 保持未知。

### D-03 有界显示来源

checkpoint schema 5 添加派生文本 chunks/source mapping，保留原文、replay、turn 和 submission 身份。text blocks 只投影非 thought 的 text；工具仍在既有活动中。新响应提交时生成，旧 JSON 在 Bootstrap prepareInspection 中以每批最多64KiB增量 backfill，debug 同样准备。HistoryReadPort 增加独立可见文本来源，UTF-8 anchor/search 消费同一来源；raw 保留详情。render/query/resize 不全文解析、不落盘；缓存仍各8MiB/64项。未知/损坏身份拒绝，已登记无 checkpoint 的只读历史为空，恢复仍保持无 checkpoint。

### D-04 提交与状态

beginSubmission 先保存唯一原快照，再分离 composer 原草稿、展示 pending，随后 execute。新草稿可编辑，旧 lane 未结清不再发送。accepted 用 entry:user:submissionId 去重并只删快照；拒绝/unknown 保留原快照显式恢复，不回填覆盖新草稿。回答仍绑定原 interaction/revision。Controller 公开 AgentTurnState 并在开始/结束通知，TUI 只读取选中 Session；初始化 spinner 使用真实在途阶段。

### D-05 导航和鼠标

reader 内串行导航，session/dispose generation 使旧队列失效，读失败不改当前 frame。到底立即 following，短历史上翻 no-op 保持。共享 public stdin SGR filter 解码并吞掉协议，transcript box metrics 提供有界区域，wheel 三行；overlay 禁止，composer 从不接收鼠标字节。mount 启用、cleanup/退出禁用，不依赖 Ink 私有 emitter。

### D-06 回收

cleanup 的原 lock 下写 deleting → 紧邻 DELETE 核验 nodeId/name/url → 公开 REST DELETE → GraphQL 原 node+name 缺失证明 → 写 deleted → 本地原身份删除。漂移前拒绝、不发 DELETE；后置失败/仍存在为 unknown，不继续本地，不自动重试；原证据保留。用户接受最后一次核验与 name-addressed DELETE 间无法消除的竞态，不虚构 If-Match 或 ID 删除 API。

## Risks / Trade-offs

声明的模型窗口与模态不是 backend 能力证明；启动/apply probe 仍必需。usage 为上次请求，不能测量未发送输入。projection 增量迁移增加派生存储，但不改变历史权威。鼠标受终端 SGR 支持影响。GitHub 删除最后竞态仍存在。人工六票/真实 provider/真实业务验收不能由合成测试替代。

## Migration Plan

项目 schema5、用户库schema1、debug registry 保持当前格式，加可选 metadata；缺失为未知，无隐式文件 rewrite。checkpoint4→5 additive DDL，旧 JSON 显示准备有界进行；原始内容不改。迁移失败明确拒绝，不以空历史替代损坏。文档同步 IC-04/11/12/13/14/16 与当前 change/link。
