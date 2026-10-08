## MODIFIED Requirements

### Requirement: Immutable versioned model settings

项目配置 SHALL 使用 schema 5 并保存 Coordinator 的 provider connections、models、完整 Coordinator configurations 与按角色绑定的 Worker Profiles。用户级连接和模型库 SHALL 支持跨项目复用及一个连接对应多个模型。编辑 SHALL 追加不可变引用并以 revision CAS 原子保存；项目及 Session SHALL 使用明确选择的完整快照，保存和目录刷新 MUST NOT 自动改变 Session 或已批准 Manifest。Coordinator 连接 SHALL 仅使用 API Key，预设/协议、地址及不透明 credentialRef，MUST NOT 接受任意 SDK options、模块导出或认证注入路径。Worker Profile SHALL 继续绑定已注册 harness 与不可变 modelSelection。旧 schema、未知引用、重复身份、秘密字段与无可信 effort SHALL 明确拒绝，不迁移、不改写用户文件。

#### Scenario: 跨项目复用与多模型
- **WHEN** 用户为同一个连接保存多个模型并在两个项目选择它们
- **THEN** 连接和凭据可复用，每个项目保存自身明确选择的完整不可变快照

#### Scenario: 保存与应用独立
- **WHEN** 用户编辑连接、Key 或模型并保存
- **THEN** 既有 Session、Manifest、Task 和消耗预算不变，显式应用才核验并更新绑定

#### Scenario: 冲突和文件失败保留输入
- **WHEN** 文件已被其他编辑修改或写入/回读失败
- **THEN** 保存失败且保留编辑，不覆盖较新配置、不宣称生效

#### Scenario: 旧 schema 明确拒绝
- **WHEN** 读取 schema 1、2、3 或 4 的项目配置
- **THEN** 结构化拒绝并保留文件，不自动回退或迁移

#### Scenario: 复杂或秘密字段被拒绝
- **WHEN** 输入模块导出、任意 options、认证模式、注入路径或 Worker-only 连接字段
- **THEN** 配置拒绝且不写入候选连接或秘密

#### Scenario: 旧记录与旧指纹兼容
- **WHEN** 读取 schema 5 内保存的旧不可变 Coordinator 快照
- **THEN** 仍按原引用使用完整快照，编辑不改写其指纹；schema 4 和更早格式按旧 schema 拒绝规则处理

#### Scenario: 非法 nativeWorker 组合被拒绝
- **WHEN** 配置中出现 nativeWorker 字段或其任何键
- **THEN** 结构化拒绝且不写入连接记录

#### Scenario: Worker-only 连接字段不再被接受
- **WHEN** 配置中出现 Worker-only codex 字段
- **THEN** 结构化拒绝且不写入连接记录，Coordinator 使用 API Key 合同

## ADDED Requirements


### Requirement: Saved discovered and verified states are distinct

网络离线或核验失败 SHALL 允许保存合法连接及模型；保存、目录取得与模型核验 SHALL 分别呈现。实际启动或显式应用 MUST 通过必需能力核验。失败 SHALL 保留原绑定与编辑并提供重试或修改入口，MUST NOT 自动换模型。

#### Scenario: 离线保存与拒绝应用
- **WHEN** 配置可保存但端点不可达
- **THEN** 保存成功、模型未验证；应用拒绝且原 Session 绑定不变
