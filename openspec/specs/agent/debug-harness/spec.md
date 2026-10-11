# agent/debug-harness Specification

## Purpose
提供独立于项目协调业务的前台调试入口，使用户能在普通目录复用真实模型、工具、历史和输入管线，验证 agent loop 与终端交互，并在故障后保持可观测、可停止和可恢复。

## Requirements

### Requirement: Independent persistent debug conversations
`ocp --debug [directory]` SHALL 在指定目录或当前目录启动前台调试会话，允许非 Git 目录。用户 SHALL 明确选择新建或继续已有会话及已有模型配置；会话、checkpoint、草稿与诊断 SHALL 在用户状态目录独立持久化。调试 SHALL 复用真实模型和对话核心，不创建 Coordination Scope、执行图、Worker 或协调授权。

#### Scenario: 普通目录重启
- **WHEN** 用户在非 Git 目录开始调试、提交对话后退出并选择继续
- **THEN** 原 Session、已提交历史、未发送草稿和模型配置保持，界面只提供对话调试功能

### Requirement: Bounded read-only debug tools
调试 SHALL 提供 `list_files`、`read_file`、`search` 与 `git_diff`，限制目录边界、输出、处理量与时间，支持取消，拒绝通过绝对路径、父路径或符号链接逃逸。工具调用及结果 SHALL 经正式工具配对和历史管线反馈给模型与 transcript。

#### Scenario: 工具续接与路径逃逸
- **WHEN** 模型读取目录内文件后请求边界外文件
- **THEN** 首次调用结果可被后续模型使用，越界调用得到结构化拒绝，目录不发生写入

### Requirement: Shared repaired conversation behavior
调试 SHALL 共用普通模式的不可变模型元数据、真实协议用量、输入预算、待受理投影、可见文本来源、导航和区域鼠标合同；原调试身份与持久化目录边界保持。
#### Scenario: 调试发送及重开
- **WHEN** 调试发送含工具响应的消息并继续原 Session
- **THEN** 可见文本与工具活动分离，模型声明与用量绑定原配置，草稿、提交身份及导航行为与普通模式一致
