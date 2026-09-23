/**
 * MOD-03：Coordinator graph 的组装
 * （Owner: `m1-run-coordinator-sessions`；工具循环由 `m1-wire-foreground-planning-runtime` 接入）。
 *
 * 图的形状刻意很小：`model` 调用一次模型，有未决 tool call 就走 `tools` 把它执行掉再回到 `model`；
 * 没有未决调用时才继续消费剩下的有界工作，或走向 `suspend` 结束本次 invoke。挂起与失速都不重启
 * 整张图——恢复由 Controller 在拿到 Runtime Lease 后以同一 thread 重新 invoke 完成（D5）。
 *
 * `recursionLimit` 只是高位技术保险，不作为业务预算，也不当作工具循环的步数上限；模型调用的有限
 * 重试只配置在 model node 上，且内层重试已在 `resolveChatModel` 中关闭，避免次数相乘（D15）。
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
import { createToolsNode, TOOLS_NODE } from './tool-node.js';

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
  /** 已提交调用使用完整注册表恢复，模型仍只看到 planningTools。 */
  readonly recoveryTools?: readonly PlanningToolDefinition[];
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

/** 有条件边：有未决 tool call 就先进 tools 节点，否则继续消费工作或挂起。 */
export function routeAfterModel(
  state: CoordinatorGraphState,
): typeof MODEL_NODE | typeof TOOLS_NODE | typeof SUSPEND_NODE | typeof END {
  if (state.status !== 'running') {
    return END;
  }
  if (state.pendingToolCalls > 0) {
    return TOOLS_NODE;
  }
  return state.remainingWork.length > 0 ? MODEL_NODE : SUSPEND_NODE;
}

/**
 * 启动路由。
 *
 * `pendingToolCalls` 非零即先进 tools 节点：重启后必须先把已提交响应里未配对的结果补齐，再让模型
 * 看到它们；把它当最终响应消费会永久丢掉那批调用。该通道由宿主用 `pendingToolCallsIn` 播种。
 */
export function routeAtStart(
  state: CoordinatorGraphState,
): typeof MODEL_NODE | typeof TOOLS_NODE | typeof SUSPEND_NODE {
  if (state.pendingToolCalls > 0) {
    return TOOLS_NODE;
  }
  return state.remainingWork.length > 0 ? MODEL_NODE : SUSPEND_NODE;
}

/** tools 之后的边：只有真正执行完的循环才回到模型；blocked 直接结束本次 invoke。 */
export function routeAfterTools(state: CoordinatorGraphState): typeof MODEL_NODE | typeof END {
  return state.status === 'running' ? MODEL_NODE : END;
}

/**
 * 组装 Coordinator graph。
 *
 * 调用方负责传入 checkpointer 与 chat model；这个函数不创建 provider、不打开数据库、不读时钟。
 */
export function buildCoordinatorGraph(dependencies: CoordinatorGraphDependencies) {
  const tools = dependencies.planningTools ?? [];
  const model = bindPlanningTools(dependencies.model, tools);
  return new StateGraph(COORDINATOR_GRAPH_CHANNELS)
    .addNode(MODEL_NODE, createModelNode({ ...dependencies, model, tools }))
    .addNode(
      TOOLS_NODE,
      createToolsNode({
        sessionRecords: dependencies.sessionRecords,
        assertFencing: dependencies.assertFencing,
        tools: dependencies.recoveryTools ?? tools,
      }),
    )
    .addNode(
      SUSPEND_NODE,
      createSuspendNode({
        sessionRecords: dependencies.sessionRecords,
        assertFencing: dependencies.assertFencing,
      }),
    )
    .addConditionalEdges(START, routeAtStart, {
      [MODEL_NODE]: MODEL_NODE,
      [TOOLS_NODE]: TOOLS_NODE,
      [SUSPEND_NODE]: SUSPEND_NODE,
    })
    .addConditionalEdges(MODEL_NODE, routeAfterModel, {
      [MODEL_NODE]: MODEL_NODE,
      [TOOLS_NODE]: TOOLS_NODE,
      [SUSPEND_NODE]: SUSPEND_NODE,
      [END]: END,
    })
    .addConditionalEdges(TOOLS_NODE, routeAfterTools, {
      [MODEL_NODE]: MODEL_NODE,
      [END]: END,
    })
    .addEdge(SUSPEND_NODE, END)
    .compile({ checkpointer: dependencies.checkpointer });
}
