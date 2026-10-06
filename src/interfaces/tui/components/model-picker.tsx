/**
 * 角色模型界面（IP-06，定稿 #52）。
 *
 * 两层：模型配置页按定稿分为当前 Coordinator、Planning 与 Execution 三区；进入某个角色后是候选菜单，
 * 候选行只显示 provider / model，effort 是独立的一条水平选择，且只列该模型可信能力来源里的值。
 *
 * 界面不构造模型目录，也不猜测 effort：候选、当前绑定与不可用原因全部来自宿主 ModelCatalog，
 * 没有可信来源时 effort 恒为不可用，因此无法保存虚构 effort。默认动作永远是返回。
 */

import { Box, Text } from 'ink';

import { ActionRow, DialogFrame, fieldRows } from './selection-list.js';
import { tuiColors } from '../theme.js';
import { displayWidth, padToDisplayWidth, truncateToDisplayWidth } from '../render/width.js';
import type {
  ModelCatalog,
  ModelRoleCandidate,
  ModelRoleGroup,
  ModelRoleView,
  ModelSettingsRole,
} from '../ports.js';
import type { ModelRoleMenuState, ModelWorkerCatalogState } from '../state.js';

/** 定稿三分区的标题；角色顺序由宿主的 roles 给定，界面不重排。 */
export const MODEL_ROLE_GROUP_LABELS: Readonly<Record<ModelRoleGroup, string>> = {
  current: '当前会话',
  planning: 'Planning · 路线规划',
  execution: 'Execution · 执行协调',
};

/**
 * effort 横向窗口最多同时显示的取值个数。
 *
 * 这是上限而不是承诺值：真实窗口由终端宽度决定（见 effortWindow）。候选最多声明 16 个取值，
 * 这一行必须有界，更多取值靠左右键滚动，选中项始终落在窗口内——看不见的选中项等于用户无法
 * 确认自己选了什么。
 */
const EFFORT_WINDOW = 5;

const EFFORT_LABEL = 'Effort ';
const SOURCE_OVERHEAD = displayWidth(' · 来源 ');
const CHIP_PADDING = 4;

const ROLE_LABELS: Readonly<Record<ModelSettingsRole, string>> = {
  coordinator: 'Coordinator',
  planning_utility: 'Utility',
  planner: 'Planner',
  specification_validator: 'Spec Validator',
  implementation: 'Implementation',
  validator: 'Validator',
  finalizer: 'Finalizer',
  recovery_utility: 'Recovery Utility',
};

/** 定稿的角色用途文案，用于底部说明当前区域。 */
const ROLE_PURPOSES: Readonly<Record<ModelSettingsRole, string>> = {
  coordinator: '当前会话的协调模型',
  planning_utility: '调研与规划协助',
  planner: '编写工作包规格',
  specification_validator: '独立规格验证 · 可选',
  implementation: '实现工作包',
  validator: '验证、修复与复验',
  finalizer: '只读项目验收',
  recovery_utility: '生成恢复材料',
};

const ROLE_ORDER: readonly ModelSettingsRole[] = [
  'coordinator',
  'planning_utility',
  'planner',
  'specification_validator',
  'implementation',
  'validator',
  'finalizer',
  'recovery_utility',
];

export function roleLabel(role: ModelSettingsRole): string {
  return ROLE_LABELS[role];
}

export function rolePurpose(role: ModelSettingsRole): string {
  return ROLE_PURPOSES[role];
}

/**
 * 解析角色列表。
 *
 * 宿主提供 roles 时原样使用；缺省时按定稿顺序合成完整列表，只有 Coordinator 从既有 options 得到
 * 候选，其余角色明确标为未接通。这样旧端口仍能表达 Coordinator 切换，其余角色也不会被静默隐藏。
 */
