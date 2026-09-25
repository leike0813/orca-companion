/**
 * 真实验收共用的 provider 凭据装载。
 *
 * 真实验收会调用真实 provider，凭据只从环境变量读：默认加载仓库根的 `.env.smoke`（被 `.gitignore` 忽略，
 * `.env.*` 规则），**已经存在的环境变量优先**，值不写入任何文件、不进日志、不出现在断言里。
 *
 * 文件里只保存一个共享 key（`COORDINATOR_SMOKE_API_KEY`）：各集成读自己的标准变量，因此装载时把它注入
 * 对应集成的标准变量名。这与 `tests/recovery/acceptance/real-validator-partial.test.ts` 用的是同一份文件
 * 与同一个环境变量（`ORCA_COMPANION_REAL_ENV_FILE`），真实验收因此只需要一处凭据配置。
 */

import { existsSync, readFileSync } from 'node:fs';

/** 覆盖 env 文件位置的变量；与其它真实验收共用。 */
export const REAL_ENV_FILE_VAR = 'ORCA_COMPANION_REAL_ENV_FILE';

/** 共享 key 变量与它注入的标准变量名。 */
const SHARED_KEY_VAR = 'COORDINATOR_SMOKE_API_KEY';
const STANDARD_KEY_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

export type RealEnvLoad = {
  readonly path: string;
  /** 本次实际写入的值（只报变量名，不报值）。 */
  readonly applied: readonly string[];
  /** 之后 provider 集成能否取到凭据。 */
  readonly hasProviderCredential: boolean;
};

/** 当前进程里是否已有 provider 集成会读取的凭据。 */
export function hasProviderCredential(): boolean {
  return STANDARD_KEY_VARS.some((name) => (process.env[name] ?? '').length > 0);
}

/**
 * 把 env 文件里的键值补进当前进程（不覆盖已存在的变量），并注入共享 key。
 *
 * 文件不存在时是空操作：调用方据此给出「缺少凭据」的明确结论，而不是在真实调用时才失败。
 */
export function mergeRealEnvFileIntoProcess(path: string): RealEnvLoad {
  const applied: string[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key.length === 0 || value.length === 0 || process.env[key] !== undefined) {
        continue;
      }
      process.env[key] = value;
      applied.push(key);
    }
  }
  const shared = process.env[SHARED_KEY_VAR];
  if (shared !== undefined && shared.length > 0) {
    for (const name of STANDARD_KEY_VARS) {
      if ((process.env[name] ?? '').length > 0) {
        continue;
      }
      process.env[name] = shared;
      applied.push(name);
    }
  }
  return { path, applied, hasProviderCredential: hasProviderCredential() };
}
