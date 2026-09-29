/**
 * MOD-03：Coordinator 工具的共享形状（Owner: `m2-wire-execution-runtime`，IP-03）。
 *
 * 规划工具与执行工具是两个族，但只有一个工具协议：受控 tools 节点（D5 的串行执行、逐 call 落盘与
 * 重放安全）与绑定给模型的包装器都只依赖这里的形状。把形状抽出来，新增一个工具族时就不需要第二套
 * 执行协议，也不会出现「某个族的结果无法配对」的第三种取值。
 *
 * `name` 在共享形状里是宽字符串：每个族各自维护自己的封闭名字联合（`PlanningToolName`、
 * `ExecutionToolName`），由各自的工具集函数在组装与恢复时判定。在这里汇总成一个跨族大联合会让
 * 新增一个工具改动所有族的类型，而工具注册表本来就应该是可组合的。
 */

import type { OperationId } from '../../application/dto/identity.js';

/** 工具调用的结果闭集：`accepted` / `rejected` / `unknown` 三值，与 IC-02 的操作结果同构。 */
export type CoordinatorToolOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * 一次受控调用的可信身份。
 *
 * 它由宿主在提交模型响应时分配并随 call 一起持久化，模型不可填写：handler 只把它转发给用例，
 * 因此「用新身份重试一个已发起的副作用」在结构上不可能发生。只读工具忽略它。
 */
export type CoordinatorToolCallContext = {
  /** 主操作的 OperationId。 */
  readonly operationId: OperationId;
  /** 该 call 触发的第二次独立副作用；没有时为 `null`。 */
  readonly mapOperationId: OperationId | null;
};

/** 一个工具定义；输入 schema 是 JSON Schema，工具层不引入第二套类型系统。 */
export type CoordinatorToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  /** 成功结果本身已处理当前工作；只用于可独立收尾的单次动作。 */
  readonly completesWorkOnSuccess?: true;
  readonly inputSchema: Record<string, unknown>;
  /** 执行只发生在受控 tools 节点；身份取自调用上下文，不取自模型输入。 */
  readonly invoke: (input: unknown, context: CoordinatorToolCallContext) => Promise<CoordinatorToolOutcome>;
};

/** 工具输入必须是对象；数组与原始值在边界被拒绝，不做猜测性转换。 */
export function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** 工具输入 schema 的统一形状：闭合属性集，因此未登记字段不可能被读成一次委托。 */
export function toolInputSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
