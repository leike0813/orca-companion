/**
 * IP-5 / MOD-05：`orca-companion doctor` 命令。
 *
 * 机器输出只写标准输出，诊断只写标准错误；不要求 TTY，不加载 Ink/React，也不自行推进任何状态。
 */

import type { DoctorProbe, DoctorReport } from '../../bootstrap/doctor.js';
import { runDoctor } from '../../bootstrap/doctor.js';

export type CliIO = {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
};

export const defaultCliIO: CliIO = {
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

/** 返回进程退出码：环境完整为 0，任一必需能力缺失或不可达为非零。 */
export async function runDoctorCommand(probe: DoctorProbe, io: CliIO): Promise<number> {
  const report: DoctorReport = await runDoctor(probe);
  io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  for (const check of report.checks) {
    if (check.status !== 'ok') {
      io.writeStderr(`doctor: ${check.id}: ${check.status}: ${check.detail}\n`);
    }
  }
  return report.ok ? 0 : 1;
}