export function modelRoles(catalog: ModelCatalog): readonly ModelRoleView[] {
  if (catalog.roles !== undefined) {
    return catalog.roles;
  }
  const current = catalog.options.find((option) => option.configurationRef === catalog.currentConfigurationRef);
  return ROLE_ORDER.map((role) =>
    role === 'coordinator'
      ? {
          role,
          label: ROLE_LABELS[role],
          group: 'current' as const,
          current:
            catalog.currentConfigurationRef === null
              ? null
              : {
                  candidateRef: catalog.currentConfigurationRef,
                  provider: current?.provider ?? '',
                  model: current?.model ?? catalog.currentConfigurationRef,
                  effort: null,
                },
          candidates: catalog.options.map((option) => ({
            candidateRef: option.configurationRef,
            connectionRef: null,
            provider: option.provider ?? '',
            model: option.model,
            effortCapability: option.effortCapability ?? null,
          })),
          availability: { available: true, reason: null },
        }
      : {
          role,
          label: ROLE_LABELS[role],
          group: (role === 'planning_utility' ? 'planning' : 'execution') as ModelRoleGroup,
          current: null,
          candidates: [],
          availability: { available: false, reason: '角色模型配置尚未接通' },
        },
  );
}

/** 角色行摘要：只显示 provider / model / effort，不表达实现细节。 */
export function modelRoleSummary(role: ModelRoleView): string {
  if (!role.availability.available) {
    return '未启用';
  }
  if (role.current === null) {
    return '未配置';
  }
  const parts = [role.current.provider, role.current.model].filter((part) => part !== '');
  // effort 为 null 有两种含义，不能一律说成「不支持」：候选自己带可信能力来源时是「还没设」，
  // 没有任何可信来源时才是「不支持」。判定只用该角色候选的能力，不新增字段。
  const capability =
    role.candidates.find((candidate) => candidate.candidateRef === role.current?.candidateRef)
      ?.effortCapability ?? null;
  const effort = role.current.effort ?? (capability === null ? '不支持 effort' : '未设置 effort');
  return [...parts, effort].join(' / ');
}

/**
 * Coordinator Model Configuration 的切换准入。
 *
 * switchable 由宿主用 assertSwitchable({suspension, inFlightModelOperations}) 判定：只有它同时持有
 * 「是否挂起」与「在途模型操作数」这两个权威事实。界面只显示判决，不自己猜。
 */
export function modelSwitchAdmission(catalog: ModelCatalog): {
  readonly allowed: boolean;
  readonly reason: string | null;
} {
  if (catalog.options.length === 0) {
    return { allowed: false, reason: '没有可用的 Coordinator Model Configuration' };
  }
  if (!catalog.switchable) {
    return { allowed: false, reason: catalog.switchBlockReason ?? 'Coordinator Session 当前不可切换' };
  }
  return { allowed: true, reason: null };
}

/** 角色能否进入候选菜单；Coordinator 额外沿用既有的挂起与在途准入。 */
export function modelRoleAdmission(
  role: ModelRoleView,
  catalog: ModelCatalog,
): { readonly allowed: boolean; readonly reason: string | null } {
  if (!role.availability.available) {
    return { allowed: false, reason: role.availability.reason };
  }
  if (role.role === 'coordinator') {
    if (role.candidates.length === 0) {
      return { allowed: false, reason: '没有可用的模型候选' };
    }
    return modelSwitchAdmission(catalog);
  }
  // Worker 候选来自该 harness 的原生目录（进入菜单后才显式查询），因此不以静态候选列表准入。
  return { allowed: true, reason: null };
}

export function candidateLabel(candidate: ModelRoleCandidate): string {
  return candidate.provider === '' ? candidate.model : candidate.provider + ' / ' + candidate.model;
}

/**
 * 同一 provider / model 只保留一条候选。
 *
 * 一个模型可以有多个 effort 与多条不可变引用，但定稿的候选列表按 provider / model 组织；不按标签
 * 去重就会出现「同一模型两行」，把 effort 差异误读成两个模型。候选按配置追加顺序提供，
 * 同组使用最后保存的引用，才能显式应用刚编辑的连接；既有当前绑定仍由独立摘要显示。
 */
export function dedupeRoleCandidates(candidates: readonly ModelRoleCandidate[]): readonly ModelRoleCandidate[] {
  const latest = new Map<string, ModelRoleCandidate>();
  for (const candidate of candidates) {
    latest.set(candidateLabel(candidate), candidate);
  }
  return [...latest.values()];
}

export function selectedRoleCandidate(
  role: ModelRoleView,
  candidateRef: string | null,
): ModelRoleCandidate | null {
  return role.candidates.find((candidate) => candidate.candidateRef === candidateRef) ?? null;
}

