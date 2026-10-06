/**
 * Coordinator 角色连接编辑（沿用定稿 #48 custom/direct 的字段行与保存约定）。
 *
 * Worker 角色不再有连接、凭据、API key 或任意 options 编辑：它们的 harness/model/effort 由
 * `model-picker` 的原生目录菜单负责。这里的字段只覆盖 Coordinator 的 provider 连接：provider 集成、
 * 凭据来源与 SDK 字段路径，以及 effort 的可信能力来源。
 *
 * effort 能力不是界面发明的——用户显式给出 values/source/optionPath，缺任一项就按「无可信来源」
 * 保存，因此无法虚构 effort。
 *
 * 编辑内容只存在于进程内内存：它不是 IC-13 的 UiDraft，不进草稿存储、提交记录或 checkpoint，
 * 因此输入的 key 不会随输入恢复、resize 或重挂载落盘。渲染永远只显示遮罩，错误与日志也只带
 * 结构化 code 和安全文案。
 *
 * 保存只追加不可变引用并 CAS 写入项目配置，不代表应用：Coordinator 仍要走既有切换意图。
 */

import { Box, Text, type Key } from 'ink';

import { DialogFrame } from './selection-list.js';
import { tuiColors } from '../theme.js';
import { padToDisplayWidth, truncateToDisplayWidth } from '../render/width.js';
import { MODEL_SETTINGS_FIELDS, type ModelSettingsEdit, type ModelSettingsField } from '../state.js';
import type { SaveModelSettingsInput } from '../../../application/configuration/model-settings.js';
import { editComposer, textDraft } from '../input/composer-editor.js';

const FIELD_LABELS: Readonly<Record<ModelSettingsField, string>> = {
  label: '连接名称',
  providerIntegration: 'Provider 集成',
  model: 'Model',
  options: '非秘密选项',
  credentialKind: '凭据来源',
  credentialOptionPath: '凭据 optionPath',
  effortSource: 'effort 来源',
  effortValues: 'effort 取值',
  effortOptionPath: 'effort optionPath',
  secret: 'API Key',
};

const LABEL_WIDTH = 18;
const OPTION_SEPARATOR = String.fromCharCode(10);
const CREDENTIAL_KINDS = ['harness_login', 'managed'] as const;

/**
 * 当前凭据来源下可见的字段。
 *
 * 导航与渲染共用这一份。`harness_login` 由 Coordinator 的 provider integration 自身提供环境认证，
 * 没有可输入的 key，因此 API Key 字段不出现——出现一个永远不会被使用的输入框，就是邀请用户填一个
 * 必然被丢弃的秘密。
 */
export function visibleModelSettingsFields(
  credentialKind: ModelSettingsEdit['credentialKind'],
): readonly ModelSettingsField[] {
  return MODEL_SETTINGS_FIELDS.filter((field) => field !== 'secret' || credentialKind !== 'harness_login');
}

/** 遮罩常量：任何 key 都不进入渲染文本，也不随实际长度变化。 */
export const SECRET_MASK = '••••••••';

/** 已填写新 key 时显示遮罩；留空表示沿用配置中已有的凭据。 */
export function maskedSecret(secret: string): string {
  return secret === '' ? '未设置 · 留空沿用已有凭据' : SECRET_MASK;
}

/**
 * 解析非秘密选项。
 *
 * 每行一条 key = value，value 必须是合法 JSON。空行与井号注释行忽略；**任何无法解析的行都会被
 * 结构化拒绝并保留编辑**，不做静默丢弃——否则用户会以为选项已保存，实际上少了一条。
 */
export type ParsedModelOptions =
  | { readonly kind: 'ok'; readonly options: Record<string, unknown> }
  | { readonly kind: 'invalid'; readonly line: number; readonly message: string };

export function parseModelOptions(text: string): ParsedModelOptions {
  const options: Record<string, unknown> = {};
  const lines = text.split(OPTION_SEPARATOR);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      return { kind: 'invalid', line: index + 1, message: '第 ' + String(index + 1) + ' 行不是 key = value' };
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === '') {
      return { kind: 'invalid', line: index + 1, message: '第 ' + String(index + 1) + ' 行缺少 key' };
    }
    try {
      options[key] = JSON.parse(value) as unknown;
    } catch {
      return {
        kind: 'invalid',
        line: index + 1,
        message: '第 ' + String(index + 1) + ' 行的值不是合法 JSON；字符串请写成 "文本"',
      };
    }
  }
  return { kind: 'ok', options };
}

/**
 * 把选项区还原成可编辑文本。
 *
 * 所有值都用 JSON.stringify 表示，因此字符串往返后仍是字符串，不会被读成数字或布尔。
 */
export function formatModelOptions(options: Readonly<Record<string, unknown>>): string {
  return Object.keys(options)
    .sort()
    .map((key) => {
      const value = options[key];
      const rendered = JSON.stringify(value) ?? 'null';
      return key + ' = ' + rendered;
    })
    .join(OPTION_SEPARATOR);
}

