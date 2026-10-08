import { Box, Text } from 'ink';

import { DialogFrame } from './selection-list.js';
import { truncateToDisplayWidth } from '../render/width.js';
import type { ModelSettingsEdit } from '../state.js';

export type ModelSettingsEditorProps = {
  readonly edit: ModelSettingsEdit;
  readonly notice: string | null;
  readonly failing: boolean;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly identity?: string;
};

export const SECRET_MASK = '••••••••';

function windowStart(index: number, total: number, visible: number): number {
  return Math.max(0, Math.min(Math.max(0, total - visible), index - Math.floor(visible / 2)));
}

export function ModelSettingsEditor(props: ModelSettingsEditorProps) {
  const { edit } = props;
  const width = Math.max(1, props.availableWidth - 8);
  const rows = props.rows ?? 16;
  const matchedConnections = edit.connections.filter((item) => (item.label + item.providerId + item.providerIntegration).toLowerCase().includes(edit.query.toLowerCase()));
  const matchedPresets = edit.presets.filter((item) => (item.label + item.id + item.protocol).toLowerCase().includes(edit.query.toLowerCase()));
  const matchedModels = (edit.catalogResult?.models ?? []).filter((item) => (item.label + item.id).toLowerCase().includes(edit.query.toLowerCase()));
  const choices = edit.stage === 'connections'
    ? [...matchedConnections.map((item) => ({ id: item.connectionRef, label: `${item.label} · ${item.providerIntegration}` })), { id: '__edit', label: '编辑所选连接…' }, { id: '__new', label: '＋ 新建连接' }]
    : edit.stage === 'preset'
      ? [...matchedPresets.map((item) => ({ id: item.id, label: item.label })), { id: '__custom', label: '自定义协议' }]
      : edit.stage === 'models'
        ? [...matchedModels.map((item) => ({ id: item.id, label: item.label === item.id ? item.id : `${item.label} · ${item.id}` })), { id: '__manual', label: '手动填写模型编号…' }, { id: '__discover', label: '查询此连接的模型…' }, ...(!edit.projectAvailable ? [{ id: '__initialize', label: '初始化项目配置…' }] : [])]
        : [];
  const listStage = edit.stage === 'connections' || edit.stage === 'preset' || edit.stage === 'models';
  const header = edit.stage === 'connections' ? '已保存 Provider 连接'
    : edit.stage === 'preset' ? '服务 / 地区 / 产品线'
      : edit.stage === 'models' ? '模型候选与手动填写'
        : edit.stage === 'connection' ? '连接信息'
          : '显式初始化项目配置';
  const fields = edit.stage === 'connection'
    ? [['label', '连接名称', edit.label], ['baseUrl', '服务地址', edit.baseUrl], ['secret', 'API Key', edit.secret === '' ? '留空沿用已有凭据' : SECRET_MASK]] as const
    : edit.stage === 'project-init'
      ? [['query', 'Route Map issue number', edit.routeMapIssueNumber]] as const
      : [];
  const listBudget = Math.max(1, rows - (listStage ? 10 : 8));
  const start = windowStart(edit.selectedIndex, choices.length, listBudget);
  const lines = listStage
    ? [header, ...choices.slice(start, start + listBudget).map((choice, offset) => `${edit.selectedIndex === start + offset ? '› ' : '  '}${choice.label}`)]
    : edit.stage === 'connection'
      ? [header, `接入方式  ${protocolLabel(edit.providerIntegration)}`, ...fields.map(([name, label, value]) => `${name === edit.field ? '›' : ' '} ${label}  ${name === 'secret' && value !== '留空沿用已有凭据' ? SECRET_MASK : value || '—'}`)]
      : [header, ...fields.map(([name, label, value]) => `${name === edit.field ? '›' : ' '} ${label}  ${value || '—'}`)];
  if (listStage && edit.stage !== 'connections') lines.splice(1, 0, `搜索  ${edit.query || '输入名称或 ID'}`);
  if (edit.stage === 'connections') lines.splice(1, 0, `搜索  ${edit.query || '输入连接名称'}`);
  const title = edit.stage === 'models' ? 'Coordinator · 选择模型' : edit.stage === 'project-init' ? '初始化项目配置' : 'Coordinator · Provider';
  const footer = edit.stage === 'connections' ? '↑↓ 选择 · Enter 继续 · Esc 返回'
    : edit.stage === 'preset' ? '↑↓ Provider · Enter 选择 · Esc 返回'
      : edit.stage === 'connection' ? '↑↓ 字段 · ←→ 协议 · Enter 保存并发现 · Esc 返回'
        : edit.stage === 'project-init' ? '输入正整数 issue number · Enter 初始化配置 · Esc 返回'
          : '公共目录 Ctrl+R · 连接查询 Enter';
  return (
    <DialogFrame title={title} summary={props.identity ?? '保存配置不会自动应用'} width={props.availableWidth} rows={rows} footer={footer}>
      <Box flexDirection="column" height={Math.max(1, rows - 8)} overflow="hidden">
        {lines.slice(0, Math.max(1, rows - 8)).map((line, index) => (
          <Text key={`${index}:${line}`} inverse={listStage ? index === 2 + edit.selectedIndex - start : line.startsWith('› ')}>
            {truncateToDisplayWidth(line, width)}
          </Text>
        ))}
      </Box>
      <Text dimColor>{truncateToDisplayWidth(props.notice ?? (edit.stage === 'connection' ? 'API Key 始终隐藏；留空沿用已有凭据' : 'Coordinator 连接与模型可跨项目复用'), width)}</Text>
    </DialogFrame>
  );
}

function protocolLabel(protocol: string): string {
  switch (protocol) {
    case 'openai-chat': return 'OpenAI 对话接口';
    case 'openai-responses': return 'OpenAI Responses 接口';
    case 'anthropic-messages': return 'Anthropic Messages 接口';
    case 'google-gemini': return 'Google Gemini 接口';
    default: return '自定义接口';
  }
}
