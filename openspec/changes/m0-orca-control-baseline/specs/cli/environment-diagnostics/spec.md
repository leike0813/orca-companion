## Purpose

定义 `orca-companion doctor` 的环境与能力核验契约，使使用者与后续 change 在启动协调流程前确认 Orca 版本、runtime 可达性、协调身份与 M0 所需公开命令契约均成立，并在缺失时得到明确拒绝。

## ADDED Requirements

### Requirement: doctor 核验环境与公开契约，缺失时拒绝启动

`orca-companion doctor` SHALL 在无 TTY 环境下可运行，把机器输出写入标准输出、诊断写入标准错误；SHALL 核验 Orca 可执行文件版本、runtime 可达性、host 环境、协调者身份可取得性，以及 M0 依赖的公开命令与机器可读输出的存在。缺失 M0 必需能力时 doctor SHALL 以非零退出码失败并指明缺失项，SHALL NOT 自动回退、伪造身份或绕过缺口继续。

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

