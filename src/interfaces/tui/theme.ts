import { defaultTheme, extendTheme } from '@inkjs/ui';

export type TuiIconMode = 'nerd' | 'ascii';
export const tuiIconMode: TuiIconMode = process.env['ORCA_COMPANION_TUI_ICONS'] === 'ascii' ? 'ascii' : 'nerd';

// Nerd Fonts Material Design glyphs: https://github.com/ryanoasis/nerd-fonts/blob/master/glyphnames.json
export const tuiIcons = { nerd: {
  candidate: '\u{f0b8b}',
  accepted: '\u{f0765}',
  running: '\u{f0766}',
  reconciling: '\u{f0e95}',
  blocked: '\u{f0b8a}',
  waiting: '\u{f0766}',
  unknown: '\u{f0625}',
}, ascii: {
  candidate: '+',
  accepted: 'O',
  running: '@',
  reconciling: '@',
  blocked: '#',
  waiting: 'o',
  unknown: '?',
} } as const;

export const tuiSpinnerGlyphs: Readonly<Record<string, string>> = {
  '🌑': '\u{f0f64}',
  '🌒': '\u{f0f67}',
  '🌓': '\u{f0f61}',
  '🌔': '\u{f0f68}',
  '🌕': '\u{f0f62}',
  '🌖': '\u{f0f66}',
  '🌗': '\u{f0f63}',
  '🌘': '\u{f0f65}',
};

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
          inverse: isFocused,
          bold: isFocused,
        }),
      },
    },
    ConfirmInput: { styles: { input: () => ({ color: tuiColors.warning, bold: true }) } },
  },
});
