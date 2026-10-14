/**
 * IP-4 资格摘要（change: `grade-worker-harness-admission`）。
 *
 * 这里是随发布包分发的「已验收事实」副本：每条能力事实都带来源引用，来源是仓库里的真实隔离
 * 验收工件，或记录该轮结果的验收说明。缺失、失败与未运行分别记录；模型回显、usage 与目录
 * 只作展示，不参与等级推导。等级一律由 domain 的递进规则从事实推导，本模块不另立判据。
 *
 * 判据只认真实运行结论：角色要真正运行、绑定到精确 Orca task/dispatch、结算 succeeded 且产物
 * 核验通过；只读要有拒写探针的 `readOnlyVerified`；续接要同时有原 Session resume 与 Validator
 * 同 Session 且上下文保留。绑定窗口内缺原生报告属于「未证」，不作为执行失败记录。
 *
 * 运行时不读仓库工件：发布包只带这份摘要。`qualificationFromAcceptance` 供采集器复用，把同一
 * 形状的真实验收 JSON 在信任边界上解析成资格记录。
 */

import { z } from 'zod';

import {
  deriveWorkerSupportLevel,
  type WorkerCapability,
  type WorkerCapabilityEvidence,
  type WorkerHarnessQualification,
  type WorkerSupportLevel,
} from '../../domain/worker-harness-support.js';

export type WorkerHarnessSupport = {
  readonly level: WorkerSupportLevel;
  readonly qualificationRef: string;
};

function verified(capability: WorkerCapability, evidenceRef: string): WorkerCapabilityEvidence {
  return { capability, state: 'verified', evidenceRef, diagnostic: null };
}

function failed(capability: WorkerCapability, diagnostic: string): WorkerCapabilityEvidence {
  return { capability, state: 'failed', evidenceRef: null, diagnostic };
}

// 来源工件（只引用路径，不读取内容）。
const IP15_MATRIX = 'artifacts/worker-harness-adapters/ip15-2026-10-06T05-02-57-524Z.json';
const IP15_MATRIX_READ_ONLY = 'artifacts/worker-harness-adapters/README.md';
const COMMAND_QWEN_MATRIX = 'artifacts/next-worker-harness-adapters/ip04-2026-10-11T05-08-24-154Z-7fc1a011-b14e-47d2-8e5a-e550e0635a8d.json';
const COMMAND_BASIC = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-55-18-402Z-43432fa6-df72-4e03-b63f-5cb3f5fe6d1d.json';
const KIMI_ENHANCED = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-59-22-461Z-b759fd59-591a-4350-ac07-4e86a19c5749.json';
const HERMES_ENHANCED = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-47-09-882Z-9b7cbd78-6396-4085-aa3a-8cd4f3ac4faa.json';
const COMMAND_QWEN_CONTROLLER = 'artifacts/next-worker-harness-adapters/controller-20261011T085821980Z-89759c30-e5f4-4a09-8624-89e137fe85f5.json';
const ANTIGRAVITY_ROLES = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-15-07-641Z-5cf6ca74-2bd4-450d-b9de-dcfc280266b6.json';
const ANTIGRAVITY_RECOVERY = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T02-42-26-090Z-425d6eb9-bcb6-44a2-903e-6f57e500e3fc.json';
const ANTIGRAVITY_CONTROLLER = 'artifacts/next-worker-harness-adapters/antigravity-tui-qualification-20261014.json';
const CODEX_RUNTIME = 'docs/orca-compatibility.md';
const CODEX_RESUME_PROBE = 'artifacts/execution-concurrency/provider-resume-probe.json';
const KILO_MATRIX = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T08-44-08-445Z-41c485aa-165c-44ec-b59c-8e1ed5fd46b6.json';
const KILO_ENHANCED = 'artifacts/next-worker-harness-adapters/ip04-2026-10-14T13-37-47-768Z-ddf96f16-587f-48fb-bf2c-97247e6fbb96.json';
const DEFAULT_TUI_MATRIX = 'artifacts/next-worker-harness-adapters/default-tui-matrix-20261012.json';
const CANDIDATE_DISPOSITION = 'docs/research/next-worker-harness-adapters.md';

/**
 * 隔离矩阵的公共证据：四个角色都 ran 且结算 succeeded、产物核验通过，coverage 全为 complete，
 * 每个角色的精确 Session 已绑定。`readOnlyRef` 只在原轮有记录到的只读结论时传入。
 */
