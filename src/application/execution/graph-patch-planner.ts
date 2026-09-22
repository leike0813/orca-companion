/**
 * IC-10 / IP-1：Graph Patch Planner 的派发与结果接收（Owner: `m1-evolve-execution-graph`，D2、D5）。
 *
 * 只有分类器明确判定「声明事实不足以分类」时，调用方才会走到这里。本模块做三件事：
 *
 * 1. 组装请求，并**强制**把 exact `baseGraphVersion` 固定进去——补丁不可能基于未声明的版本起草；
 * 2. 通过注入的 port 派发 Planner 角色（真实实现走前驱的 Worker Harness 与 Accepted Worker Result
 *    校验；测试用 fake port），本模块不自己调用 Orca；
 * 3. 把结果包成**来源证据**返回。
 *
 * 返回类型里没有「图」或「GraphVersion」：Planner 的结果是不可变来源证据，唯一提交点是
 * `graph-patch-service.ts` 的 Admission 归一化路径（D5）。这里也不会写任何存储。
 */

import type {
  CoordinationScopeId,
  GraphId,
  GraphVersion,
  OperationId,
  WorkPackageId,
} from '../../application/dto/identity.js';
import type { ExecutionGraph } from '../../domain/planning/execution-graph.js';
import type { ChangeRoutingDecision, GraphChangeRequest } from '../../domain/execution/change-routing.js';

export type GraphPatchPlannerRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  /** 补丁必须基于这个确切版本起草；Planner 不得自行推断或省略。 */
  readonly baseGraphVersion: GraphVersion;
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly changeRequest: GraphChangeRequest;
  readonly affectedWorkPackageIds: readonly WorkPackageId[];
  readonly unacceptedDescendantIds: readonly WorkPackageId[];
  readonly currentGraph: ExecutionGraph;
};

/**
 * Planner 派发的一次结果。
 *
 * `accepted` 表示 Orca 已记录确定结果并给回可引用的结果句柄；`unknown` 表示结果不可判定，调用方必须
 * 沿用同一 `OperationId` 对账，禁止换 ID 再派一次。
 */
export type GraphPatchPlannerOutcome =
  | { readonly kind: 'accepted'; readonly draftRef: string; readonly payload: unknown }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type GraphPatchPlannerPort = (
  request: GraphPatchPlannerRequest,
) => Promise<GraphPatchPlannerOutcome>;

export type GraphPatchPlannerEvidence = {
  readonly kind: 'planner-evidence';
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly baseGraphVersion: GraphVersion;
  /** Accepted Worker Result 的引用；正文留在 Orca。 */
  readonly draftRef: string;
  /** 尚未经过 Admission 的 Planner 载荷；只有归一化路径可以把它变成 Graph Revision。 */
  readonly payload: unknown;
  /** 恒为 `false`：来源证据从来不是当前图。 */
  readonly committed: false;
};

export type DraftGraphPatchResult =
  | { readonly kind: 'drafted'; readonly evidence: GraphPatchPlannerEvidence }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type DraftGraphPatchInput = {
  readonly routing: ChangeRoutingDecision;
  readonly planner: GraphPatchPlannerPort;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly changeRequest: GraphChangeRequest;
  readonly currentGraph: ExecutionGraph;
  readonly affectedWorkPackageIds: readonly WorkPackageId[];
  readonly unacceptedDescendantIds: readonly WorkPackageId[];
};

/**
 * 派发 Graph Patch Planner 并接收来源证据。
 *
 * 分类未要求派发时直接拒绝：本模块不负责「要不要派」的判定，也不替调用方补分类。
 */
export async function draftGraphPatch(input: DraftGraphPatchInput): Promise<DraftGraphPatchResult> {
  if (input.routing.route !== 'graph_patch' || !input.routing.dispatchGraphPatchPlanner) {
    return {
      kind: 'rejected',
      code: 'planner_not_dispatched',
      message: `路由结果为 ${input.routing.route}，不需要 Graph Patch Planner`,
    };
  }
  const request: GraphPatchPlannerRequest = {
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
    baseGraphVersion: input.routing.baseGraphVersion,
    patchId: input.patchId,
    operationId: input.operationId,
    changeRequest: input.changeRequest,
    affectedWorkPackageIds: input.affectedWorkPackageIds,
    unacceptedDescendantIds: input.unacceptedDescendantIds,
    currentGraph: input.currentGraph,
  };
  const outcome = await input.planner(request);
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', code: outcome.code, message: outcome.message };
  }
  if (outcome.kind === 'unknown') {
    return { kind: 'unknown', reason: outcome.reason };
  }
  return {
    kind: 'drafted',
    evidence: {
      kind: 'planner-evidence',
      patchId: input.patchId,
      operationId: input.operationId,
      baseGraphVersion: request.baseGraphVersion,
      draftRef: outcome.draftRef,
      payload: outcome.payload,
      committed: false,
    },
  };
}

