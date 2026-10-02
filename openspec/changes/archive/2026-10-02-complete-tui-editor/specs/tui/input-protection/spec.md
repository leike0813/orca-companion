## ADDED Requirements

### Requirement: 光标插入与原子粘贴块
粘贴 SHALL 在光标处插入，把 CRLF/CR 规范为 LF，保留缩进、tab 与末尾空行。超过 1000 Unicode code points 的单次粘贴 SHALL 显示有稳定身份、序号和字符数的折叠块；1000 及以下 SHALL 为普通文本。块 SHALL 原子移动和删除，内部不可编辑。完整展开正文 SHALL 是唯一发送载荷；保存 SHALL 只记录块身份与有序非重叠范围，光标 SHALL 位于 grapheme 边界且不在块内。容量 SHALL 按全文计量一次，不截断。`/paste` 与 Palette SHALL 提供有界全文查看，Esc SHALL 恢复原草稿和光标。

#### Scenario: 中间粘贴保留原文
- **WHEN** 用户在已有正文中间粘贴含 tab、CRLF 和末尾空行的内容
- **THEN** 规范后的完整内容立即保存，插入点之后原文保留且不自动发送

#### Scenario: 阈值与原子操作
- **WHEN** 用户分别粘贴 1000 和 1001 个 Unicode code points 并移动删除
- **THEN** 只有后者折叠，移动跨过整块且删除去掉整块，发送从完整正文取值

#### Scenario: 查看与持久恢复
- **WHEN** 用户查看折叠块后退出查看或重启
- **THEN** 草稿全文、稳定块身份及光标恢复，无标记解析或重复载荷

#### Scenario: 非法草稿失败关闭
- **WHEN** 存储收到越界、重叠、重复身份或光标在块内的草稿
- **THEN** 写入拒绝且已有数据保留