export type ModelSettingsDraft =
  | { readonly kind: 'ok'; readonly input: SaveModelSettingsInput }
  | { readonly kind: 'invalid'; readonly field: ModelSettingsField; readonly message: string };

/**
 * 校验内存编辑并组装 Coordinator 的保存输入。
 *
 * effort 能力必须三项齐全才算可信来源：只填部分字段会得到明确的字段级提示，而不是让服务去猜。
 * 新 key 只在这条内存路径上短暂存在，由宿主先写 CredentialStore 并回读，再写项目引用。Worker 的
 * harness 与模型选择不在这里组装——它由原生目录菜单提交 `modelSelection`。
 */
export function modelSettingsDraft(edit: ModelSettingsEdit, expectedRevision: number): ModelSettingsDraft {
  if (edit.providerIntegration.trim() === '') {
    return { kind: 'invalid', field: 'providerIntegration', message: 'Provider 集成不能为空' };
  }
  if (edit.model.trim() === '') {
    return { kind: 'invalid', field: 'model', message: 'Model 不能为空' };
  }
  const capability = [edit.effortSource, edit.effortValues, edit.effortOptionPath];
  const filled = capability.map((value) => value.trim() !== '');
  if (filled.some(Boolean) && !filled.every(Boolean)) {
    return { kind: 'invalid', field: 'effortSource', message: 'effort 能力必须同时给出来源、取值与 optionPath' };
  }
  const effortValues = edit.effortValues
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (filled.every(Boolean) && (effortValues.length === 0 || new Set(effortValues).size !== effortValues.length)) {
    return { kind: 'invalid', field: 'effortValues', message: 'effort 取值需要非空且不重复' };
  }
  if (edit.credentialKind === 'managed' && edit.secret === '' && edit.credentialRef === '') {
    return { kind: 'invalid', field: 'credentialOptionPath', message: 'managed 凭据需要已有引用或本次提供新 key' };
  }
  if (edit.credentialKind === 'managed' && edit.credentialOptionPath.trim() === '') {
    return { kind: 'invalid', field: 'credentialOptionPath', message: 'managed 凭据需要指明注入的 SDK 字段路径' };
  }
  const parsed = parseModelOptions(edit.options);
  if (parsed.kind !== 'ok') {
    return { kind: 'invalid', field: 'options', message: parsed.message };
  }
  return {
    kind: 'ok',
    input: {
      role: 'coordinator',
      expectedRevision,
      // 服务层每次保存都**新增**连接与模型，因此这里不存在需要合并的既有值：连接记录与模型配置
      // 各写同一份用户编辑的选项，载入时也以完整 binding 的连接选项回填，避免任一侧静默丢失。
      modelOptions: parsed.options,
      connection: {
        label: edit.label.trim(),
        providerIntegration: edit.providerIntegration.trim(),
        modelOptions: parsed.options,
        credential:
          edit.credentialKind === 'harness_login'
            ? { kind: 'harness_login' }
            : {
                kind: 'managed',
                credentialRef: edit.credentialRef === '' ? null : edit.credentialRef,
                optionPath: edit.credentialOptionPath.trim(),
              },
      },
      model: edit.model.trim(),
      effortCapability:
        filled.every(Boolean) && effortValues.length > 0
          ? { values: effortValues, source: edit.effortSource.trim(), optionPath: edit.effortOptionPath.trim() }
          : null,
      ...(edit.secret === '' ? {} : { newSecret: edit.secret }),
    },
  };
}

/**
 * 在内存字段上应用一次按键。
 *
 * 复用 composer 的编辑原语（grapheme 边界、行首尾、粘贴折叠），但结果只写回 ModelSettingsEdit：
 * 这里不产生、也不读取任何 UiDraft，因此 key 不会进入 IC-13。
 */
export function editModelSettingsField(
  edit: ModelSettingsEdit,
  field: ModelSettingsField,
  input: string,
  key: Key,
): ModelSettingsEdit {
  // 选项区是唯一的多行字段：Shift/Alt+Enter 插入换行，Enter 仍然直接保存（沿用 composer 的约定）。
  if (field === 'options' && key.return && (key.shift || key.meta)) {
    return { ...edit, options: edit.options + OPTION_SEPARATOR };
  }
  // 凭据来源用左右键循环，方向键不会插入字符。
  if (field === 'credentialKind') {
    if (!key.leftArrow && !key.rightArrow) {
      return edit;
    }
    const current = edit.credentialKind;
    const index = CREDENTIAL_KINDS.indexOf(current);
    const next = CREDENTIAL_KINDS[
      (((index + (key.leftArrow ? CREDENTIAL_KINDS.length - 1 : 1)) % CREDENTIAL_KINDS.length) + CREDENTIAL_KINDS.length) % CREDENTIAL_KINDS.length
    ];
    if (next === undefined || next === current) {
      return edit;
    }
    // 切回 harness_login 时本次输入的 key 没有去处：立刻从内存清掉，而不是留着并在保存时
    // 变成一条被成功丢弃的孤立凭据。调用方负责把这次清空显示给用户。
    return next === 'harness_login' ? { ...edit, credentialKind: next, secret: '' } : { ...edit, credentialKind: next };
  }
  const current = edit[field];
  const next = editComposer(textDraft(current), input, key).text;
  if (next === current) {
    return edit;
  }
  // 选项区用真实换行保存，其余字段单行，避免换行把一行拆成两个字段。
  return {
    ...edit,
    [field]: field === 'options' ? next.replace(/\r\n/gu, OPTION_SEPARATOR) : next.replace(/[\r\n]/gu, ' '),
  };
}