/**
 * Graph Patch Planner 的指令正文。
 *
 * 它把「exact baseGraphVersion」「未接受后代必须逐一处置」「依赖引用只有两种形态」写成模型的约束，而不是
 * 留给模型自己猜：真实 Planner 的产物必须能直接喂给确定性编译器。身份字段（scope、Run、operationId）
 * 一律回显输入并在 Admission 处被丢弃，模型无法通过填写它们改变提交结果。
 */
export function graphPatchPlannerInstruction(request: GraphPatchPlannerRequest): string {
  const descendants =
    request.unacceptedDescendantIds.length === 0
      ? ['- 本次没有需要处置的未接受后代，descendants 为空数组。']
      : request.unacceptedDescendantIds.map(
          (workPackageId) =>
            `- ${workPackageId}：disposition 取 unchanged | graph_revision | specification_revision | retire 之一`,
        );
  return [
    '你是 Execution Graph 的 Graph Patch Planner。执行期间发现的变化无法用既有节点表达，需要产出一次原子补丁草案。',
    '',
    '硬约束：',
    `- baseGraphVersion 必须精确等于 ${request.baseGraphVersion}；不得基于其它版本起草。`,
    `- patchId 使用 ${request.patchId}；operationId 原样回显 ${request.operationId}（Companion 会用自己签发的身份覆盖它）。`,
    '- 依赖引用只有两种形态：{"kind":"existing","workPackageId":"<当前图中的 id>"} 与 {"kind":"added","key":"<同一补丁新增节点的 key>"}。',
    '- 新增节点的 WorkPackageId 由 Companion 派生，草案里只给 key。',
    '- retire 与 revise 都只允许当前图中尚未被接受的节点；revise 的 dependsOn 与 scopeEnvelope 都是绝对值。',
    '- 依赖必须无环，Scope Envelope 的 include 不得为空，路径必须是 worktree 相对路径。',
    '',
    `变化声明：${JSON.stringify(request.changeRequest)}`,
    `当前图快照：${JSON.stringify(request.currentGraph)}`,
    '',
    '未接受后代必须逐一处置：',
    ...descendants,
    '- disposition 取 graph_revision 的后代必须同时出现在 revise 中；retire 表示该后代随补丁移出活动图。',
    '',
    '直接受影响节点（草案必须用 revise 或 retire 表达；仅 add 不算处置）：',
    ...(request.affectedWorkPackageIds.length === 0
      ? ['- 本次没有直接受影响的节点。']
      : request.affectedWorkPackageIds.map((workPackageId) => `- ${workPackageId}`)),
    '',
    '只输出一个 JSON 对象，形状必须逐字符合下面的骨架（占位符替换为实际内容，不多不少字段）：',
    '{',
    `  "baseGraphVersion": ${request.baseGraphVersion},`,
    '  "patchId": "<原样回显输入的 patchId>",',
    '  "operationId": "<原样回显输入的 operationId>",',
    '  "add": [',
    '    {',
    '      "key": "<同一补丁内唯一的新增节点键>",',
    '      "title": "<标题>",',
    '      "dependsOn": [{ "kind": "existing", "workPackageId": "<当前图中的 id>" }],',
    '      "scopeEnvelope": { "include": ["src/example"], "exclude": [] }',
    '    }',
    '  ],',
    '  "revise": [',
    '    {',
    '      "workPackageId": "<当前图中未接受的 id>",',
    '      "title": "<标题>",',
    '      "dependsOn": [{ "kind": "added", "key": "<同一补丁内新增节点的 key>" }],',
    '      "scopeEnvelope": { "include": ["src/example"], "exclude": [] }',
    '    }',
    '  ],',
    '  "retire": ["<当前图中未接受的 id>"],',
    '  "descendants": [{ "workPackageId": "<未接受后代 id>", "disposition": "unchanged" }],',
    '  "takesOver": [{ "workPackageId": "<被处置的 id>", "takesOverByKey": "<新增节点的 key>" }]',
    '}',
    '形状硬约束：',
    '- scopeEnvelope 必须**同时**给出 include 与 exclude 两个字符串数组；没有排除项时 exclude 写 []，不得省略字段。',
    '- dependsOn 的每个元素必须是一个对象，kind 只能是 "existing" 或 "added"，不得直接写字符串。',
    '- add、revise、retire、descendants、takesOver 五个数组必须全部出现；没有内容时写 []。',
    '不要输出解释、Markdown 或代码围栏。',
  ].join('\n');
}