/**
 * 可保存的 effort 值。
 *
 * 唯一来源是候选自己的 effortCapability.values；没有可信来源时返回空数组，界面因此无法提供或保存
 * 任何 effort 草稿。
 */
export function effortValues(candidate: ModelRoleCandidate | null): readonly string[] {
  return candidate?.effortCapability?.values ?? [];
}

export type EffortWindow = {
  /** 窗口起点与窗口内的取值。 */
  readonly start: number;
  readonly values: readonly string[];
  /** 每个取值的显示宽度；调用方按此渲染，保证整行不换行。 */
  readonly labelWidth: number;
  /** 能力来源可用的显示宽度；`sourceVisible` 为假表示本宽度下不展示来源。 */
  readonly sourceWidth: number;
  readonly sourceVisible: boolean;
};

/**
 * 按真实可用宽度求 effort 的横向窗口。
 *
 * 三件事必须同时成立：整行不换行（否则固定框被顶开）、窗口内至少有一个取值、选中值一定落在
 * 窗口内。先给交互控件（effort 取值）让出宽度，再用剩下的给静态的可信来源；来源窄到只剩碎片
 * 就不显示，而不是给出一个被截断到失真的来源。
 */
export function effortWindow(
  values: readonly string[],
  selected: string | null,
  inner: number,
  hasSource: boolean,
): EffortWindow {
  if (values.length === 0) {
    return { start: 0, values, labelWidth: 0, sourceWidth: 0, sourceVisible: false };
  }
  const available = Math.max(1, inner - displayWidth(EFFORT_LABEL));
  const sourceWidth = hasSource
    ? Math.max(0, Math.min(24, Math.floor(available / 3) - SOURCE_OVERHEAD))
    : 0;
  const sourceVisible = sourceWidth >= 6;
  const chipsBudget = Math.max(1, available - (sourceVisible ? SOURCE_OVERHEAD + sourceWidth : 0));
  const longest = values.reduce((best, value) => Math.max(best, displayWidth(value)), 1);
  const target = Math.min(EFFORT_WINDOW, values.length);
  const capacityAt = (labelWidth: number): number =>
    Math.max(1, Math.floor(chipsBudget / (labelWidth + CHIP_PADDING)));
  // 先用能完整显示的宽度；只有取值多于该宽度放得下的数量时才收窄标签。
  let labelWidth = Math.min(16, longest);
  while (labelWidth > 1 && capacityAt(labelWidth) < target) {
    labelWidth -= 1;
  }
  const capacity = Math.min(values.length, capacityAt(labelWidth));
  const selectedIndex = selected === null ? -1 : values.indexOf(selected);
  const start =
    values.length <= capacity
      ? 0
      : Math.max(0, Math.min(values.length - capacity, selectedIndex - Math.floor(capacity / 2)));
  return { start, values: values.slice(start, start + capacity), labelWidth, sourceWidth, sourceVisible };
}

export type ModelPickerProps = {
  readonly catalog: ModelCatalog;
  /** Controller 上一次拒绝的原因；null 表示没有被拒绝过。 */
  readonly rejection: string | null;
  /** 上一次保存或应用的结构化结果；按定稿取代默认的区域说明行。 */
  readonly notice?: string | null;
  readonly onOpenRole: (role: ModelSettingsRole) => void;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly roleIndex?: number;
  /** 身份摘要沿用定稿：项目 / 分支 / Session。 */
  readonly identity?: string;
};

