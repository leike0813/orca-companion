# configuration/tui-preferences Specification

## Purpose
定义独立于项目配置、协调状态和输入草稿的用户级 TUI 展示偏好，使同一用户在不同仓库、会话和重启后恢复明确保存的普通字段与图标选择，并保留失败或冲突时的编辑内容。

## Requirements

### Requirement: User presentation preferences with explicit persistence
系统 SHALL 恢复版本化用户偏好，包含 icon mode 与 statusline 格式、普通附加字段顺序及预算类别。缺失文件 SHALL 使用默认值；损坏、未来版本或不可读文件 MUST 保留原文件并显示不可保存原因。保存 SHALL 校验 expected revision，以短锁、原子替换和回读保持完整记录；冲突 SHALL 返回当前版本，不自动重试或覆盖。偏好 MUST NOT 进入业务 checkpoint 或 UI 输入库。图标与 statusline SHALL 分区保存，启动环境覆盖 MUST NOT 因另一区域保存而持久化。

#### Scenario: Restart and partitioned save
- **WHEN** 用户保存 ASCII 后重启，或使用临时环境图标覆盖并保存 statusline
- **THEN** 重启恢复已保存图标与 statusline；临时覆盖不被 statusline 保存写入文件

#### Scenario: Failure and conflicting hosts
- **WHEN** 两个宿主从同 revision 保存，或文件损坏、未来版本、不可写
- **THEN** 至多一个原 revision 保存成功，另一宿主保留草稿并看到当前版本或明确失败，原完整文件不被损坏覆盖

### Requirement: Approved custom editor and unsaved icon choice
Statusline 设置 SHALL 沿 custom-direct，在主区域实际宽度使用与生产相同的字段配色/裁切预览。↑↓选择、Space切换附加字段、←→顺序或格式、Enter明确保存、Esc丢弃并逐层返回；默认恢复 SHALL 只改草稿。成功 SHALL 关闭设置及命令层，恢复原 Session、composer/光标、阅读锚点、项目栏目与焦点。失败或 CAS 冲突 SHALL 保留草稿；迟到结果 MUST NOT 关闭新页面或覆盖后来编辑。图标选择 SHALL 即时生效，失败保持本次选择并显示未保存及重试入口，重启恢复最后保存值。

#### Scenario: Save and discard preserve the caller
- **WHEN** 用户从项目面板或对话进入设置，修改后保存成功或按 Esc
- **THEN** 成功直接返回原界面且应用保存值，Esc 逐层返回且不写文件，两条路径都保留原输入与阅读上下文

#### Scenario: Failed save followed by another page
- **WHEN** 保存未完成时用户返回并进入另一页，旧请求随后完成
- **THEN** 新页保持，原请求结果可核验但不会抢焦点，失败编辑仍可显式重试
