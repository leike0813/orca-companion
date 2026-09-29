/**
 * MOD-03 / IP-03：Coordinator 的执行态工具集（Owner: `m2-wire-execution-runtime`）。
 *
 * 与规划工具**同一形状**（`CoordinatorToolDefinition`），因此受控 tools 节点、模型侧绑定包装器与逐
 * call 落盘都不需要第二套协议：执行工具与规划工具一样，只能被「申请」，执行永远发生在 tools 节点。
 * 差别只在可见性与准入：
 *
 * - **可见性只由模式决定**：非 `execution_coordination` 模式不暴露任何执行工具（`route_planning`
 *   模式因此没有 `advance_execution`）。可见性与瞬时事实解耦是有意的——按事实把已可见的工具藏起来，
 *   会让已提交的 call 在重启后找不到注册项，退化成「未注册 = unknown」，把一个可恢复的调用变成阻塞；
 * - **准入每次调用重验**：模式、Scope/Session 身份、控制状态、Execution Coordination Lease、授权、
 *   写权限与预算都在 handler 里按刚读到的事实判定，revision 由执行驱动读取和校验，因此「模型认为自己可以推进」不构成
 *   任何权限，它只能得到一个结构化拒绝；lane 级阻塞由执行驱动在每次调用里从 store 重新判定（它才
 *   持有那份读取），并以同一个三值结果回到这里，因此不会因为少判一次而放过；
 * - **身份不由模型提供**：`advance_execution` 只提交一次委托，真正的分步骤 OperationId 由执行驱动
 *   按 Scope/Generation/Work Package/角色/契约 revision/Attempt/步骤稳定签发，模型填不出身份。
 *
 * `request_graph_patch` 与 `advance_execution` 共用同一套写入准入，差别只在委托内容：它提交一份九字段
 * 的图变化声明，分类、Planner 派发、Admission 与提交都在应用用例里。是否还剩下图修订额度由 Admission
 * 按 Manifest 判定，因此它不受 `advance_execution` 那份推进预算的影响——那份预算是未验收 Work Package
 * 的推进上界，全部验收完成后它归零，而图变化请求仍可能合法。
 *
 * 工具本身不实现业务规则：它们把请求翻译成对执行驱动或宿主编译回调的调用，并把结果归一化成
 * accepted / rejected / unknown 三值，供 Coordinator 消费。
 */

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  Revision,
  WorkPackageId,
} from '../../application/dto/identity.js';
import type { AdvanceExecutionResult } from '../../application/execution/advance-execution.js';
import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';
import {
  CHANGE_CLAIMS,
  type ChangeClaim,
  type GraphChangeRequest,
} from '../../domain/execution/change-routing.js';
import { asRecord, toolInputSchema } from './tool-definition.js';
import type { CoordinatorToolDefinition, CoordinatorToolOutcome } from './tool-definition.js';

export const EXECUTION_TOOL_NAMES = [
  'read_execution_status',
  'advance_execution',
  'request_graph_patch',
  'propose_execution_graph',
] as const;

export type ExecutionToolName = (typeof EXECUTION_TOOL_NAMES)[number];

/** 工具的可见性输入：全部来自 Controller 读到的权威事实，模型不可填写。 */
export type ExecutionToolFacts = {
  readonly mode: CoordinationMode;
  readonly controlState: ControlState;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly scopeRevision: Revision;
  readonly planningResponsible: boolean;
  /** 当前 Graph Generation 的 Execution Authorization 引用；`null` 表示还没有可用于派发的授权。 */
  readonly authorization: {
    readonly authorizationId: string | null;
    readonly authorizationVersion: Revision | null;
  };
  /** Execution Coordination Lease 是否由本 Session 持有：只有持有者可以推进 Frontier。 */
  readonly executionLeaseHeld: boolean;
  readonly permissions: {
    /** 执行写入权限来自项目配置与 Manifest，不由模型声明。 */
    readonly allowExecutionWrites: boolean;
  };
  readonly budget: {
    /** 本轮允许的执行推进次数；0 表示只剩只读工具。 */
    readonly remainingMutations: number;
  };
};

