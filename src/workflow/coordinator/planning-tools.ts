/**
 * MOD-03 / IC-05：Coordinator 的规划工具集（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 工具只在当前模式与事实允许时可见，并且每次调用都重新校验同一组前提（D17）：模式、控制状态、
 * 激活门、规划责任、Scope/Session 身份、revision 与写入预算。校验放在 handler 里而不是模型侧，
 * 因此「模型认为自己可以改 Route Map」不构成任何权限——它只能得到一个结构化拒绝。
 *
 * 工具本身不实现业务规则：它们把请求翻译成对 `src/application/planning/` 用例的调用，并把结果
 * 归一化成 accepted / rejected / unknown 三值，供 Coordinator 消费。
 */

import { tool } from '@langchain/core/tools';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  Revision,
} from '../../application/dto/identity.js';
import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';
import { ROUTE_MAP_SECTIONS, type RouteMapSection } from '../../domain/planning/route-map.js';
import type { HandoffActivation, PlanningHandoffResult } from '../../application/planning/planning-handoff.js';
import type { PlanningMutationResult } from '../../application/planning/route-map-service.js';

export const PLANNING_TOOL_NAMES = [
  'read_route_map',
  'read_frontier',
  'update_route_map_section',
  'claim_ticket',
  'release_ticket',
  'resolve_ticket',
  'prepare_planning_handoff',
  'review_planning_handoff',
] as const;

export type PlanningToolName = (typeof PLANNING_TOOL_NAMES)[number];

/** 工具的可见性输入：全部来自 Controller 读到的权威事实，模型不可填写。 */
export type PlanningToolFacts = {
  readonly mode: CoordinationMode;
  readonly controlState: ControlState;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly scopeRevision: Revision;
  readonly activation: HandoffActivation;
  readonly permissions: {
    /** 规划写入权限来自项目配置与角色，不由模型声明。 */
    readonly allowPlanningWrites: boolean;
  };
  readonly budget: {
    /** 本轮允许的 tracker 副作用次数；0 表示只剩只读工具。 */
    readonly remainingMutations: number;
  };
};

export type PlanningToolOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * 一次受控调用的可信身份。
 *
 * 它由宿主在提交模型响应时分配并随 call 一起持久化，模型不可填写：工具 handler 只把它转发给
 * 用例，因此「用新身份重试一个已发起的副作用」在结构上不可能发生。只读工具忽略它。
 */
export type PlanningCallContext = {
  /** 主操作的 OperationId。 */
  readonly operationId: OperationId;
  /** 该 call 触发的第二次独立副作用（`resolve_ticket` 的地图写入）；没有时为 `null`。 */
  readonly mapOperationId: OperationId | null;
};

/** 模型侧绑定用的结构化拒绝：绑定到模型的包装器只做 schema 广告，从不执行副作用。 */
export const TOOL_NOT_EXECUTABLE: PlanningToolOutcome = {
  kind: 'rejected',
  code: 'not_executable',
  message: '工具由受控 tools 节点执行，模型侧的绑定包装器不产生副作用',
};

/**
 * 工具 handler 依赖的用例集合。
 *
 * 工具层只做准入与归一化；读写顺序、Operation Intent 与读回核验都在应用用例里，不在这里复制。
 */
