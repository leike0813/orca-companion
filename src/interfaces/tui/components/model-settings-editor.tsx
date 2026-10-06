/**
 * 角色连接编辑（IP-06，沿用定稿 #48 custom/direct 的字段行与保存约定）。
 *
 * 字段覆盖完整的 provider 连接：codex 连接、凭据来源与 SDK 字段路径，以及 effort 的可信能力来源。
 * effort 能力不是界面发明的——用户显式给出 values/source/optionPath，缺任一项就按「无可信来源」
 * 保存，因此无法虚构 effort。
 *
 * 编辑内容只存在于进程内内存：它不是 IC-13 的 UiDraft，不进草稿存储、提交记录或 checkpoint，
 * 因此输入的 key 不会随输入恢复、resize 或重挂载落盘。渲染永远只显示遮罩，错误与日志也只带
 * 结构化 code 和安全文案。
 *
 * 保存只追加不可变引用并 CAS 写入项目配置，不代表应用：Coordinator 仍要走既有切换意图，Worker
 * 角色仍要经过完整 Manifest 审阅与显式批准。
 */

import { Box, Text, type Key } from 'ink';

import { DialogFrame } from './selection-list.js';
import { tuiColors } from '../theme.js';
import { padToDisplayWidth, truncateToDisplayWidth } from '../render/width.js';
import { MODEL_SETTINGS_FIELDS, type ModelSettingsEdit, type ModelSettingsField } from '../state.js';
import type { SaveModelSettingsInput } from '../../../application/configuration/model-settings.js';
import {
  NATIVE_WORKER_APIS,
  WORKER_HARNESS_IDS,
  type NativeWorkerApi,
  type NativeWorkerConnection,
} from '../../../domain/model-configuration.js';
import { editComposer, textDraft } from '../input/composer-editor.js';

const FIELD_LABELS: Readonly<Record<ModelSettingsField, string>> = {
  label: '连接名称',
  providerIntegration: 'Provider 集成',
  model: 'Model',
  options: '非秘密选项',
  harness: 'Harness',
  codexProviderId: 'Codex providerId',
  codexBaseUrl: 'Codex baseUrl',
  codexWireApi: 'Codex wireApi',
  nativeProviderId: 'native providerId',
  nativeBaseUrl: 'native baseUrl',
  nativeApi: 'native api',
  credentialKind: '凭据来源',
  credentialOptionPath: '凭据 optionPath',
  effortSource: 'effort 来源',
  effortValues: 'effort 取值',
  effortOptionPath: 'effort optionPath',
  secret: 'API Key',
};

const LABEL_WIDTH = 18;
const OPTION_SEPARATOR = String.fromCharCode(10);
const WIRE_APIS = ['', 'responses', 'chat'] as const;

/**
 * 当前角色与凭据来源下可见的字段。
 *
 * 导航与渲染共用这一份。`harness_login` 由 Harness 自己提供认证，没有可输入的 key，因此 API Key 字段
 * 不出现——出现一个永远不会被使用的输入框，就是邀请用户填一个必然被丢弃的秘密。Coordinator 始终用
 * LangChain，因此不出现 harness 与原生连接字段；Worker 选 codex 之外的 harness 时反过来隐藏 codex 字段。
 * `edit` 缺省按 codex 处理，旧调用方与原夹具的可见字段因此不变。
 */