/** 执行工具的三值结果；闭集由 `CoordinatorToolOutcome` 拥有，与规划工具共用。 */
export type ExecutionToolOutcome = CoordinatorToolOutcome;

/**
 * 工具 handler 依赖的用例集合。
 *
 * 工具层只做准入与归一化；候选选择、稳定身份、Operation Intent 与读回核验都在执行驱动里，不在这里
 * 复制。`proposeExecutionGraph` 是宿主注入的编译回调：本模块只把模型提出的结构化 Implementation Plan
 * 原样交给它，schema 与准入由本模块负责，编译结论由回调负责。
 */
export type ExecutionToolServices = {
  /** 重新读取当前事实；每次调用都调用它，因此准入判断不会建立在旧快照上。 */
  readonly readFacts: () => ExecutionToolFacts;
  /** 只读：当前代际、Frontier、活跃 Worker 与 blocker。 */
  readonly readExecutionStatus: () => Promise<ExecutionToolOutcome>;
  /**
   * 受控：单步推进 Execution Frontier，一次调用最多推进一个需要外部副作用的阶段。
   *
   * 只接收一个委托：`operationId` 是本次受控调用的身份（用于与已提交 call 配对），派发身份由驱动
   * 自己签发，因此「模型换一个 ID 重试已发起的副作用」在结构上不可能发生。
   */
  readonly advanceExecution: (input: { readonly operationId: OperationId }) => Promise<ExecutionToolOutcome>;
  /**
   * 受控：提交一份结构化的图变化声明。
   *
   * 只接收模型能声明的九个字段与本次调用的身份；Scope、Graph、GraphVersion、patchId 与 Planner 派发
   * 身份都由应用用例从当前事实补齐。分类未要求派发时用例不产生任何副作用，`rejected` 只表示这次请求
   * 未被接受，不表示图被改坏。
   */
  readonly requestGraphPatch: (input: {
    readonly request: GraphChangeRequest;
    readonly operationId: OperationId;
  }) => Promise<ExecutionToolOutcome>;
  /** 受控：把模型提出的结构化 Implementation Plan 交给宿主编译回调。 */
  readonly proposeExecutionGraph: (input: {
    readonly plan: unknown;
    readonly operationId: OperationId;
  }) => Promise<ExecutionToolOutcome>;
};

/**
 * 一个执行工具定义：形状与规划工具完全相同，`name` 是本模块自己的封闭联合。
 */
export type ExecutionToolDefinition = CoordinatorToolDefinition;

type Admission =
  | { readonly kind: 'admitted'; readonly facts: ExecutionToolFacts }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 每次调用都重新准入。
 *
 * 只读调用只要求模式与身份仍然成立（暂停时界面仍要能解释为什么暂停）；受控调用额外要求：控制状态
 * `active`、本 Session 持有 Execution Coordination Lease、有可用于派发的授权、写权限与预算未被耗尽。
 */
