/**
 * Model Picker：Coordinator Model Configuration 的切换入口。
 *
 * 准入判定由宿主给出（`switchable` 来自 `assertSwitchable`：是否挂起 + 在途模型操作数）。界面只显示
 * 该判决并禁用不可提交的选择；Controller 的权威拒绝也原样显示。没有任何自动 fallback：切换失败保持
 * 原配置。
 */

import { Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { ModelCatalog } from '../ports.js';
import { DialogFrame, SelectionList } from './selection-list.js';

export type ModelPickerProps = {
  readonly catalog: ModelCatalog;
  /** Controller 上一次拒绝的原因；`null` 表示没有被拒绝过。 */
  readonly rejection: string | null;
  readonly onSelect: (configurationRef: string) => void;
  readonly availableWidth: number;
  readonly rows?: number;
};

/** 只有宿主判定可切换、且存在候选配置时才允许提交。 */
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

export function ModelPicker(props: ModelPickerProps) {
  const admission=modelSwitchAdmission(props.catalog),rows=props.rows??16;
  return <DialogFrame title="Model Picker" summary={`Coordinator · 配置 ${props.catalog.currentConfigurationRef??'不可用'}`} width={props.availableWidth} rows={rows} footer="↑↓ 选择 · Enter 提交 · Esc 返回">
    <Text dimColor>Coordinator 模型 · provider/effort/其他角色未接通</Text>
    <SelectionList options={props.catalog.options.map(option=>({
      label:truncateToDisplayWidth(`${option.model} · ${option.configurationRef}${option.configurationRef===props.catalog.currentConfigurationRef?' · 当前':''}`,Math.max(1,props.availableWidth-10)),
      value:option.configurationRef,
    }))} {...(props.catalog.currentConfigurationRef===null?{}:{defaultValue:props.catalog.currentConfigurationRef})} visibleOptionCount={Math.max(1,rows-10)} isDisabled={!admission.allowed} onSelect={props.onSelect}/>
    {admission.allowed?null:<Text>{`! ${admission.reason}`}</Text>}
    {props.rejection===null?null:<Text>{truncateToDisplayWidth(`! ${props.rejection}`,props.availableWidth-8)}</Text>}
  </DialogFrame>;
}