/** 模型配置页：三区角色列表，保持定稿布局与返回约定。 */
export function ModelPicker(props: ModelPickerProps) {
  const roles = modelRoles(props.catalog);
  const rows = props.rows ?? 16;
  const index = Math.max(0, Math.min(props.roleIndex ?? 0, roles.length - 1));
  const selected = roles[index];
  const inner = Math.max(1, props.availableWidth - 8);
  /**
   * 角色列表的行预算。
   *
   * 固定外框占 6 行（上下边框、标题、摘要、分隔、footer），分隔线、用途说明与计数各占 1 行，
   * Controller 的拒绝原因再占 1 行。剩下的全部给角色列表：80×24 得 8 行（定稿原型在同样高度下
   * 展示 3 个分区标题加 6 个角色），120×40 得 24 行。
   */
  const listBudget = Math.max(1, rows - 9 - (props.rejection === null ? 0 : 1));
  const admission =
    selected === undefined
      ? { allowed: false, reason: null }
      : modelRoleAdmission(selected, props.catalog);
  const wide = inner >= 65;
  const rowLines = roles.flatMap((role, position) => {
    const previous = roles[position - 1];
    const heading =
      position === 0 || role.group !== previous?.group
        ? [{ text: '── ' + MODEL_ROLE_GROUP_LABELS[role.group] + ' ──', selected: false }]
        : [];
    const prefix = position === index ? '› ' : '  ';
    if (wide) {
      return [
        ...heading,
        {
          text:
            padToDisplayWidth(truncateToDisplayWidth(prefix + role.label, 23), 24) +
            truncateToDisplayWidth(modelRoleSummary(role), Math.max(1, inner - 24)),
          selected: position === index,
        },
      ];
    }
    // 窄屏放不下两列：先给「角色 · 用途」，摘要单独一行，分区标题仍然保留。
    return [
      ...heading,
      { text: truncateToDisplayWidth(prefix + role.label + ' · ' + rolePurpose(role.role), inner), selected: position === index },
      { text: '  ' + truncateToDisplayWidth(modelRoleSummary(role), Math.max(1, inner - 2)), selected: position === index },
    ];
  });
  const lines = rowLines.map((row) => row.text);
  const selectedLine = rowLines.findIndex((row) => row.selected);
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, lines.length - listBudget),
      Math.max(0, selectedLine) - Math.floor(listBudget / 2),
    ),
  );
  return (
    <DialogFrame
      title="Model Picker · 模型配置"
      summary={props.identity ?? '按角色分别选择模型与 effort'}
      width={props.availableWidth}
      rows={rows}
      footer="Provider / Model / Effort · 按角色分别选择"
    >
      <Box height={listBudget} flexDirection="column" overflow="hidden">
        {rowLines.slice(start, start + listBudget).map((row, offset) => {
          const heading = row.text.startsWith('── ');
          return (
            <Text
              key={start + offset}
              bold={heading || row.selected}
              inverse={row.selected}
              {...(heading ? { color: tuiColors.accent } : {})}
            >
              {truncateToDisplayWidth(row.text, inner)}
            </Text>
          );
        })}
      </Box>
      <Text color={tuiColors.border}>{'─'.repeat(inner)}</Text>
      <Text color={tuiColors.warning}>
        {truncateToDisplayWidth(
          props.notice ??
            admission.reason ??
            (selected === undefined ? '没有可用的角色' : rolePurpose(selected.role)),
          inner,
        )}
      </Text>
      <Text dimColor>
        {truncateToDisplayWidth(
          String(index + 1) + '/' + String(roles.length) + ' · ↑↓ 选角色 · Enter 更换 · Esc 返回',
          inner,
        )}
      </Text>
      {props.rejection === null ? null : <Text>{truncateToDisplayWidth('! ' + props.rejection, inner)}</Text>}
    </DialogFrame>
  );
}

export type RoleModelMenuProps = {
  readonly role: ModelRoleView;
  readonly menu: ModelRoleMenuState;
  /** 候选查询只作用于本弹窗的有界列表，不进入 IC-13 草稿；Worker 手填时同时充当 native ID。 */
  readonly query: string;
  readonly admissionReason: string | null;
  readonly notice: string | null;
  readonly onAction: (action: number) => void;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly identity?: string;
  /** Worker 原生目录查询结果；Coordinator 或未发起查询时为 `null`。 */
  readonly workerCatalog?: ModelWorkerCatalogState | null;
};

/**
 * Worker 菜单里的选择是目录候选还是手填未验证的 native exact ID。
 *
 * 查询文本非空且没有任何目录候选匹配时判为手填：目录失败或候选不在目录里时仍可保存 exact ID，但
 * 不带 catalogSource、不提供 effort。判定只依赖本次渲染看到的目录与查询，不发明来源。
 */
export function workerManualSelection(role: ModelRoleView, query: string): boolean {
  if (role.role === 'coordinator') {
    return false;
  }
  const manual = query.trim().toLocaleLowerCase();
  if (manual === '') {
    return false;
  }
  return dedupeRoleCandidates(role.candidates).every(
    (candidate) =>
      !(candidate.provider + ' ' + candidate.model + ' ' + candidate.candidateRef)
        .toLocaleLowerCase()
        .includes(manual),
  );
}