function admit(input: {
  readonly initial: ExecutionToolFacts;
  readonly services: ExecutionToolServices;
  readonly requireWrite: boolean;
  readonly mode?: CoordinationMode;
  /**
   * 跳过 `advance_execution` 的推进预算。
   *
   * `remainingMutations` 是未验收 Work Package 的推进上界，全部验收后归零，而图变化请求那时仍可能
   * 合法；真正的图修订额度由 Admission 按 Manifest 判定。只有 `request_graph_patch` 使用它。
   */
  readonly skipAdvanceBudget?: boolean;
}): Admission {
  const mode = input.mode ?? 'execution_coordination';
  if (input.initial.mode !== mode) {
    return { kind: 'rejected', code: 'wrong_mode', message: `当前模式为 ${input.initial.mode}，没有执行工具` };
  }
  const facts = input.services.readFacts();
  if (
    facts.coordinationScopeId !== input.initial.coordinationScopeId ||
    facts.coordinatorSessionId !== input.initial.coordinatorSessionId
  ) {
    return { kind: 'rejected', code: 'scope_mismatch', message: '工具绑定的 Scope 或 Session 已改变' };
  }
  if (facts.mode !== input.initial.mode) {
    return { kind: 'rejected', code: 'wrong_mode', message: `当前模式已变为 ${facts.mode}` };
  }
  if (!input.requireWrite) {
    return { kind: 'admitted', facts };
  }
  if (facts.controlState !== 'active') {
    return { kind: 'rejected', code: 'control_state', message: `Scope 处于 ${facts.controlState}，执行推进被暂停` };
  }
  if (mode === 'route_planning') {
    if (!facts.planningResponsible) {
      return { kind: 'rejected', code: 'not_planning_owner', message: '本 Session 不持有规划责任' };
    }
    return { kind: 'admitted', facts };
  }
  if (!facts.executionLeaseHeld) {
    return {
      kind: 'rejected',
      code: 'not_lease_holder',
      message: '本 Session 不持有 Execution Coordination Lease，不能推进 Execution Frontier',
    };
  }
  if (!facts.permissions.allowExecutionWrites) {
    return { kind: 'rejected', code: 'not_permitted', message: '当前配置不允许执行写入' };
  }
  if (input.skipAdvanceBudget !== true && facts.budget.remainingMutations <= 0) {
    return { kind: 'rejected', code: 'budget_exhausted', message: '本轮执行推进预算已耗尽' };
  }
  if (facts.authorization.authorizationId === null || facts.authorization.authorizationVersion === null) {
    return {
      kind: 'rejected',
      code: 'authorization_missing',
      message: '当前 Graph Generation 没有有效的 Execution Authorization',
    };
  }
  return { kind: 'admitted', facts };
}

const PLAN_PROPERTY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    planRevision: { type: 'integer', minimum: 0 },
    destinationRef: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['destination'] },
        id: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 0 },
      },
      required: ['kind', 'id', 'version'],
    },
    workPackages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          dependsOn: { type: 'array', items: { type: 'string' } },
          scopeEnvelope: {
            type: 'object',
            additionalProperties: false,
            properties: {
              include: { type: 'array', minItems: 1, items: { type: 'string' } },
              exclude: { type: 'array', items: { type: 'string' } },
            },
            required: ['include', 'exclude'],
          },
          requestedBudget: {
            type: 'object',
            additionalProperties: false,
            properties: {
              implementationAttempts: { type: 'integer', minimum: 0 },
              validatorRepairs: { type: 'integer', minimum: 0 },
              graphRevisions: { type: 'integer', minimum: 0 },
              specificationRevisions: { type: 'integer', minimum: 0 },
              maxRecoveriesPerWorkerAttempt: { type: 'integer', minimum: 0 },
            },
          },
        },
        required: ['key', 'title', 'dependsOn', 'scopeEnvelope'],
      },
    },
  },
  required: ['planRevision', 'destinationRef', 'workPackages'],
} as const;

/** 组装一个工具定义需要的东西：用例集合与「工具集是在什么事实下被创建的」。 */
type ExecutionToolContext = {
  readonly services: ExecutionToolServices;
  readonly facts: ExecutionToolFacts;
};

const CHANGE_CLAIM_PROPERTY = { type: 'string', enum: [...CHANGE_CLAIMS] } as const;

/**
 * 模型能声明的九个字段。

 * 这里刻意不出现 `workPackageId` 以外的任何身份字段——Scope、Graph、GraphVersion、patchId 与
 * Planner 派发身份都不在 schema 里，因此模型无法把一次请求指向另一张图或另一个版本。
 */