function isolatedMatrixFacts(source: string, readOnlyRef?: string): readonly WorkerCapabilityEvidence[] {
  const facts: WorkerCapabilityEvidence[] = [
    verified('task_input', `${source}#roles`),
    verified('orca_binding', `${source}#roles.dispatchId`),
    verified('planner_result', `${source}#roles.planner`),
    verified('implementation_result', `${source}#roles.implementation`),
    verified('validator_result', `${source}#roles.validator`),
    verified('finalizer_result', `${source}#roles.finalizer`),
    verified('native_session', `${source}#roles.sessionId`),
    verified('transcript_coverage', `${source}#roles.coverage`),
  ];
  if (readOnlyRef !== undefined) facts.push(verified('read_only', readOnlyRef));
  return facts;
}

/** 完整矩阵在公共证据之外还有原 Session resume、Validator 续接、只读拒写证据与 Recovery。 */
function completeMatrixFacts(
  source: string,
  sessionResumeRef: string,
  readOnlyRef: string,
  controllerRef: string,
): readonly WorkerCapabilityEvidence[] {
  return [
    ...isolatedMatrixFacts(source),
    verified('session_resume', sessionResumeRef),
    verified('read_only', readOnlyRef),
    verified('recovery', `${source}#recovery`),
    verified('mixed_controller', controllerRef),
  ];
}