export type PlanningToolServices = {
  /** 重新读取当前事实；每次调用都调用它，因此准入判断不会建立在旧快照上。 */
  readonly readFacts: () => PlanningToolFacts;
  /** 对已存在的 Operation Intent 先按原 ID 对账；null 表示这是新调用。 */
  readonly replayMutation?: (operationId: OperationId) => PlanningMutationResult | null;
  readonly readRouteMap: () => Promise<PlanningToolOutcome>;
  readonly readFrontier: () => Promise<PlanningToolOutcome>;
  readonly updateRouteMapSection: (input: {
    readonly section: RouteMapSection;
    readonly content: string;
    readonly expectedRevision: Revision;
    readonly operationId: OperationId;
  }) => Promise<PlanningMutationResult>;
  readonly claimTicket: (input: {
    readonly ticketRef: EntityRef<'decision-ticket'>;
    readonly expectedRevision: Revision;
    readonly operationId: OperationId;
  }) => Promise<PlanningMutationResult>;
  readonly releaseTicket: (input: {
    readonly ticketRef: EntityRef<'decision-ticket'>;
    readonly expectedRevision: Revision;
    readonly operationId: OperationId;
  }) => Promise<PlanningMutationResult>;
  readonly resolveTicket: (input: {
    readonly ticketRef: EntityRef<'decision-ticket'>;
    readonly resolution: string;
    readonly expectedRevision: Revision;
    readonly operationId: OperationId;
    /** 地图写入是同一 call 的第二次独立副作用，因此有独立身份。 */
    readonly mapOperationId: OperationId | null;
  }) => Promise<PlanningMutationResult>;
  readonly preparePlanningHandoff: (input: {
    readonly proposalId: string;
    readonly targetCoordinatorSessionId: CoordinatorSessionId;
    readonly capsuleRef: string | null;
    readonly operationId: OperationId;
  }) => Promise<PlanningHandoffResult>;
  readonly reviewPlanningHandoff: (input: {
    readonly proposalId: string;
    readonly operationId: OperationId;
  }) => Promise<PlanningHandoffResult>;
};

export type PlanningToolDefinition = {
  readonly name: PlanningToolName;
  readonly description: string;
  readonly mutating: boolean;
  /** 输入 schema 是 JSON Schema：工具层不引入第二套类型系统。 */
  readonly inputSchema: Record<string, unknown>;
  /** 执行只发生在受控 tools 节点；身份取自调用上下文，不取自模型输入。 */
  readonly invoke: (input: unknown, context: PlanningCallContext) => Promise<PlanningToolOutcome>;
};

type Admission =
  | { readonly kind: 'admitted'; readonly facts: PlanningToolFacts }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function readTicketRef(input: Record<string, unknown>): EntityRef<'decision-ticket'> | null {
  const id = input['ticketId'];
  return typeof id === 'string' && id.length > 0 ? { kind: 'decision-ticket', id } : null;
}

/**
 * 每次调用都重新准入。
 *
 * `expectedRevision` 由调用方（Controller 或模型回填的当前 revision）给出：与刚读到的事实不一致
 * 即说明它基于旧快照行动，按 stale revision 拒绝，而不是替它猜一个新值。
 */