const CHANGE_REQUEST_PROPERTY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workPackageId: {
      type: ['string', 'null'],
      description: '请求针对的 Work Package；目标级或全局变化为 null',
    },
    infrastructureFailure: CHANGE_CLAIM_PROPERTY,
    changesDependencies: CHANGE_CLAIM_PROPERTY,
    changesScopeEnvelope: CHANGE_CLAIM_PROPERTY,
    changesObjective: CHANGE_CLAIM_PROPERTY,
    contractContentOnly: CHANGE_CLAIM_PROPERTY,
    goalOrGlobalConstraintChanged: CHANGE_CLAIM_PROPERTY,
    userRequestedReplanning: CHANGE_CLAIM_PROPERTY,
    requiresUserChoice: CHANGE_CLAIM_PROPERTY,
  },
  required: [
    'workPackageId',
    'infrastructureFailure',
    'changesDependencies',
    'changesScopeEnvelope',
    'changesObjective',
    'contractContentOnly',
    'goalOrGlobalConstraintChanged',
    'userRequestedReplanning',
    'requiresUserChoice',
  ],
} as const;

/** 八个声明字段；`workPackageId` 单独解析，因为它是唯一允许为 null 的字段。 */
const CHANGE_CLAIM_FIELDS = [
  'infrastructureFailure',
  'changesDependencies',
  'changesScopeEnvelope',
  'changesObjective',
  'contractContentOnly',
  'goalOrGlobalConstraintChanged',
  'userRequestedReplanning',
  'requiresUserChoice',
] as const satisfies readonly (keyof GraphChangeRequest)[];

/**
 * 运行时解析模型提交的变化声明。

 * Schema 已声明字段闭集，但 handler 不能把「模型侧绑定」当成校验：这里按字段逐个复验类型与三值取值，
 * 未知字段、缺字段与未知声明一律拒绝，不做猜测性转换。
 */
function parseChangeRequest(raw: unknown): GraphChangeRequest | null {
  const fields = asRecord(raw);
  if (fields === null) {
    return null;
  }
  if (Object.keys(fields).length !== CHANGE_CLAIM_FIELDS.length + 1) {
    return null;
  }
  const workPackageId = fields['workPackageId'];
  if (workPackageId !== null && (typeof workPackageId !== 'string' || workPackageId.length === 0)) {
    return null;
  }
  const claims: Partial<Record<(typeof CHANGE_CLAIM_FIELDS)[number], ChangeClaim>> = {};
  for (const field of CHANGE_CLAIM_FIELDS) {
    const value = fields[field];
    if (typeof value !== 'string' || !(CHANGE_CLAIMS as readonly string[]).includes(value)) {
      return null;
    }
    claims[field] = value as ChangeClaim;
  }
  return {
    workPackageId: workPackageId === null ? null : (workPackageId as WorkPackageId),
    ...claims,
  } as GraphChangeRequest;
}

function buildDefinitions(): Readonly<
  Record<ExecutionToolName, (context: ExecutionToolContext) => ExecutionToolDefinition>