const BUNDLED_QUALIFICATIONS: readonly WorkerHarnessQualification[] = [
  {
    // Codex 的真实端到端闭环记录在兼容性文档（结构化事实当时留在项目外的临时目录）：四角色派发、
    // 精确 Session、只读探针、Recovery Capsule 与 deliverable；原生 resume 由独立探针记录。
    // 没有 mixed Controller 证据（已知混合闭环使用的是 Command Code/Qwen 与 Antigravity/Qwen），
    // mixed_controller 无记录，因此 complete 不成立。
    harness: 'codex',
    evidenceRef: CODEX_RUNTIME,
    facts: [
      verified('task_input', CODEX_RUNTIME),
      verified('orca_binding', CODEX_RUNTIME),
      verified('planner_result', CODEX_RUNTIME),
      verified('implementation_result', CODEX_RUNTIME),
      verified('native_session', CODEX_RESUME_PROBE),
      verified('session_resume', CODEX_RESUME_PROBE),
      verified('read_only', CODEX_RUNTIME),
      verified('validator_result', CODEX_RUNTIME),
      verified('finalizer_result', CODEX_RUNTIME),
      verified('transcript_coverage', CODEX_RUNTIME),
      verified('recovery', CODEX_RUNTIME),
    ],
  },
  // 这四家在隔离矩阵里的只读结论由该轮说明记录（共用 bwrap 包装器与拒写探针），但没有 Validator
  // 同 Session 续接的字段证据，enhanced 不成立，等级停在 basic。
  { harness: 'claude', evidenceRef: IP15_MATRIX, facts: isolatedMatrixFacts(IP15_MATRIX, IP15_MATRIX_READ_ONLY) },
  { harness: 'opencode', evidenceRef: IP15_MATRIX, facts: isolatedMatrixFacts(IP15_MATRIX, IP15_MATRIX_READ_ONLY) },
  { harness: 'pi', evidenceRef: IP15_MATRIX, facts: isolatedMatrixFacts(IP15_MATRIX, IP15_MATRIX_READ_ONLY) },
  { harness: 'omp', evidenceRef: IP15_MATRIX, facts: isolatedMatrixFacts(IP15_MATRIX, IP15_MATRIX_READ_ONLY) },
  {
    harness: 'command-code',
    evidenceRef: COMMAND_QWEN_MATRIX,
    facts: completeMatrixFacts(
      COMMAND_QWEN_MATRIX,
      `${COMMAND_QWEN_MATRIX}#resume.sameSession+validatorContinuation.contextPreserved`,
      `${COMMAND_QWEN_MATRIX}#recovery.readOnlyVerified`,
      COMMAND_QWEN_CONTROLLER,
    ).map(fact => ['task_input', 'orca_binding', 'planner_result', 'implementation_result'].includes(fact.capability)
      ? verified(fact.capability, `${COMMAND_BASIC}#roles`) : fact),
  },
  {
    harness: 'qwen-code',
    evidenceRef: COMMAND_QWEN_MATRIX,
    facts: completeMatrixFacts(
      COMMAND_QWEN_MATRIX,
      `${COMMAND_QWEN_MATRIX}#resume.sameSession+validatorContinuation.contextPreserved`,
      `${COMMAND_QWEN_MATRIX}#recovery.readOnlyVerified`,
      COMMAND_QWEN_CONTROLLER,
    ),
  },
  {
    harness: 'antigravity',
    evidenceRef: ANTIGRAVITY_ROLES,
    facts: completeMatrixFacts(
      ANTIGRAVITY_ROLES,
      `${ANTIGRAVITY_ROLES}#resume.sameSession+${ANTIGRAVITY_RECOVERY}#validatorContinuation.contextPreserved`,
      `${ANTIGRAVITY_RECOVERY}#recovery.readOnlyVerified`,
      ANTIGRAVITY_CONTROLLER,
    ).map(fact => fact.capability === 'recovery' ? verified('recovery', `${ANTIGRAVITY_RECOVERY}#recovery`) : fact),
  },
  {
    // 缺少新报告不撤销已核验的单次成功：Planner 使用最新矩阵，Implementation 保留默认 TUI 成功记录。
    harness: 'kilo',
    evidenceRef: KILO_ENHANCED,
    facts: [
      verified('task_input', `${KILO_MATRIX}#roles.planner`),
      verified('orca_binding', `${KILO_MATRIX}#roles.planner.dispatchId`),
      verified('planner_result', `${KILO_MATRIX}#roles.planner`),
      verified('implementation_result', `${DEFAULT_TUI_MATRIX}#singleVariableNoEnter.kiloImplementation`),
      verified('validator_result', `${KILO_ENHANCED}#roles.validator`),
      verified('native_session', `${KILO_MATRIX}#roles.planner.sessionId`),
    ],
  },
  {
    harness: 'kimi',
    evidenceRef: KIMI_ENHANCED,
    facts: [
      verified('task_input', `${KIMI_ENHANCED}#roles`),
      verified('orca_binding', `${KIMI_ENHANCED}#roles.dispatchId`),
      verified('planner_result', `${KIMI_ENHANCED}#roles.planner`),
      verified('implementation_result', `${KIMI_ENHANCED}#roles.implementation`),
      verified('validator_result', `${KIMI_ENHANCED}#roles.validator`),
      verified('finalizer_result', `${KIMI_ENHANCED}#roles.finalizer`),
      verified('native_session', `${KIMI_ENHANCED}#roles.sessionId`),
      verified('session_resume', `${KIMI_ENHANCED}#resume.sameSession+validatorContinuation.contextPreserved`),
      verified('transcript_coverage', `${KIMI_ENHANCED}#roles.coverage`),
    ],
  },
  {
    // 四角色与原 Session 续接通过；公开 export 仍不覆盖 inactive/compacted 历史。
    harness: 'hermes',
    evidenceRef: HERMES_ENHANCED,
    facts: [
      verified('task_input', `${HERMES_ENHANCED}#roles`),
      verified('orca_binding', `${HERMES_ENHANCED}#roles.dispatchId`),
      verified('planner_result', `${HERMES_ENHANCED}#roles.planner`),
      verified('implementation_result', `${HERMES_ENHANCED}#roles.implementation`),
      verified('validator_result', `${HERMES_ENHANCED}#roles.validator`),
      verified('finalizer_result', `${HERMES_ENHANCED}#roles.finalizer`),
      verified('native_session', `${HERMES_ENHANCED}#roles.sessionId`),
      verified('session_resume', `${HERMES_ENHANCED}#resume.sameSession+validatorContinuation.contextPreserved`),
      failed('transcript_coverage', 'coverage_incomplete'),
    ],
  },
  {
    // 生产 launcher（不加额外 Enter）下的 Validator 有精确绑定、工件与 worker_done；messages 是可覆盖
    // 的上下文快照，coverage 仍为 partial。没有 Planner/Implementation 证据。
    harness: 'cline',
    evidenceRef: DEFAULT_TUI_MATRIX,
    facts: [
      verified('task_input', `${DEFAULT_TUI_MATRIX}#singleVariableNoEnter.clineValidator`),
      verified('orca_binding', `${DEFAULT_TUI_MATRIX}#singleVariableNoEnter.clineValidator.dispatchId`),
      verified('validator_result', `${DEFAULT_TUI_MATRIX}#singleVariableNoEnter.clineValidator`),
      verified('native_session', `${DEFAULT_TUI_MATRIX}#singleVariableNoEnter.clineValidator.sessionId`),
      failed('transcript_coverage', 'coverage_incomplete'),
    ],
  },
  // 本地不存在可执行文件，只有离线 fixture：没有真实测试，资格为空。
  { harness: 'muse', evidenceRef: CANDIDATE_DISPOSITION, facts: [] },
  { harness: 'cursor', evidenceRef: CANDIDATE_DISPOSITION, facts: [] },
];

const BUNDLED_BY_HARNESS = new Map(BUNDLED_QUALIFICATIONS.map((entry) => [entry.harness, entry] as const));