function admit(input: {
  readonly initial: PlanningToolFacts;
  readonly services: PlanningToolServices;
  readonly requireWrite: boolean;
  readonly expectedRevision: unknown;
  readonly allowHandoffReview?: boolean;
}): Admission {
  if (input.initial.mode !== 'route_planning') {
    return { kind: 'rejected', code: 'wrong_mode', message: `当前模式为 ${input.initial.mode}，没有规划工具` };
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
  if (facts.controlState !== 'active') {
    return { kind: 'rejected', code: 'control_state', message: `Scope 处于 ${facts.controlState}，规划动作被暂停` };
  }
  const activationAllowed =
    facts.activation.kind === 'active' ||
    (input.allowHandoffReview === true && facts.activation.kind === 'handoff_review');
  if (!activationAllowed) {
    return {
      kind: 'rejected',
      code: 'activation_gate',
      message:
        facts.activation.kind === 'awaiting_user_prompt'
          ? `未决交接 ${facts.activation.proposalId} 尚未通过激活门`
          : facts.activation.kind === 'not_planning_owner'
            ? `规划责任属于 ${facts.activation.ownerCoordinatorSessionId}`
            : `当前仅允许复核交接 ${facts.activation.proposalId}`,
    };
  }
  if (input.requireWrite) {
    if (!facts.permissions.allowPlanningWrites) {
      return { kind: 'rejected', code: 'not_permitted', message: '当前配置不允许规划写入' };
    }
    if (facts.budget.remainingMutations <= 0) {
      return { kind: 'rejected', code: 'budget_exhausted', message: '本轮规划写入预算已耗尽' };
    }
  }
  if (input.expectedRevision !== facts.scopeRevision) {
    return {
      kind: 'rejected',
      code: 'stale_revision',
      message: `expectedRevision ${String(input.expectedRevision)} 已过期，当前为 ${facts.scopeRevision}`,
    };
  }
  return { kind: 'admitted', facts };
}

function fromMutation(result: PlanningMutationResult): PlanningToolOutcome {
  switch (result.kind) {
    case 'accepted':
      return {
        kind: 'ok',
        value: { scopeRevision: result.revision, mapRevision: result.mapRevision },
      };
    case 'rejected':
      return { kind: 'rejected', code: result.code, message: result.message };
    case 'unknown':
      return { kind: 'unknown', reason: result.reason };
  }
}

function fromHandoff(result: PlanningHandoffResult): PlanningToolOutcome {
  return result.kind === 'rejected'
    ? { kind: 'rejected', code: result.failure.code, message: result.failure.message }
    : { kind: 'ok', value: { phase: result.kind, proposalId: result.proposal.proposalId } };
}

const EXPECTED_REVISION_PROPERTY = {
  type: 'integer',
  minimum: 0,
  description: '调用方读到的 Scope revision',
} as const;

const TICKET_ID_PROPERTY = {
  type: 'string',
  description: 'Decision Ticket 的 tracker 标识',
} as const;

function schema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** 只读与写入工具的可见性由同一组事实决定，因此不会出现「读得到、写不了」之外的第三种组合。 */
function visibleToolNames(facts: PlanningToolFacts): readonly PlanningToolName[] {
  const reads: readonly PlanningToolName[] = ['read_route_map', 'read_frontier'];
  if (facts.mode !== 'route_planning') {
    return [];
  }
  if (facts.activation.kind === 'handoff_review') {
    return [...reads, 'review_planning_handoff'];
  }
  const writable =
    facts.controlState === 'active' &&
    facts.activation.kind === 'active' &&
    facts.permissions.allowPlanningWrites &&
    facts.budget.remainingMutations > 0;
  if (!writable) {
    return reads;
  }
  return [
    ...reads,
    'update_route_map_section',
    'claim_ticket',
    'release_ticket',
    'resolve_ticket',
    'prepare_planning_handoff',
    'review_planning_handoff',
  ];
}

/** 组装一个工具定义需要的东西：用例集合与「工具集是在什么事实下被创建的」。 */
type PlanningToolContext = {
  readonly services: PlanningToolServices;
  readonly facts: PlanningToolFacts;
};

function buildDefinitions(): Readonly<Record<PlanningToolName, (context: PlanningToolContext) => PlanningToolDefinition>> {
  return {
    read_route_map: ({ services }) => ({
      name: 'read_route_map',
      description: '读取 Route Map 的固定章节（正文来自 tracker，本地不保存副本）。',
      mutating: false,
      inputSchema: schema({}, []),
      invoke: async () => await services.readRouteMap(),
    }),
    read_frontier: ({ services }) => ({
      name: 'read_frontier',
      description: '读取当前 Frontier：开放、未阻塞、未被认领的 Decision Ticket。',
      mutating: false,
      inputSchema: schema({}, []),
      invoke: async () => await services.readFrontier(),
    }),
    update_route_map_section: ({ services, facts }) => ({
      name: 'update_route_map_section',
      description:
        '把 Route Map 的某个固定章节整体替换为给定正文；创建票据与设置依赖都写在这里，不新建章节结构。',
      mutating: true,
      inputSchema: schema(
        {
          section: {
            type: 'string',
            enum: ['destination', 'resolved_decisions', 'open_decision_tickets', 'dependencies', 'fog', 'scope_boundaries'],
          },
          content: { type: 'string', description: '该章节的完整新正文' },
          expectedRevision: EXPECTED_REVISION_PROPERTY,
        },
        ['section', 'content', 'expectedRevision'],
      ),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        if (fields === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: '工具输入必须是对象' };
        }
        const section = fields['section'];
        const content = fields['content'];
        if (
          typeof section !== 'string' ||
          !(ROUTE_MAP_SECTIONS as readonly string[]).includes(section) ||
          typeof content !== 'string'
        ) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'section 与 content 必须是字符串' };
        }
        const replay = services.replayMutation?.(context.operationId);
        if (replay !== undefined && replay !== null) return fromMutation(replay);
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields['expectedRevision'],
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromMutation(
          await services.updateRouteMapSection({
            section: section as RouteMapSection,
            content,
            expectedRevision: admission.facts.scopeRevision,
            operationId: context.operationId,
          }),
        );
      },
    }),
    claim_ticket: ({ services, facts }) => ({
      name: 'claim_ticket',
      description: '认领一张 Decision Ticket：写入 tracker assignee 并登记本地 Session claim。',
      mutating: true,
      inputSchema: schema({ ticketId: TICKET_ID_PROPERTY, expectedRevision: EXPECTED_REVISION_PROPERTY }, [
        'ticketId',
        'expectedRevision',
      ]),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const ticketRef = fields === null ? null : readTicketRef(fields);
        if (fields === null || ticketRef === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'ticketId 必须是非空字符串' };
        }
        const replay = services.replayMutation?.(context.operationId);
        if (replay !== undefined && replay !== null) return fromMutation(replay);
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields['expectedRevision'],
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromMutation(
          await services.claimTicket({
            ticketRef,
            expectedRevision: admission.facts.scopeRevision,
            operationId: context.operationId,
          }),
        );
      },
    }),
    release_ticket: ({ services, facts }) => ({
      name: 'release_ticket',
      description: '释放一张 Decision Ticket 的认领，但不记录决策结论。',
      mutating: true,
      inputSchema: schema({ ticketId: TICKET_ID_PROPERTY, expectedRevision: EXPECTED_REVISION_PROPERTY }, [
        'ticketId',
        'expectedRevision',
      ]),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const ticketRef = fields === null ? null : readTicketRef(fields);
        if (fields === null || ticketRef === null) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'ticketId 必须是非空字符串' };
        }
        const replay = services.replayMutation?.(context.operationId);
        if (replay !== undefined && replay !== null) return fromMutation(replay);
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields['expectedRevision'],
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromMutation(
          await services.releaseTicket({
            ticketRef,
            expectedRevision: admission.facts.scopeRevision,
            operationId: context.operationId,
          }),
        );
      },
    }),
    resolve_ticket: ({ services, facts }) => ({
      name: 'resolve_ticket',
      description: '解决一张 Decision Ticket：写入 resolved decisions 章节、从开放票据移除并收尾 claim。',
      mutating: true,
      inputSchema: schema(
        {
          ticketId: TICKET_ID_PROPERTY,
          resolution: { type: 'string', description: '已解决决策的结论' },
          expectedRevision: EXPECTED_REVISION_PROPERTY,
        },
        ['ticketId', 'resolution', 'expectedRevision'],
      ),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const ticketRef = fields === null ? null : readTicketRef(fields);
        const resolution = fields?.['resolution'];
        if (fields === null || ticketRef === null || typeof resolution !== 'string' || resolution.trim().length === 0) {
          return {
            kind: 'rejected',
            code: 'invalid_argument',
            message: 'ticketId 与 resolution 必须是非空字符串',
          };
        }
        const replay = services.replayMutation?.(context.operationId);
        if (replay !== undefined && replay !== null) {
          if (replay.kind !== 'accepted') return fromMutation(replay);
          const expectedRevision = fields['expectedRevision'];
          if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            return { kind: 'rejected', code: 'invalid_argument', message: 'expectedRevision 必须是非负整数' };
          }
          return fromMutation(await services.resolveTicket({
            ticketRef,
            resolution,
            expectedRevision,
            operationId: context.operationId,
            mapOperationId: context.mapOperationId,
          }));
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields['expectedRevision'],
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromMutation(
          await services.resolveTicket({
            ticketRef,
            resolution,
            expectedRevision: admission.facts.scopeRevision,
            operationId: context.operationId,
            mapOperationId: context.mapOperationId,
          }),
        );
      },
    }),
    prepare_planning_handoff: ({ services, facts }) => ({
      name: 'prepare_planning_handoff',
      description: '发起 Route Planning 责任交接的 prepare 阶段：落盘提案，但责任仍属本 Session。',
      mutating: true,
      inputSchema: schema(
        {
          proposalId: { type: 'string' },
          targetCoordinatorSessionId: { type: 'string', description: '接收责任的 Coordinator Session' },
          capsuleRef: { type: ['string', 'null'], description: '可移植 Context Capsule 的引用' },
          expectedRevision: EXPECTED_REVISION_PROPERTY,
        },
        ['proposalId', 'targetCoordinatorSessionId', 'expectedRevision'],
      ),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const proposalId = fields?.['proposalId'];
        const target = fields?.['targetCoordinatorSessionId'];
        const capsuleRef = fields?.['capsuleRef'] ?? null;
        if (
          typeof proposalId !== 'string' ||
          proposalId.trim().length === 0 ||
          typeof target !== 'string' ||
          target.trim().length === 0
        ) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'proposalId 与目标 Session 必须是非空字符串' };
        }
        if (capsuleRef !== null && typeof capsuleRef !== 'string') {
          return { kind: 'rejected', code: 'invalid_argument', message: 'capsuleRef 必须是字符串或 null' };
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields?.['expectedRevision'],
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromHandoff(
          await services.preparePlanningHandoff({
            proposalId,
            targetCoordinatorSessionId: target as CoordinatorSessionId,
            capsuleRef,
            operationId: context.operationId,
          }),
        );
      },
    }),
    review_planning_handoff: ({ services, facts }) => ({
      name: 'review_planning_handoff',
      description: '接收 Session 复核一份 prepare 阶段的交接提案。',
      mutating: true,
      inputSchema: schema({ proposalId: { type: 'string' }, expectedRevision: EXPECTED_REVISION_PROPERTY }, [
        'proposalId',
        'expectedRevision',
      ]),
      invoke: async (input, context) => {
        const fields = asRecord(input);
        const proposalId = fields?.['proposalId'];
        if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
          return { kind: 'rejected', code: 'invalid_argument', message: 'proposalId 必须是非空字符串' };
        }
        const admission = admit({
          initial: facts,
          services,
          requireWrite: true,
          expectedRevision: fields?.['expectedRevision'],
          allowHandoffReview: true,
        });
        if (admission.kind === 'rejected') {
          return admission;
        }
        return fromHandoff(
          await services.reviewPlanningHandoff({ proposalId, operationId: context.operationId }),
        );
      },
    }),
  };
}

