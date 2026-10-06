## MODIFIED Requirements

### Requirement: doctor 核验环境与公开契约，缺失时拒绝启动

`orca-companion doctor` SHALL 在无 TTY 环境下可运行，把机器输出写入标准输出、诊断写入标准错误；SHALL 核验 Orca 可执行文件版本、runtime 可达性、host 环境、协调者身份可取得性，以及 M0 依赖的公开命令与机器可读输出的存在。在既有前置检查通过后，doctor SHALL 按每个被当前配置引用的 Worker Profile 分别输出实际能力结论，至少覆盖可执行版本、精确会话身份与 runtime roots 报告、原生模型目录可用性与只读包装器；未配置的角色不假装核验过。模型目录不可用时 SHALL 只把该 harness 候选标为不可用并允许手填 exact ID，不单独决定退出码。doctor SHALL NOT 以 harness 名称、版本字符串、配置文件存在或按 harness 名称的 blanket 门禁代替实际能力核验。缺失 M0 必需能力时 doctor SHALL 以非零退出码失败并指明缺失项，SHALL NOT 自动回退、伪造身份或绕过缺口继续。

#### Scenario: 环境完整

- **WHEN** Orca 可用、runtime 可达且协调身份可取得
- **THEN** doctor SHALL 以退出码 0 输出各项核验结论

#### Scenario: 无 TTY 运行

- **WHEN** doctor 在没有 TTY 的管道中运行
- **THEN** doctor SHALL 正常运行并把机器输出写入标准输出、诊断写入标准错误

#### Scenario: 协调身份不可取得

- **WHEN** 无法取得可证明的协调者终端身份
- **THEN** doctor SHALL 以非零退出码失败并将该项标记为缺失，SHALL NOT 报告成功

#### Scenario: Orca 版本或 runtime 不可用

- **WHEN** Orca 不可执行或 runtime 不可达
- **THEN** doctor SHALL 以非零退出码失败并区分不可达与版本不符两类原因

#### Scenario: 逐 harness 能力核验

- **WHEN** 配置引用了多个已注册 harness
- **THEN** doctor 为每个被引用 harness 输出独立结论与诊断；某一 harness 能力缺失只把该项标记失败，不把其它 harness 的结论套用到它

#### Scenario: 名称或版本存在不等于能力

- **WHEN** 某 harness 的可执行文件与版本可读，但精确会话身份、runtime roots 报告、模型目录或只读包装器不可核验
- **THEN** doctor 报告该项能力缺失并以非零退出码结束，不按 harness 名称放行