/** 字段视窗起点：始终让当前字段可见，并在有富余时把光标放在中间。 */
export function fieldWindowStart(field: number, total: number, visible: number): number {
  const budget = Math.max(1, Math.min(visible, total));
  return Math.max(0, Math.min(Math.max(0, total - budget), field - Math.floor(budget / 2)));
}

export type ModelSettingsEditorProps = {
  readonly edit: ModelSettingsEdit;
  readonly field: ModelSettingsField;
  /** 上一次保存或校验的结构化结果；失败时保留全部输入。 */
  readonly notice: string | null;
  readonly failing: boolean;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly identity?: string;
};

/** Coordinator 连接编辑：同一弹窗框内的独立内存字段，key 只显示遮罩。 */
export function ModelSettingsEditor(props: ModelSettingsEditorProps) {
  const rows = props.rows ?? 16;
  const inner = Math.max(1, props.availableWidth - 8);
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(8, Math.floor(inner / 3)));
  const listBudget = Math.max(1, rows - 12);
  const fields = visibleModelSettingsFields(props.edit.credentialKind);
  const cursor = Math.max(0, fields.indexOf(props.field));
  const start = fieldWindowStart(cursor, fields.length, listBudget);
  const values: Readonly<Record<ModelSettingsField, string>> = {
    ...(Object.fromEntries(MODEL_SETTINGS_FIELDS.map((field) => [field, ''])) as Record<ModelSettingsField, string>),
    label: props.edit.label === '' ? '—' : props.edit.label,
    providerIntegration: props.edit.providerIntegration,
    model: props.edit.model,
    options: props.edit.options === '' ? '—' : props.edit.options,
    credentialKind: props.edit.credentialKind,
    credentialOptionPath: props.edit.credentialOptionPath === '' ? '—' : props.edit.credentialOptionPath,
    effortSource: props.edit.effortSource === '' ? '（无可信来源）' : props.edit.effortSource,
    effortValues: props.edit.effortValues === '' ? '—' : props.edit.effortValues,
    effortOptionPath: props.edit.effortOptionPath === '' ? '—' : props.edit.effortOptionPath,
    secret: maskedSecret(props.edit.secret),
  };
  return (
    <DialogFrame
      title="模型连接设置"
      summary={props.identity ?? '修改后需显式保存；保存不会自动应用'}
      width={props.availableWidth}
      rows={rows}
      footer="↑↓ 字段 · ←→ 凭据来源 · Enter 保存 · Esc 取消"
    >
      <Text dimColor>{truncateToDisplayWidth('目标角色：当前 Coordinator', inner)}</Text>
      <Box height={listBudget} flexDirection="column" overflow="hidden">
        {fields.slice(start, start + listBudget).map((field, offset) => {
          const active = start + offset === cursor;
          const head = (active ? '› ' : '  ') + padToDisplayWidth(FIELD_LABELS[field], labelWidth) + '  ';
          return (
            <Text
              key={field}
              inverse={active}
              bold={active}
              {...(field === 'secret' ? { color: tuiColors.warning } : {})}
            >
              {truncateToDisplayWidth(
                head + values[field].split(OPTION_SEPARATOR).join(' / '),
                inner,
              )}
            </Text>
          );
        })}
      </Box>
      {props.edit.credentialKind === 'managed' ? (
        <Text dimColor>{truncateToDisplayWidth('API Key 已隐藏 · 留空沿用已有凭据', inner)}</Text>
      ) : (
        <Text dimColor>{truncateToDisplayWidth('Provider 自身提供环境认证，无需填写 API Key', inner)}</Text>
      )}
      <Text {...(props.failing ? { color: tuiColors.warning } : { color: tuiColors.muted })}>
        {truncateToDisplayWidth(
          props.notice ??
            (props.failing
              ? '保存失败，原设置保留；可重试或取消'
              : '保存不会改变正在运行的会话或已批准的授权'),
          inner,
        )}
      </Text>
      <Text dimColor>
        {truncateToDisplayWidth(
          String(cursor + 1) +
            '/' +
            String(fields.length) +
            ' · 选项每行 key = value（Shift+Enter 换行）· effort 取值用逗号分隔',
          inner,
        )}
      </Text>
    </DialogFrame>
  );
}
