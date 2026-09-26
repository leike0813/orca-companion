/**
 * 只读 Worker 能力探针的测试替身。
 *
 * 能力门禁本身由 `tests/adapters/agents/codex-read-only-probe.test.ts` 与各派发入口的用例覆盖；
 * 其余用例（事实装配、对账、投影）只需要一个固定结论，不必依赖真实主机的沙箱状态。
 */

import { CODEX_UTILITY_PERMISSION_PROFILE } from '../../src/adapters/agents/codex-launch.js';
import type {
  ReadOnlyWorkerProbe,
  ReadOnlyWorkerProbeResult,
} from '../../src/adapters/agents/codex-read-only-probe.js';

/** 本机受限命令可用。 */
export const READ_ONLY_WORKER_AVAILABLE: ReadOnlyWorkerProbeResult = {
  kind: 'available',
  stage: 'host-verify',
  codexVersion: '0.156.1',
  profile: CODEX_UTILITY_PERMISSION_PROFILE,
  diagnostics: [],
};

/** 本机受限命令跑不起来（真实主机在这条路径上的现象）。 */
export const READ_ONLY_WORKER_UNAVAILABLE: ReadOnlyWorkerProbeResult = {
  kind: 'unavailable',
  stage: 'sandbox-read',
  codexVersion: '0.156.1',
  profile: CODEX_UTILITY_PERMISSION_PROFILE,
  diagnostics: ['error building bubblewrap command: cannot establish app-server socket mount isolation'],
};

/** 固定返回给定结论的探针替身；默认「可用」，即保持未加门禁时的既有行为。 */
export function fixedReadOnlyWorkerProbe(
  result: ReadOnlyWorkerProbeResult = READ_ONLY_WORKER_AVAILABLE,
): ReadOnlyWorkerProbe {
  return () => Promise.resolve(result);
}
