/**
 * 执行并发设置弹窗（IP-04）。
 *
 * 纯展示：草稿、批准额度、提示与保存在途都由容器持有，组件不读端口、不写状态、不自行授权。它只把
 * 「默认 vs 当前批准」两个事实摆在用户面前，并强调保存不等于让批准额度生效。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import { tuiColors } from '../theme.js';
import { DialogFrame } from './selection-list.js';

export type ExecutionSettingsProps = {
  /** 正在编辑的默认额度草稿；字符串保留非法/空输入，保存失败时可原样重试。 */
  readonly draft: string;
  /** 项目配置里已经保存的默认额度。 */
  readonly savedDefault: number;
  /** 当前批准额度；未批准执行时为 `null`。 */
  readonly approved: number | null;
  readonly notice: string | null;
  readonly saving: boolean;
  /** 本次编辑已保存；此后可按 R 进入完整 Manifest 审阅。 */
  readonly saved?: boolean;
  readonly width: number;
  readonly rows?: number;
  readonly identity?: string;
};

export function executionSettingsDraftValid(draft: string): boolean {
  const trimmed = draft.trim();
  return /^[0-9]+$/u.test(trimmed) && Number.isSafeInteger(Number(trimmed)) && Number(trimmed) > 0;
}

export function ExecutionSettings(props: ExecutionSettingsProps) {
  const frameRows = Math.max(12, (props.rows ?? 24) - 4);
  const inner = Math.max(1, props.width - 8);
  const fit = (text: string) => truncateToDisplayWidth(text, inner);
  const valid = executionSettingsDraftValid(props.draft);
  return (
    <DialogFrame
      title="执行并发设置"
      summary={props.identity ?? 'Scope · 执行设置'}
      width={props.width}
      rows={frameRows}
      footer={props.saving ? '保存中…' : props.saved === true ? '已保存 · R 重新审阅执行额度 · Esc 返回' : '数字输入 · Enter 保存 · Esc 取消'}
    >
      <Box flexDirection="column">
        <Text color={tuiColors.accent}>{fit(`默认并行额度  ${props.draft.length === 0 ? '（请输入正安全整数）' : props.draft}`)}</Text>
        <Text color={tuiColors.muted}>{fit(`已保存默认值  ${String(props.savedDefault)}`)}</Text>
        <Text color={tuiColors.focus}>{fit(`当前批准额度  ${props.approved === null ? '未批准执行' : String(props.approved)}`)}</Text>
        <Text dimColor>{fit('保存只改默认值；重新批准后应用到当前执行。')}</Text>
        <Text color={valid ? tuiColors.success : tuiColors.error}>
          {fit(valid ? '输入有效' : '必须是正安全整数（不接受 0、负数、小数与溢出值）')}
        </Text>
        {props.notice === null ? null : (
          <Text color={props.notice.startsWith('!') ? tuiColors.error : tuiColors.success}>{fit(props.notice)}</Text>
        )}
      </Box>
    </DialogFrame>
  );
}