> {
  return {
    read_execution_status: ({ services, facts }) => ({
      name: 'read_execution_status',
      description: '读取当前执行状态：代际、Frontier、活跃 Worker 与 blocker（只读）。',
      mutating: false,
      inputSchema: toolInputSchema({}, []),
      invoke: async (input) => {
        if (input !== undefined && input !== null && asRecord(input) === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: '工具输入必须是对象' };
        }
        const admission = admit({ initial: facts, services, requireWrite: false });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return await services.readExecutionStatus();
      },
    }),
    advance_execution: ({ services, facts }) => ({
      name: 'advance_execution',
      description:
        '推进一个需要外部副作用的阶段：选出当前候选角色并物化它。一次调用最多推进一个阶段，已有活跃 Worker、未授权或 lane 未决时只返回结构化结论。',
      mutating: true,
      inputSchema: toolInputSchema({}, []),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        if (fields === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: '工具输入必须是对象' };
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return await services.advanceExecution({ operationId: context.operationId });
      },
    }),
    request_graph_patch: ({ services, facts }) => ({
      name: 'request_graph_patch',
      description:
        '提交一份结构化的图变化声明：分类、Planner 派发、Admission 与图版本追加都由执行运行时按当前事实完成。' +
        '本工具只提交声明，不指定 Scope、Graph 版本或补丁标识；是否仍需图修订额度由授权判定。',
      mutating: true,
      completesWorkOnSuccess: true,
      inputSchema: toolInputSchema({ request: CHANGE_REQUEST_PROPERTY }, ['request']),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const request = fields === null ? null : parseChangeRequest(fields['request']);
        if (request === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'request 必须是完整且字段合法的图变化声明' };
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          skipAdvanceBudget: true,
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return await services.requestGraphPatch({ request, operationId: context.operationId });
      },
    }),
    propose_execution_graph: ({ services, facts }) => ({
      name: 'propose_execution_graph',
      description:
        '把结构化 Implementation Plan 提交给执行运行时编译成候选 Execution Graph；本工具只做 schema 与准入判定，编译结论由宿主回报。',
      mutating: true,
      inputSchema: toolInputSchema(
        {
          plan: PLAN_PROPERTY,
        },
        ['plan'],
      ),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const plan = fields?.['plan'];
        if (fields === null || plan === null || plan === undefined || asRecord(plan) === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'plan 必须是一个对象' };
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          mode: 'route_planning',
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return await services.proposeExecutionGraph({ plan, operationId: context.operationId });
      },
    }),
  };
}

const DEFINITIONS = buildDefinitions();

/**
 * 当前模式下可见的执行工具集。
 *
 * 可见性与事实解耦（见文件头）：执行模式下全部执行工具都可申请，能不能推进由每次调用的准入与执行驱动
 * 决定。因此注册表在重启后总能重建，已提交的执行工具调用不会因为「当时的事实」而找不到注册项。
 */
export function executionToolset(
  facts: ExecutionToolFacts,
  services: ExecutionToolServices,
): readonly ExecutionToolDefinition[] {
  if (facts.mode === 'route_planning') {
    return [DEFINITIONS.propose_execution_graph({ services, facts })];
  }
  if (facts.mode === 'execution_coordination') {
    return [
      DEFINITIONS.read_execution_status({ services, facts }),
      DEFINITIONS.advance_execution({ services, facts }),
      DEFINITIONS.request_graph_patch({ services, facts }),
    ];
  }
  return [];
}

/** 供 graph 组装使用的判别：工具集只在执行模式下非空，`route_planning` 因此没有 `advance_execution`。 */
export function executionToolsForMode(input: {
  readonly mode: CoordinationMode;
  readonly facts: ExecutionToolFacts;
  readonly services: ExecutionToolServices;
}): readonly ExecutionToolDefinition[] {
  return executionToolset({ ...input.facts, mode: input.mode }, input.services);
}

/**
 * 执行驱动结论 → 工具三值结果。
 *
 * `unknown` 必须把原 OperationId 带出去：tools 节点据此保留未配对的 call 并以原身份对账，
 * 而不是把它读成一次新的委托。
 */
export function executionOutcomeOf(result: AdvanceExecutionResult): ExecutionToolOutcome {
  switch (result.kind) {
    case 'progressed':
      return {
        kind: 'ok',
        value: {
          workPackageId: result.workPackageId,
          role: result.role,
          orcaTaskId: result.orcaTaskId,
          dispatchId: result.dispatchId,
        },
      };
    case 'idle':
      return { kind: 'ok', value: { kind: 'idle', reason: result.reason, blockers: result.blockers } };
    case 'blocked':
      return {
        kind: 'rejected',
        code: result.code,
        message: `${result.laneKey} 上的 lane 保持阻塞：${result.message}`,
      };
    case 'unknown':
      return { kind: 'unknown', reason: `${result.operationId} 的结果未知：${result.reason}` };
  }
}

export function isExecutionToolName(raw: unknown): raw is ExecutionToolName {
  return typeof raw === 'string' && (EXECUTION_TOOL_NAMES as readonly string[]).includes(raw);
}
