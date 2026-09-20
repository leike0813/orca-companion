/**
 * MOD-03：Coordinator graph 的组装
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 图的形状刻意很小：一次 `model` 调用，然后要么继续消费剩下的有界工作，要么走向 `suspend`
 * 结束本次 invoke。挂起与失速都不重启整张图——恢复由 Controller 在拿到 Runtime Lease 后以同一
 * thread 重新 invoke 完成（D5）。
 *
 * `recursionLimit` 只是高位技术保险，不作为业务预算；模型调用的有限重试只配置在 model node 上，
 * 且内层重试已在 `resolveChatModel` 中关闭，避免次数相乘（D15）。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { END, START, StateGraph } from '@langchain/langgraph';

import type { CoordinationMode } from '../../domain/coordination/mode.js';
import {
  planningToolset,
  toBindableTools,
  type PlanningToolDefinition,
  type PlanningToolFacts,
  type PlanningToolServices,
} from './planning-tools.js';
import {
  COORDINATOR_GRAPH_CHANNELS,
  type CoordinatorGraphState,
} from './state.js';
import {
  createModelNode,
  createSuspendNode,
  MODEL_NODE,
  SUSPEND_NODE,
  type CoordinatorNodeDependencies,
} from './nodes.js';

export type CoordinatorGraphDependencies = CoordinatorNodeDependencies & {
  /** 由 storage adapter 提供；图只消费它，不创建它。 */
  readonly checkpointer: BaseCheckpointSaver;
  /**
   * 本次组装要暴露的规划工具。
   *
   * 可见性已由 `planningToolset` 按模式与事实决定，图只做协议适配；不传表示不暴露任何工具，因此
   * 「忘记配置」不会意外打开规划写入。
   */
  readonly planningTools?: readonly PlanningToolDefinition[];
};

/**
 * 按模式注册规划工具。
 *
 * 模式门在图的组装处再判一次：即使调用方把工具集传错，非规划模式下也不会把规划工具绑到模型上。
 */
export function registerPlanningTools(input: {
  readonly mode: CoordinationMode;
  readonly facts: PlanningToolFacts;
  readonly services: PlanningToolServices;
}): readonly PlanningToolDefinition[] {
  if (input.mode !== 'route_planning') {
    return [];
  }
  return planningToolset({ ...input.facts, mode: input.mode }, input.services);
}

/**
 * 把已过滤的规划工具绑定到模型上。
 *
 * 绑定后的对象仍是可 invoke 的模型：节点只依赖 `invoke`，因此这里在图的组装边界完成协议适配，
 * 不在节点里引入工具体系。模型未实现 `bindTools` 时保持原样，不伪造工具能力。
 */
export function bindPlanningTools(
  model: BaseChatModel,
  definitions: readonly PlanningToolDefinition[],
): BaseChatModel {
  if (definitions.length === 0 || model.bindTools === undefined) {
    return model;
  }
  return model.bindTools([...toBindableTools(definitions)]) as unknown as BaseChatModel;
}

/** 条件边：继续消费工作、结束于挂起，或直接结束（失速 / 阻塞由 Controller 处理）。 */
export function routeAfterModel(state: CoordinatorGraphState): typeof MODEL_NODE | typeof SUSPEND_NODE | typeof END {
  if (state.status !== 'running') {
    return END;
  }
  return state.remainingWork.length > 0 ? MODEL_NODE : SUSPEND_NODE;
}

/** 空投影直接挂起；只有已准入的 Actionable Work 才能进入模型节点。 */
export function routeAtStart(state: CoordinatorGraphState): typeof MODEL_NODE | typeof SUSPEND_NODE {
  return state.remainingWork.length > 0 ? MODEL_NODE : SUSPEND_NODE;
}

/**
 * 组装 Coordinator graph。
 *
 * 调用方负责传入 checkpointer 与 chat model；这个函数不创建 provider、不打开数据库、不读时钟。
 */
export function buildCoordinatorGraph(dependencies: CoordinatorGraphDependencies) {
  const model = bindPlanningTools(dependencies.model, dependencies.planningTools ?? []);
  return new StateGraph(COORDINATOR_GRAPH_CHANNELS)
    .addNode(MODEL_NODE, createModelNode({ ...dependencies, model }))
    .addNode(
      SUSPEND_NODE,
      createSuspendNode({
        sessionRecords: dependencies.sessionRecords,
        assertFencing: dependencies.assertFencing,
      }),
    )
    .addConditionalEdges(START, routeAtStart, {
      [MODEL_NODE]: MODEL_NODE,
      [SUSPEND_NODE]: SUSPEND_NODE,
    })
    .addConditionalEdges(MODEL_NODE, routeAfterModel, {
      [MODEL_NODE]: MODEL_NODE,
      [SUSPEND_NODE]: SUSPEND_NODE,
      [END]: END,
    })
    .addEdge(SUSPEND_NODE, END)
    .compile({ checkpointer: dependencies.checkpointer });
}