export function visibleModelSettingsFields(
  credentialKind: ModelSettingsEdit['credentialKind'],
  edit?: Pick<ModelSettingsEdit, 'role' | 'harness'>,
): readonly ModelSettingsField[] {
  const worker = edit !== undefined && edit.role !== 'coordinator';
  const harness = edit?.harness ?? '';
  const native = worker && harness !== '' && harness !== 'codex';
  return MODEL_SETTINGS_FIELDS.filter((field) => {
    switch (field) {
      case 'secret':
        return credentialKind !== 'harness_login';
      case 'harness':
        return worker;
      case 'nativeProviderId':
      case 'nativeBaseUrl':
      case 'nativeApi':
        return native;
      case 'codexProviderId':
      case 'codexBaseUrl':
      case 'codexWireApi':
        return !native;
      default:
        return true;
    }
  });
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
 * 把已校验的原生字段组装成判别联合的对应分支。
 *
 * harness 与 api 都已在草稿校验里收窄，因此这里的 `api` 断言只表达「取值集合已确认」，不绕过校验。
 */
function nativeWorkerCandidate(
  harness: string,
  providerId: string,
  baseUrl: string,
  api: string,
): NativeWorkerConnection {
  const address = baseUrl === '' ? {} : { baseUrl };
  const interfaceFamily = api === '' ? {} : { api: api as NativeWorkerApi };
  switch (harness) {
    case 'claude':
      return { harness: 'claude', providerId, ...address, ...(api === '' ? {} : { api: 'anthropic-messages' as const }) };
    case 'opencode':
      return { harness: 'opencode', providerId, ...address, ...interfaceFamily };
    case 'pi':
      return { harness: 'pi', providerId, ...address, ...interfaceFamily };
    case 'omp':
      return { harness: 'omp', providerId, ...address, ...interfaceFamily };
    default:
      throw new Error(`unsupported_worker_harness: ${harness}`);
  }
}

/**
 * 校验内存编辑并组装应用层的保存输入。
 *
 * effort 能力必须三项齐全才算可信来源：只填部分字段会得到明确的字段级提示，而不是让服务去猜。
 * 新 key 只在这条内存路径上短暂存在，由宿主先写 CredentialStore 并回读，再写项目引用。
 */
export function modelSettingsDraft(edit: ModelSettingsEdit, expectedRevision: number): ModelSettingsDraft {
  // 规划 Utility 与 Specification Validator 没有生产生命周期，应用层也没有对应角色。
  if (edit.role === 'planning_utility' || edit.role === 'specification_validator') {
    return { kind: 'invalid', field: 'label', message: '该角色没有生产生命周期，不能保存配置' };
  }
  if (edit.providerIntegration.trim() === '') {
    return { kind: 'invalid', field: 'providerIntegration', message: 'Provider 集成不能为空' };
  }
  if (edit.model.trim() === '') {
    return { kind: 'invalid', field: 'model', message: 'Model 不能为空' };
  }

  // Worker 角色显式选择 codex 之外的 harness 时改走原生连接；Coordinator 始终是 codex/LangChain，
  // 缺省 harness 也按 codex 处理，旧编辑因此保持原行为。
  const harness = (edit.harness ?? '').trim();
  const native = edit.role !== 'coordinator' && harness !== '' && harness !== 'codex';
  if (native && !(WORKER_HARNESS_IDS as readonly string[]).includes(harness)) {
    return { kind: 'invalid', field: 'harness', message: `不支持的 Worker harness：${harness}` };
  }

  // codex 连接只在 codex（或按 codex 处理）时组装；原生 harness 不接受 codex 连接。
  const wireApi = native ? '' : edit.codexWireApi;
  const codexId = edit.codexProviderId.trim();
  const codexBaseUrl = edit.codexBaseUrl.trim();
  if (!native) {
    if (wireApi !== '' && (codexId === '' || codexBaseUrl === '')) {
      return { kind: 'invalid', field: 'codexProviderId', message: '配置 wireApi 时必须同时给出 providerId 与 baseUrl' };
    }
    if (wireApi === '' && (codexId !== '' || codexBaseUrl !== '')) {
      return { kind: 'invalid', field: 'codexWireApi', message: '给出 Codex 连接时必须选择 wireApi' };
    }
  }

  // 原生连接：providerId 必须显式；managed 凭据还必须给出 baseUrl 与 api。harness_login 沿用 harness
  // 自己配置的 provider，可以缺省 baseUrl 与 api。
  const nativeProviderId = (edit.nativeProviderId ?? '').trim();
  const nativeBaseUrl = (edit.nativeBaseUrl ?? '').trim();
  const nativeApi = (edit.nativeApi ?? '').trim();
  if (native) {
    if (nativeProviderId === '') {
      return { kind: 'invalid', field: 'nativeProviderId', message: 'Worker 原生连接需要 providerId' };
    }
    if (nativeApi !== '' && !(NATIVE_WORKER_APIS as readonly string[]).includes(nativeApi)) {
      return { kind: 'invalid', field: 'nativeApi', message: `不支持的接口族：${nativeApi}` };
    }
    if (harness === 'claude' && nativeApi !== '' && nativeApi !== 'anthropic-messages') {
      return { kind: 'invalid', field: 'nativeApi', message: 'claude harness 只支持 anthropic-messages' };
    }
    if (edit.credentialKind === 'managed' && (nativeBaseUrl === '' || nativeApi === '')) {
      return { kind: 'invalid', field: 'nativeBaseUrl', message: 'managed 原生连接需要 baseUrl 与 api' };
    }
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
      expectedRevision,
      role: edit.role,
      // Worker 角色只有显式选了 harness 才带上它：缺省时把「沿用现有 profile」的决定留给服务层。
      ...(edit.role !== 'coordinator' && harness !== '' ? { harness } : {}),
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
        codex:
          wireApi === ''
            ? null
            : { providerId: codexId, baseUrl: codexBaseUrl, wireApi },
        ...(native ? { nativeWorker: nativeWorkerCandidate(harness, nativeProviderId, nativeBaseUrl, nativeApi) } : {}),
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
  // 枚举字段用左右键循环，方向键不会插入字符。
  if (field === 'codexWireApi' || field === 'credentialKind' || field === 'harness' || field === 'nativeApi') {
    if (!key.leftArrow && !key.rightArrow) {
      return edit;
    }
    const options: readonly string[] =
      field === 'codexWireApi' ? WIRE_APIS
        : field === 'credentialKind' ? ['harness_login', 'managed']
          : field === 'harness' ? WORKER_HARNESS_IDS
            // claude 只有 anthropic-messages：循环列表不许提供服务端会拒绝的取值。
            : edit.harness === 'claude' ? ['anthropic-messages']
              : NATIVE_WORKER_APIS;
    const current = edit[field] ?? '';
    const index = options.indexOf(current);
    const next = options[(((index + (key.leftArrow ? options.length - 1 : 1)) % options.length) + options.length) % options.length];
    if (next === undefined || next === current) {
      return edit;
    }
    // 切回 harness_login 时本次输入的 key 没有去处：立刻从内存清掉，而不是留着并在保存时
    // 变成一条被成功丢弃的孤立凭据。调用方负责把这次清空显示给用户。
    return field === 'credentialKind' && next === 'harness_login' ? { ...edit, credentialKind: next, secret: '' } : { ...edit, [field]: next };
  }
  const current = edit[field] ?? '';
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

/** 连接编辑：同一弹窗框内的独立内存字段，key 只显示遮罩。 */
export function ModelSettingsEditor(props: ModelSettingsEditorProps) {
  const rows = props.rows ?? 16;
  const inner = Math.max(1, props.availableWidth - 8);
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(8, Math.floor(inner / 3)));
  const listBudget = Math.max(1, rows - 12);
  const fields = visibleModelSettingsFields(props.edit.credentialKind, props.edit);
  const cursor = Math.max(0, fields.indexOf(props.field));
  const start = fieldWindowStart(cursor, fields.length, listBudget);
  const harness = props.edit.harness ?? '';
  const nativeProviderId = props.edit.nativeProviderId ?? '';
  const nativeBaseUrl = props.edit.nativeBaseUrl ?? '';
  const nativeApi = props.edit.nativeApi ?? '';
  const values: Readonly<Record<ModelSettingsField, string>> = {
    ...(Object.fromEntries(MODEL_SETTINGS_FIELDS.map((field) => [field, ''])) as Record<ModelSettingsField, string>),
    label: props.edit.label === '' ? '—' : props.edit.label,
    providerIntegration: props.edit.providerIntegration,
    model: props.edit.model,
    options: props.edit.options === '' ? '—' : props.edit.options,
    harness: harness === '' ? 'codex（默认）' : harness,
    codexProviderId: props.edit.codexProviderId === '' ? '—' : props.edit.codexProviderId,
    codexBaseUrl: props.edit.codexBaseUrl === '' ? '—' : props.edit.codexBaseUrl,
    codexWireApi: props.edit.codexWireApi === '' ? '（不配置）' : props.edit.codexWireApi,
    nativeProviderId: nativeProviderId === '' ? '—' : nativeProviderId,
    nativeBaseUrl: nativeBaseUrl === '' ? '—' : nativeBaseUrl,
    nativeApi: nativeApi === '' ? '（不指定）' : nativeApi,
    credentialKind: props.edit.credentialKind,
    credentialOptionPath: props.edit.credentialOptionPath === '' ? '—' : props.edit.credentialOptionPath,
    effortSource: props.edit.effortSource === '' ? '（无可信来源）' : props.edit.effortSource,
    effortValues: props.edit.effortValues === '' ? '—' : props.edit.effortValues,
    effortOptionPath: props.edit.effortOptionPath === '' ? '—' : props.edit.effortOptionPath,
    secret: maskedSecret(props.edit.secret),
  };
  const role = props.edit.role;
  return (
    <DialogFrame
      title="模型连接设置"
      summary={props.identity ?? '修改后需显式保存；保存不会自动应用'}
      width={props.availableWidth}
      rows={rows}
      footer="↑↓ 字段 · ←→ 枚举 · Enter 保存 · Esc 取消"
    >
      <Text dimColor>
        {truncateToDisplayWidth('目标角色：' + (role === 'coordinator' ? '当前 Coordinator' : role), inner)}
      </Text>
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
        <Text dimColor>{truncateToDisplayWidth('凭据由 Harness 提供，无需填写 API Key', inner)}</Text>
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
