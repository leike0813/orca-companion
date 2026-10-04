/** Shared MOD-06 descriptions and fixed bindings; IC-11 owns business admission. */
export type GlobalAction = 'search-history' | 'navigate-activity' | 'input-history' | 'command-palette' | 'toggle-sidebar' | 'graph-inspector' | 'toggle-tool' | 'enter-answer' | 'exit' | 'escape';
export type CommandMeta = { readonly alias: string | null; readonly label: string; readonly description: string; readonly target: 'Scope' | 'Session' | 'UI'; readonly path: string; readonly shortcut: string | null; readonly action: GlobalAction | null };
export const COMMAND_METADATA = {
  "compact": {"path":"压缩会话","shortcut":null,"action":null,"alias":"compact","label":"压缩会话","description":"请求手动压缩","target":"Session"},
  "model-picker": {"path":"Model Picker","shortcut":null,"action":null,"alias":"model","label":"Model Picker","description":"选择协调模型","target":"Session"},
  "handoff": {"path":"Route Planning Handoff","shortcut":null,"action":null,"alias":"handoff","label":"Route Planning Handoff","description":"交接规划责任","target":"Scope"},
  "session-picker": {"path":"Session Picker","shortcut":null,"action":null,"alias":"sessions","label":"Session Picker","description":"切换会话","target":"UI"},
  "event-drawer": {"path":"项目 → 最近事件","shortcut":null,"action":null,"alias":"events","label":"最近事件","description":"打开项目事件页","target":"Scope"},
  "graph-inspector": {"path":"执行图检查","shortcut":"ctrl+g","action":"graph-inspector","alias":"graph","label":"执行图检查","description":"依赖与依据","target":"Scope"},
  "toggle-sidebar": {"path":"侧栏密度","shortcut":null,"action":null,"alias":null,"label":"侧栏密度","description":"展开或折叠","target":"UI"},
  "pause": {"path":"Pause","shortcut":null,"action":null,"alias":"pause","label":"Pause","description":"暂停项目协调","target":"Scope"},
  "resume": {"path":"Resume","shortcut":null,"action":null,"alias":"resume","label":"Resume","description":"先对账再恢复","target":"Scope"},
  "cancel": {"path":"Cancel","shortcut":null,"action":null,"alias":"cancel","label":"Cancel","description":"停止项目协调","target":"Scope"},
  "input-record-manager": {"path":"输入记录","shortcut":null,"action":null,"alias":"inputs","label":"输入记录","description":"草稿/冲突/待核验","target":"UI"},
  "execution-handoff": {"path":"Execution Handoff","shortcut":null,"action":null,"alias":"handoff","label":"Execution Handoff","description":"交接执行责任","target":"Scope"},
  "authorize-execution": {"path":"Execution Authorization","shortcut":null,"action":null,"alias":"authorize","label":"Execution Authorization","description":"审阅并批准执行","target":"Scope"},
  "filter-execution": {"path":"图过滤","shortcut":null,"action":null,"alias":null,"label":"图过滤","description":"仅改变可见性","target":"UI"},
  "answer": {"path":"当前会话回答","shortcut":"shift+left","action":"enter-answer","alias":"answer","label":"当前会话回答","description":"绑定当前问题","target":"Session"},
  "paste": {"path":"粘贴块","shortcut":null,"action":null,"alias":"paste","label":"粘贴块","description":"查看完整载荷","target":"UI"},
  "exit": {"path":"Exit","shortcut":"ctrl+c","action":"exit","alias":"exit","label":"Exit","description":"退出前台","target":"UI"},
  "project": {"path":"项目 → 总览","shortcut":"ctrl+b","action":"toggle-sidebar","alias":"project","label":"项目总览","description":"预算与身份","target":"Scope"},
  "options": {"path":"选项","shortcut":null,"action":null,"alias":"options","label":"选项","description":"图标与显示","target":"UI"},
  "statusline": {"path":"选项 → 状态栏","shortcut":null,"action":null,"alias":"statusline","label":"状态栏设置","description":"自定义状态栏字段与格式","target":"UI"},
  "icons-nerd": {"path":"选项 → Nerd Fonts","shortcut":null,"action":null,"alias":null,"label":"Nerd Fonts","description":"使用字体图标","target":"UI"},
  "icons-ascii": {"path":"选项 → ASCII","shortcut":null,"action":null,"alias":null,"label":"ASCII","description":"使用 ASCII 图标","target":"UI"},
  "pending-list": {"path":"项目 → 待答列表","shortcut":null,"action":null,"alias":null,"label":"待答列表","description":"跨会话问题","target":"Scope"},
  "transcript-details": {"path":"整体详细","shortcut":"ctrl+t","action":"toggle-tool","alias":null,"label":"整体详细","description":"切换对话详情","target":"Session"},
  "search-history": {"path":"搜索对话","shortcut":"f3","action":"search-history","alias":null,"label":"搜索对话","description":"搜索保留原文","target":"Session"},
  "navigate-activity": {"path":"活动导航","shortcut":"f4","action":"navigate-activity","alias":null,"label":"活动导航","description":"查看工具活动","target":"Session"},
  "input-history": {"path":"普通输入历史","shortcut":"ctrl+r","action":"input-history","alias":null,"label":"普通输入历史","description":"查找与采用输入","target":"Session"},
  "command-directory": {"path":"命令目录","shortcut":"ctrl+p","action":"command-palette","alias":null,"label":"命令目录","description":"搜索操作","target":"UI"},
  'verify-command-results': {alias:null,label:'核验命令结果',description:'只读核验原调用',target:'Scope',path:'核验命令结果',shortcut:null,action:null},
  "help": {"path":"Help","shortcut":null,"action":null,"alias":"help","label":"Help","description":"命令与键位","target":"UI"},
  "model-settings": {"path":"模型连接设置","shortcut":null,"action":null,"alias":"connections","label":"模型连接设置","description":"编辑 provider、模型、选项与 key","target":"Scope"},
} as const satisfies Readonly<Record<string, CommandMeta>>;
export type CommandId = keyof typeof COMMAND_METADATA;
export const COMMAND_IDS = Object.keys(COMMAND_METADATA) as CommandId[];
export const COMMAND_LABELS = Object.fromEntries(COMMAND_IDS.map(id => [id, COMMAND_METADATA[id].label])) as Readonly<Record<CommandId, string>>;
export const GLOBAL_KEY_BINDINGS = Object.fromEntries([...COMMAND_IDS.flatMap(id => {
  const meta = COMMAND_METADATA[id]; return meta.action && meta.shortcut ? [[meta.action, meta.shortcut]] : [];
}), ['escape', 'escape']]) as Readonly<Record<GlobalAction, string>>;
export const COMPOSER_SUBMIT_KEY = 'enter';
export const COMPOSER_NEWLINE_KEYS = ['shift+enter', 'alt+enter'] as const;
export const HELP_LINES = [
  ...COMMAND_IDS.flatMap(id => { const meta = COMMAND_METADATA[id]; return meta.shortcut ? [meta.shortcut + ' · ' + meta.label] : []; }),
  'Ctrl+A/E 当前行首尾 · 空输入 ↑ 召回 · Esc 逐层返回',
  COMPOSER_SUBMIT_KEY + ' 提交 · Alt+Enter 换行',
];
export function boundedQuery(text: string): string { return [...text].slice(0, 256).join(''); }
export function literalMatch(query: string, ...values: string[]): boolean { return values.join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()); }
export function searchCommands(query: string): readonly CommandId[] {
  return COMMAND_IDS.filter(id => { const meta = COMMAND_METADATA[id]; return literalMatch(query, id, meta.label, meta.description, meta.alias === null ? '' : '/' + meta.alias, meta.path); });
}
export type SlashResolution =
  | { readonly kind: 'not-command' }
  | { readonly kind: 'command'; readonly command: CommandId }
  | {
      readonly kind: 'error';
      readonly code: 'unknown_command' | 'invalid_format';
      readonly message: string;
    };