/** 未记录的 harness：空事实，引用指向本摘要并标明缺失。 */
function missingQualification(harness: string): WorkerHarnessQualification {
  return { harness, evidenceRef: `report:worker-harness-qualifications#missing/${harness}`, facts: [] };
}

export function workerHarnessQualification(harness: string): WorkerHarnessQualification {
  return BUNDLED_BY_HARNESS.get(harness) ?? missingQualification(harness);
}

export function workerHarnessSupport(harness: string): WorkerHarnessSupport {
  const qualification = workerHarnessQualification(harness);
  return { level: deriveWorkerSupportLevel(qualification), qualificationRef: qualification.evidenceRef };
}

// ---------------------------------------------------------------------------------------------
// 采集器：把同一形状的真实验收 JSON 解析成资格记录
// ---------------------------------------------------------------------------------------------

const acceptanceRoleSchema = z.looseObject({
  role: z.string(),
  kind: z.string(),
  terminalState: z.string().nullish(),
  artifactOk: z.boolean().nullish(),
  coverage: z.string().nullish(),
  sessionId: z.string().nullish(),
  taskId: z.string().nullish(),
  dispatchId: z.string().nullish(),
  readOnlyVerified: z.boolean().nullish(),
  blocker: z.unknown().optional(),
});

const acceptanceSessionSchema = z.looseObject({
  kind: z.string(),
  sameSession: z.boolean().nullish(),
  contextPreserved: z.boolean().nullish(),
  sessionId: z.string().nullish(),
  blocker: z.unknown().optional(),
});

const acceptanceRecoverySchema = z.looseObject({
  kind: z.string(),
  sourceBehaviorVerified: z.boolean().nullish(),
  readOnlyVerified: z.boolean().nullish(),
  coverage: z.unknown().optional(),
  blocker: z.unknown().optional(),
});

const acceptanceHarnessSchema = z.looseObject({
  harness: z.string(),
  roles: z.array(acceptanceRoleSchema).optional(),
  resume: acceptanceSessionSchema.nullish(),
  validatorContinuation: acceptanceSessionSchema.nullish(),
  recovery: acceptanceRecoverySchema.nullish(),
});

const acceptanceEvidenceSchema = z.looseObject({ harnesses: z.array(z.unknown()) });

type AcceptanceRole = z.infer<typeof acceptanceRoleSchema>;
type AcceptanceHarness = z.infer<typeof acceptanceHarnessSchema>;

const ROLE_RESULTS: ReadonlyArray<readonly [string, WorkerCapability]> = [
  ['planner', 'planner_result'],
  ['implementation', 'implementation_result'],
  ['validator', 'validator_result'],
  ['finalizer', 'finalizer_result'],
];

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 一个角色只有在真正运行、绑定到精确 Orca task/dispatch、结算 succeeded 且产物核验通过后才算证据。 */
function provenRole(role: AcceptanceRole): boolean {
  return role.kind === 'ran'
    && role.terminalState === 'succeeded'
    && role.artifactOk === true
    && nonEmpty(role.taskId) && nonEmpty(role.dispatchId);
}

/** 运行到 succeeded 但产物没核验：这是确定的失败，而不是缺证据。 */
function artifactUnverified(role: AcceptanceRole): boolean {
  return role.kind === 'ran' && role.terminalState === 'succeeded' && role.artifactOk !== true;
}

function blockerCode(blocker: unknown): string {
  if (typeof blocker === 'object' && blocker !== null && 'code' in blocker) {
    const code: unknown = (blocker as { code?: unknown }).code;
    if (nonEmpty(code)) return code;
  }
  return 'blocked';
}

/** coverage 在工件里既可能是字符串，也可能是带 `coverage` 字段的物件。 */
function coverageValue(coverage: unknown): string | null {
  if (typeof coverage === 'string') return coverage;
  if (typeof coverage === 'object' && coverage !== null && 'coverage' in coverage) {
    const inner: unknown = (coverage as { coverage?: unknown }).coverage;
    if (typeof inner === 'string') return inner;
  }
  return null;
}

