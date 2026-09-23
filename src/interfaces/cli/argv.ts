/**
 * MOD-05：顶层 argv 解析（Owner: `m2-deliver-planning-tui`）。
 *
 * 只识别 `[repository-path]`、`status [--json]`、`doctor`（外加 `help` 与 `--version`）。
 * `run`、`resume`、`tui` 明确不存在：它们会被拒绝并指出受支持入口，而不是被当成未知值忽略。
 */

export const SUPPORTED_SUBCOMMANDS = ['status', 'doctor', 'help'] as const;

export const CLI_USAGE = [
  '用法:',
  '  orca-companion [repository-path]            启动前台 TUI（需要 TTY）',
  '  orca-companion status [--json]              只读输出当前 Coordination Scope 状态（无 TTY 可运行）',
  '  orca-companion doctor                       核验 Orca 环境与 M0 必需能力（无 TTY 可运行）',
].join('\n');

/** 已被明确退役的入口；它们曾经存在或容易被误用，因此必须给出可诊断的拒绝。 */
export const REJECTED_SUBCOMMANDS: readonly string[] = ['run', 'resume', 'tui', 'headless', 'attach'];

export type CliInvocation =
  | { readonly kind: 'tui'; readonly repositoryPath: string | null }
  | { readonly kind: 'status'; readonly json: boolean }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'rejected'; readonly code: 'unknown_subcommand' | 'invalid_arguments'; readonly message: string };

export function parseCliArguments(argv: readonly string[]): CliInvocation {
  const [first, ...rest] = argv;
  if (first === undefined) {
    return { kind: 'tui', repositoryPath: null };
  }
  if (first === 'help' || first === '--help' || first === '-h') {
    return { kind: 'help' };
  }
  if (first === '--version') {
    return { kind: 'version' };
  }
  if (first === 'doctor') {
    if (rest.length > 0) {
      return { kind: 'rejected', code: 'invalid_arguments', message: `doctor 不支持参数: ${rest.join(' ')}` };
    }
    return { kind: 'doctor' };
  }
  if (first === 'status') {
    const unsupported = rest.find((argument) => argument !== '--json');
    if (unsupported !== undefined) {
      return { kind: 'rejected', code: 'invalid_arguments', message: `status 不支持参数: ${unsupported}` };
    }
    return { kind: 'status', json: rest.includes('--json') };
  }
  if (REJECTED_SUBCOMMANDS.includes(first)) {
    return {
      kind: 'rejected',
      code: 'unknown_subcommand',
      message: `不受支持的子命令: ${first}；受支持入口为 [repository-path]、status [--json]、doctor`,
    };
  }
  if (first.startsWith('-')) {
    return {
      kind: 'rejected',
      code: 'invalid_arguments',
      message: `未知选项: ${first}；受支持入口为 [repository-path]、status [--json]、doctor`,
    };
  }
  if (rest.length > 0) {
    return {
      kind: 'rejected',
      code: 'invalid_arguments',
      message: `[repository-path] 只接受一个位置参数: ${rest.join(' ')}`,
    };
  }
  return { kind: 'tui', repositoryPath: first };
}

export function renderRejection(invocation: Extract<CliInvocation, { readonly kind: 'rejected' }>): string {
  return `${invocation.message}\n${CLI_USAGE}\n`;
}