const DEFINITIONS = buildDefinitions();

/**
 * 当前事实下可见的规划工具集。
 *
 * 返回顺序对给定事实稳定，因此同一组事实得到的工具列表是可复核的：模型看到的工具集合本身就是
 * 一条可解释的准入结论。
 */
export function planningToolset(facts: PlanningToolFacts, services: PlanningToolServices): readonly PlanningToolDefinition[] {
  return visibleToolNames(facts).map((name) => DEFINITIONS[name]({ services, facts }));
}

/** 只供已提交 call 的恢复执行使用；handler 仍按当前事实重新准入。 */
export function planningRecoveryToolset(facts: PlanningToolFacts, services: PlanningToolServices): readonly PlanningToolDefinition[] {
  return PLANNING_TOOL_NAMES.map((name) => DEFINITIONS[name]({ services, facts }));
}

/**
 * 把工具定义转换成可绑定的 LangChain 工具。
 *
 * 绑定给模型的包装器**只做 schema 广告**，不执行任何副作用：执行只发生在受控 tools 节点，那里
 * 才有可信的 OperationId、准入重验与逐 call 结果落盘。模型因此只能申请一个调用，得不到副作用。
 *
 * 返回类型由 `tool()` 的载荷决定（包装器只声明 schema），消费方只把它交给 `bindTools`。
 */
export function toBindableTools(
  definitions: readonly PlanningToolDefinition[],
): readonly ReturnType<typeof tool>[] {
  return definitions.map((definition) =>
    tool(
      (): string => JSON.stringify(TOOL_NOT_EXECUTABLE),
      {
        name: definition.name,
        description: definition.description,
        schema: definition.inputSchema as never,
      },
    ),
  );
}

/** 供 graph 组装使用的判别：只有规划模式下的工具才会被注册到模型上。 */
export function planningToolsForMode(input: {
  readonly facts: PlanningToolFacts;
  readonly services: PlanningToolServices;
}): readonly PlanningToolDefinition[] {
  return planningToolset(input.facts, input.services);
}

export function isPlanningToolName(raw: unknown): raw is PlanningToolName {
  return typeof raw === 'string' && (PLANNING_TOOL_NAMES as readonly string[]).includes(raw);
}
