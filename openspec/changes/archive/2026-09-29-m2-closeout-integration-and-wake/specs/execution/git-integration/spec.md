## ADDED Requirements

### Requirement: 完整集成以获批目标的推送结算为界

Controller SHALL 仅在当前 Work Package 的完整 Git 集成已按获批 remote/ref 推送、结果确定并被接受后，将该包判为集成完成。commit 或 canonical merge 的单步成功 SHALL NOT 代替完整结论；中断后 SHALL 沿稳定操作身份核验并继续剩余步骤。

#### Scenario: commit 后中断

- **WHEN** commit 已被接受，但 canonical merge 或 push 尚无已接受结论时进程中断
- **THEN** 恢复后该 Work Package 仍待集成，已完成步骤沿原身份核验，未完成步骤在授权与对账门禁满足后继续

#### Scenario: 推送结算完成

- **WHEN** 当前 Work Package 的 push 到获批 remote/ref 已确定结算并被接受
- **THEN** Controller 将其判为集成完成，后续触发不会为该包创建第二次集成
