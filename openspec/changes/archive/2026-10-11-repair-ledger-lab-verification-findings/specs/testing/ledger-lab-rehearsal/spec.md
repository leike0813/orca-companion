## MODIFIED Requirements

### Requirement: Explicit repository reclamation

`pnpm lab cleanup --run ROUND_DIR` SHALL 只预览本轮本地/远程删除目标、身份、前置条件与保留项；加 `--yes` 才 SHALL 执行。删除 SHALL 以记录中已核验归属的目标为依据，预检发现符号链接逃逸、同路径替换目录或同名不同 ID 的远程仓库时 SHALL 拒绝；普通业务提交与 dirty files SHALL 不影响归属判定。远程写入 deleting 后、紧邻删除前 SHALL 再通过 GraphQL 核验记录的 nodeId、owner/name 和 URL，再通过公开 REST `DELETE /repos/{owner}/{repo}` 按记录名称寻址。DELETE 后 SHALL 复查原 nodeId 与 owner/name，只有两者都被证明缺失才标记 deleted 并继续本地删除；漂移、仍存在或不可核验 SHALL 保留现场且不自动重试。该接口无法以 nodeId 为原子删除条件，回收期间应保持远程目标稳定。用户 SHALL 先停止相关 ocp/Worker 并解除 Orca 登记；可观测的活跃运行或仍登记工作区 SHALL 导致回收拒绝并说明原因，回收 SHALL 不结束进程或注销项目。记录、安装包、operator、captures、checks 及外置报告 SHALL 保留。

#### Scenario: 预览无需执行删除

- **WHEN** 用户仅指定 `cleanup --run ROUND_DIR`
- **THEN** 命令 SHALL 展示精确目标及保留项，SHALL 不删除资源或改写回收进度

#### Scenario: 显式回收本轮仓库

- **WHEN** 用户已完成运行退出和 Orca 注销，目标身份匹配，并调用 `cleanup --run ROUND_DIR --yes`
- **THEN** 本轮远程及本地仓库 SHALL 被回收，各目标结果 SHALL 写入原记录，仓库外材料与证据 SHALL 保留

#### Scenario: 同名或同路径资源被替换

- **WHEN** 回收前发现远程 ID 或本地目录身份与记录不符
- **THEN** 命令 SHALL 拒绝删除不匹配的目标，输出结构化原因，SHALL 不因名称或路径相同而放行

#### Scenario: 已有业务改动

- **WHEN** 原仓库中存在新提交或未提交业务文件，且目标归属仍匹配
- **THEN** 预览 SHALL 明确本地内容会删除；`--yes` SHALL 授权删除该轮仓库，SHALL 不要求回到初始 HEAD 或清空改动

#### Scenario: 仍有运行资源

- **WHEN** 检测到相关活跃运行或尚未解除的 Orca 工作区登记
- **THEN** 命令 SHALL 拒绝删除，给出可操作的退出/注销步骤，SHALL 不自动终止模型或 Worker


#### Scenario: 删除前身份漂移及后置结果不明
- **WHEN** 最后核验发现目标漂移，或 DELETE 后原目标仍存在/不可核验
- **THEN** 前者不发送 DELETE，后者记录结果不明并保留本地现场；不自动重试