/**
 * 候选菜单：搜索 + provider/model 列表 + 独立水平 effort + 默认返回动作。
 *
 * Worker 角色额外先选 harness，候选来自该 harness 的原生目录（由容器显式查询后回传），并可手填未验证
 * exact ID。组件是纯渲染：区域切换、候选移动与动作确认都由容器计算后回传 menu，因此 render 不可能
 * 提交或改变任何绑定。
 */
export function RoleModelMenu(props: RoleModelMenuProps) {
  const rows = props.rows ?? 16;
  const inner = Math.max(1, props.availableWidth - 8);
  const menu = props.menu;
  const worker = props.role.role !== 'coordinator';
  const selected = selectedRoleCandidate(props.role, menu.selectedCandidateRef);
  const capability = selected?.effortCapability ?? null;
  const efforts = capability?.values ?? [];
  const effort = efforts.includes(menu.effort ?? '') ? menu.effort : null;
  const query = props.query.toLocaleLowerCase();
  const filtered = dedupeRoleCandidates(props.role.candidates).filter((candidate) =>
    (candidate.provider + ' ' + candidate.model + ' ' + candidate.candidateRef).toLocaleLowerCase().includes(query),
  );
  const index = filtered.findIndex((candidate) => candidate.candidateRef === menu.selectedCandidateRef);
  const scope = MODEL_ROLE_GROUP_LABELS[props.role.group] + ' / ' + props.role.label;
  const heading = '── ' + scope + ' ';
  const window = effortWindow(efforts, effort, inner, capability !== null);
  const effortSource =
    !window.sourceVisible || capability === null
      ? ''
      : ' · 来源 ' + truncateToDisplayWidth(capability.source, window.sourceWidth);
  const effortChosen = efforts.length === 0 || effort !== null;
  const manual = worker && workerManualSelection(props.role, props.query);
  const manualModel = props.query.trim();
  const harness = menu.harness ?? null;
  const catalogLoad =
    props.workerCatalog !== null && props.workerCatalog !== undefined &&
    props.workerCatalog.role === props.role.role && props.workerCatalog.harness === harness
      ? props.workerCatalog.load
      : null;
  const applicable =
    props.admissionReason === null &&
    (manual ? manualModel !== '' : selected !== null && effortChosen);
  const reason =
    props.admissionReason ??
    (manual
      ? null
      : selected !== null
        ? effortChosen
          ? null
          : '请选择该模型支持的 effort'
        : worker && props.query.trim() === ''
          ? '请选择目录候选或手填 native ID'
          : '没有匹配项');
  const catalogNotice = !worker
    ? null
    : catalogLoad === null
      ? '目录查询中…'
      : catalogLoad.kind === 'unavailable'
        ? '目录不可用：' + catalogLoad.code + '（可手填 native ID，未验证）'
        : '目录来源 ' + catalogLoad.source;
  // 字段区紧跟标题；窄屏时 fieldRows 退化为单列，因此行数由实际排版决定而不是写死。
  const fieldLines = worker
    ? fieldRows(
        [
          { label: 'Model', value: manual ? (manualModel === '' ? '（待手填）' : manualModel) : selected?.model ?? '—' },
          { label: '生效对象', value: truncateToDisplayWidth(scope, inner >= 64 ? Math.floor((inner - 2) / 2) - displayWidth('生效对象 ') : inner - displayWidth('生效对象 ')) },
        ],
        inner,
      )
    : selected === null
      ? []
      : fieldRows(
          [
            { label: 'Provider', value: selected.provider === '' ? '—' : selected.provider },
            { label: 'Model', value: selected.model },
            { label: '生效对象', value: scope },
          ],
          inner,
        );
  /**
   * 候选列表的行预算。
   *
   * 固定外框占 6 行（上下边框、标题、摘要、分隔、footer），搜索/标题/effort/分隔/区域/动作占 6 行，
   * 再加上实际排出的字段行与可选的通知、拒绝原因行。剩下的全部给候选列表，因此子元素永远不会把
   * 标题挤出固定框：80×24 得 3 行，50×40 得 18 行。
   */
  const visible = Math.max(
    1,
    rows - 12 - (worker ? 1 : 0) - fieldLines.length - (reason === null ? 0 : 1) - (props.notice === null ? 0 : 1),
  );
  const start = Math.max(
    0,
    Math.min(Math.max(0, filtered.length - visible), Math.max(0, index) - Math.floor(visible / 2)),
  );
  const area =
    menu.focus === 'harness'
      ? '当前区域：Harness · ' + (harness ?? 'codex')
      : menu.focus === 'list'
      ? '当前区域：模型列表 · effort ' + (effort ?? '不适用')
      : menu.focus === 'effort'
        ? '当前区域：Effort · ' + (effort ?? '不适用')
        : '当前区域：操作按钮 · ' + (menu.action === 0 ? '返回' : '应用选择');
  return (
    <DialogFrame
      title="选择模型"
      summary={props.identity ?? scope}
      width={props.availableWidth}
      rows={rows}
      footer="Tab 区域 · ↑↓模型 · ←→选项 · Enter"
    >
      {!worker ? null : (
        <Text color={menu.focus === 'harness' ? tuiColors.focus : tuiColors.muted}>
          {truncateToDisplayWidth('Harness › ' + (harness ?? 'codex') + '  ←→ 切换 · ' + (manual ? '未验证手填' : catalogNotice ?? ''), inner)}
        </Text>
      )}
      <Text {...(menu.focus === 'list' ? { color: tuiColors.focus } : {})}>
        {truncateToDisplayWidth(
          (worker ? '搜索 / 手填 ID › ' : '搜索 › ') + (props.query || '输入名称或 ID'),
          inner,
        )}
      </Text>
      <Box height={visible} flexDirection="column" overflow="hidden">
        {filtered.slice(start, start + visible).map((candidate) => {
          const hint = props.role.current?.candidateRef === candidate.candidateRef ? '当前' : '可选';
          const hintWidth = Math.min(Math.floor(inner * 0.4), displayWidth(hint));
          const marker = candidate.candidateRef === menu.selectedCandidateRef ? '› ' : '  ';
          const line = truncateToDisplayWidth(
            marker + candidateLabel(candidate),
            Math.max(1, inner - hintWidth - 2),
          );
          return (
            <Text
              key={candidate.candidateRef}
              inverse={candidate.candidateRef === menu.selectedCandidateRef}
              dimColor={props.admissionReason !== null}
            >
              {padToDisplayWidth(line, Math.max(1, inner - hintWidth)) +
                truncateToDisplayWidth(hint, hintWidth)}
            </Text>
          );
        })}
        {filtered.length === 0 ? (
          <Text dimColor>{manual ? '未验证手填：' + manualModel : '没有匹配项'}</Text>
        ) : null}
      </Box>
      <Text color={tuiColors.accent} bold>
        {truncateToDisplayWidth(heading + '─'.repeat(Math.max(0, inner - displayWidth(heading))), inner)}
      </Text>
      {fieldLines.map((line, position) => <Text key={position}>{truncateToDisplayWidth(line, inner)}</Text>)}
      <Text>
        <Text color={menu.focus === 'effort' ? tuiColors.focus : tuiColors.muted}>Effort </Text>
        {efforts.length === 0 ? <Text dimColor>不适用</Text> : (
          window.values.map((value) => (
            <Text key={value} inverse={value === effort} bold={value === effort}>
              {' [' + truncateToDisplayWidth(value, window.labelWidth) + '] '}
            </Text>
          ))
        )}
        {effortSource === '' ? null : <Text dimColor>{effortSource}</Text>}
      </Text>
      <Text color={tuiColors.border}>{'─'.repeat(inner)}</Text>
      {/* 区域行是常驻的导航提示，任何通知都不得取代它；通知另起一行。 */}
      <Text color={tuiColors.warning}>{truncateToDisplayWidth(area, inner)}</Text>
      {props.notice === null ? null : <Text color={tuiColors.warning}>{truncateToDisplayWidth(props.notice, inner)}</Text>}
      <ActionRow index={menu.action} allowed={applicable} label="应用选择" />
      {reason === null ? null : <Text dimColor>{truncateToDisplayWidth(reason, inner)}</Text>}
    </DialogFrame>
  );
}
