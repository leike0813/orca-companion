import { defaultTheme, extendTheme } from '@inkjs/ui';

/** 终端标准色；所有状态同时保留文字或符号标记。 */
export const tuiColors = {
  accent: 'cyan',
  focus: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  muted: 'gray',
  border: 'blue',
} as const;

export const tuiTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: tuiColors.focus, bold: true }),
        selectedIndicator: () => ({ color: tuiColors.success }),
        label: ({ isFocused, isSelected }) => ({
          color: isFocused ? tuiColors.focus : isSelected ? tuiColors.success : undefined,
          bold: isFocused,
        }),
      },
    },
    ConfirmInput: { styles: { input: () => ({ color: tuiColors.warning, bold: true }) } },
  },
});