/**
 * 按 slash 别名查命令：唯一来源就是 `COMMAND_IDS` 与 `COMMAND_METADATA`，不另建命令目录。
 *
 * `handoff` 在规划与执行两个业务合同下同名：按当前模式选择，执行阶段取 `execution-handoff`。
 */
function commandForSlashAlias(alias: string, mode: string): CommandId | undefined {
  const matches = COMMAND_IDS.filter((command) => COMMAND_METADATA[command].alias === alias);
  if (matches.length <= 1) {
    return matches[0];
  }
  return mode === 'execution_coordination'
    ? (matches.find((command) => command === 'execution-handoff') ?? matches[0])
    : matches[0];
}

/**
 * 严格 slash 分类：只要以 `/` 开头就归命令处理，绝不回退为普通消息或回答。
 *
 * 只接受单个完整命令：空命令、内联参数与多行正文都报格式错误并保留输入。
 */
export function parseSlashInput(text: string, mode: string): SlashResolution {
  if (!text.startsWith('/')) {
    return { kind: 'not-command' };
  }
  if (/\r|\n/u.test(text)) {
    return { kind: 'error', code: 'invalid_format', message: '命令必须是单行，不支持内联正文' };
  }
  const trimmed = text.trim();
  if (trimmed.length <= 1) {
    return { kind: 'error', code: 'invalid_format', message: '以 / 开头时必须给出完整命令名' };
  }
  const body = trimmed.slice(1);
  if (/\s/u.test(body)) {
    return { kind: 'error', code: 'invalid_format', message: '命令不接受内联参数或空白，请在打开的界面里选择' };
  }
  const alias = body.toLowerCase();
  const command = commandForSlashAlias(alias, mode);
  if (command !== undefined) {
    return { kind: 'command', command };
  }
  return {
    kind: 'error',
    code: 'unknown_command',
    message: `无法识别的命令 /${alias}；按 /help 查看可用命令`,
  };
}

export function commandReason(command: CommandId, view: { readonly mode: string; readonly selectedSessionId: string | null; readonly pasteBlocks: number; readonly controlState?: string; readonly modelSettings?: boolean; readonly preferences?: boolean }): string | null {
  if (command === 'statusline' && view.preferences !== true) return '用户偏好端口不可用；只能使用默认显示设置';
  if (command === 'model-settings' && view.modelSettings !== true) return '角色模型配置端口尚未接通';
  if (command === 'handoff' && view.mode !== 'route_planning') return '仅用于规划模式';
  if (command === 'execution-handoff' && view.mode !== 'execution_coordination') return '仅用于执行模式';
  if (command === 'authorize-execution' && view.mode !== 'route_planning') return '当前已在执行协调模式';
  if (command === 'pause' && view.controlState === 'paused') return '当前 Scope 已暂停';
  if (command === 'paste' && view.pasteBlocks === 0) return '当前草稿没有粘贴块';
  if (COMMAND_METADATA[command].target === 'Session' && view.selectedSessionId === null) return '未选择 Coordinator Session';
  return null;
}

export function slashCandidates(text: string, mode: string): readonly CommandId[] {
  if (!/^\/[a-z-]*$/i.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return COMMAND_IDS.filter(command => {
    const alias = COMMAND_METADATA[command].alias;
    return alias !== null && alias.startsWith(query) && commandForSlashAlias(alias, mode) === command;
  });
}