function qualificationForHarness(
  entry: AcceptanceHarness,
  source: string,
  mixedControllerVerified: boolean,
): WorkerHarnessQualification {
  const ref = `${source}#${entry.harness}`;
  const roles = entry.roles ?? [];
  const roleFor = (name: string): AcceptanceRole | undefined => roles.find((candidate) => candidate.role === name);
  const facts: WorkerCapabilityEvidence[] = [];

  for (const [name, capability] of ROLE_RESULTS) {
    const run = roleFor(name);
    if (run === undefined) continue;
    if (provenRole(run)) facts.push(verified(capability, `${ref}/roles.${name}`));
    else if (artifactUnverified(run)) facts.push(failed(capability, 'artifact_unverified'));
  }

  const proven = roles.filter(provenRole);
  if (proven.length > 0) {
    facts.push(verified('task_input', `${ref}/roles`));
    facts.push(verified('orca_binding', `${ref}/roles.dispatchId`));
  }
  if (ROLE_RESULTS.every(([name]) => {
    const run = roleFor(name);
    return run !== undefined && provenRole(run) && nonEmpty(run.sessionId);
  })) facts.push(verified('native_session', `${ref}/roles.sessionId`));

  // 续接要同时证明原 Session resume 与 Validator 同 Session 且上下文保留，缺一条都只是未证。
  const resume = entry.resume ?? null;
  const continuation = entry.validatorContinuation ?? null;
  const continuedSession = resume?.kind === 'ran' && resume.sameSession === true
    && continuation?.kind === 'ran' && continuation.sameSession === true && continuation.contextPreserved === true;
  if (continuedSession) facts.push(verified('session_resume', `${ref}/resume.sameSession+validatorContinuation.contextPreserved`));
  else if ((resume?.kind === 'ran' && resume.sameSession === false)
    || (continuation?.kind === 'ran' && (continuation.sameSession === false || continuation.contextPreserved === false))) {
    facts.push(failed('session_resume', 'session_not_continued'));
  }

  // 只读只认拒写探针的实际结论：角色自带的 `readOnlyVerified`（权限拒绝工具或哨兵），或 Recovery
  // 的同一结论。产物核验与 succeeded 本身不构成只读证明。
  const recovery = entry.recovery ?? null;
  const roleWriteDenied = roles.find((run) => run.kind === 'ran' && run.readOnlyVerified === true);
  const roleWriteAllowed = roles.find((run) => run.kind === 'ran' && run.readOnlyVerified === false);
  if (roleWriteDenied !== undefined) {
    facts.push(verified('read_only', `${ref}/roles.${roleWriteDenied.role}.readOnlyVerified`));
  } else if (recovery?.kind === 'ran' && recovery.readOnlyVerified === true) {
    facts.push(verified('read_only', `${ref}/recovery.readOnlyVerified`));
  } else if (roleWriteAllowed !== undefined || (recovery?.kind === 'ran' && recovery.readOnlyVerified === false)) {
    facts.push(failed('read_only', 'write_not_denied'));
  }
  if (recovery?.kind === 'ran') {
    if (recovery.readOnlyVerified === true
      && recovery.sourceBehaviorVerified === true
      && coverageValue(recovery.coverage) === 'complete') {
      facts.push(verified('recovery', `${ref}/recovery`));
    } else {
      facts.push(failed('recovery', blockerCode(recovery.blocker)));
    }
  }

  const covered = ROLE_RESULTS.map(([name]) => roleFor(name));
  if (covered.every((run) => run !== undefined && provenRole(run) && run.coverage === 'complete')) {
    facts.push(verified('transcript_coverage', `${ref}/roles.coverage`));
  } else if (covered.some((run) => run !== undefined && run.kind === 'ran'
    && coverageValue(run.coverage) !== null && run.coverage !== 'complete')) {
    facts.push(failed('transcript_coverage', 'coverage_incomplete'));
  }

  if (mixedControllerVerified) facts.push(verified('mixed_controller', `${ref}/mixed-controller`));

  return { harness: entry.harness, evidenceRef: ref, facts };
}

/**
 * 解析一次真实验收摘要，返回其中每个 harness 的资格记录。
 *
 * 事实只来自角色运行、resume/validatorContinuation 与 recovery 的结构化字段；`modelEvidence`、
 * usage 与模型目录一律不看。输入缺失或损坏时返回空数组——空事实只会得到 `unavailable`，不会被
 * 读成通过。`mixedControllerVerified` 只能由调用方按独立的 Controller 闭环结论显式传入。
 */
export function qualificationFromAcceptance(
  input: unknown,
  evidenceRef: string,
  mixedControllerVerified = false,
): WorkerHarnessQualification[] {
  const evidence = acceptanceEvidenceSchema.safeParse(input);
  if (!evidence.success) return [];
  const qualifications: WorkerHarnessQualification[] = [];
  for (const raw of evidence.data.harnesses) {
    const entry = acceptanceHarnessSchema.safeParse(raw);
    if (!entry.success || !nonEmpty(entry.data.harness)) continue;
    qualifications.push(qualificationForHarness(entry.data, evidenceRef, mixedControllerVerified));
  }
  return qualifications;
}
