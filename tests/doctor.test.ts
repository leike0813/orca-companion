import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  DOCTOR_SCHEMA_VERSION,
  REQUIRED_CLI_COMMANDS,
  REQUIRED_RUNTIME_CAPABILITIES,
  compareVersions,
  createOrcaDoctorProbe,
  runDoctor,
  type DoctorProbe,
  type DoctorReport,
} from '../src/bootstrap/doctor.js';
import { main, toChildEnvironment } from '../src/interfaces/cli/main.js';

function probe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.4.198' }),
    readRuntime: () =>
      Promise.resolve({
        ok: true,
        value: { state: 'ready', reachable: true, capabilities: [...REQUIRED_RUNTIME_CAPABILITIES] },
      }),
    readHosts: () => Promise.resolve({ ok: true, value: [{ id: 'local', kind: 'local', platform: 'linux' }] }),
    readCoordinatorIdentity: () => Promise.resolve({ ok: true, value: '绑定型查询接受一个活动终端句柄' }),
    readPublicCommands: () =>
      Promise.resolve({
        ok: true,
        value: Object.entries(REQUIRED_CLI_COMMANDS).flatMap(([group, names]) =>
          names.map((name) => `${group} ${name}`),
        ),
      }),
    ...overrides,
  };
}

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (text: string) => stdout.push(text),
      writeStderr: (text: string) => stderr.push(text),
    },
  };
}

const environment = { cwd: process.cwd(), env: {} };

test('环境完整时结论为 ok，且每项检查都有结论', async () => {
  const report = await runDoctor(probe());

  expect(report.schemaVersion).toBe(DOCTOR_SCHEMA_VERSION);
  expect(report.ok).toBe(true);
  expect(report.checks.map((check) => check.id)).toEqual([
    'orca-executable',
    'orca-version',
    'runtime',
    'runtime-capabilities',
    'hosts',
    'coordinator-identity',
    'public-commands',
  ]);
  expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  expect(report.observedOrcaVersion).toBe('1.4.198');
});

test('Orca 不可执行时归类为不可达并停止后续检查', async () => {
  const requested: string[] = [];
  const report = await runDoctor(
    probe({
      readOrcaVersion: () => {
        requested.push('version');
        return Promise.resolve({ ok: false, status: 'unreachable', detail: 'spawn orca ENOENT' });
      },
      readRuntime: () => {
        requested.push('runtime');
        return Promise.resolve({ ok: false, status: 'unreachable', detail: 'unused' });
      },
    }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks).toEqual([
    { id: 'orca-executable', status: 'unreachable', detail: 'spawn orca ENOENT' },
  ]);
  expect(report.observedOrcaVersion).toBeNull();
  expect(requested).toEqual(['version']);
});

test('版本低于已验证基线或无法解析时报版本不符', async () => {
  const older = await runDoctor(probe({ readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.4.197' }) }));
  expect(older.ok).toBe(false);
  expect(older.checks.at(-1)).toMatchObject({ id: 'orca-version', status: 'version-mismatch' });

  const unparsable = await runDoctor(
    probe({ readOrcaVersion: () => Promise.resolve({ ok: true, value: 'nightly' }) }),
  );
  expect(unparsable.ok).toBe(false);
  expect(unparsable.checks.at(-1)).toMatchObject({ id: 'orca-version', status: 'version-mismatch' });

  // 更新但兼容的版本放行，并如实报告观测值。
  const newer = await runDoctor(probe({ readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.5.2' }) }));
  expect(newer.ok).toBe(true);
  expect(newer.observedOrcaVersion).toBe('1.5.2');
});

test('runtime 不可达与缺少必需能力是两类不同原因', async () => {
  const unreachable = await runDoctor(
    probe({
      readRuntime: () =>
        Promise.resolve({ ok: true, value: { state: 'stopped', reachable: false, capabilities: [] } }),
    }),
  );
  expect(unreachable.ok).toBe(false);
  expect(unreachable.checks.at(-1)).toMatchObject({ id: 'runtime', status: 'unreachable' });

  const missingCapability = await runDoctor(
    probe({
      readRuntime: () =>
        Promise.resolve({
          ok: true,
          value: { state: 'ready', reachable: true, capabilities: ['orchestration.contract.v1'] },
        }),
    }),
  );
  expect(missingCapability.ok).toBe(false);
  const check = missingCapability.checks.at(-1);
  expect(check).toMatchObject({ id: 'runtime-capabilities', status: 'capability-missing' });
  expect(check?.detail).toContain('worktree.create-idempotency.v1');
});

test('协调身份不可取得时标记为缺失，且不报告成功', async () => {
  const report = await runDoctor(
    probe({
      readCoordinatorIdentity: () =>
        Promise.resolve({ ok: false, status: 'capability-missing', detail: '没有活动终端句柄' }),
    }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks.at(-1)).toMatchObject({ id: 'coordinator-identity', status: 'capability-missing' });
});

test('缺少 local host 时是能力缺失，而不是通过', async () => {
  const report = await runDoctor(
    probe({ readHosts: () => Promise.resolve({ ok: true, value: [{ id: 'remote', kind: 'ssh', platform: null }] }) }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks.at(-1)).toMatchObject({ id: 'hosts', status: 'capability-missing' });
});

test('缺少 M0 必需公开命令时拒绝启动', async () => {
  const report = await runDoctor(
    probe({ readPublicCommands: () => Promise.resolve({ ok: true, value: ['host list'] }) }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks.at(-1)).toMatchObject({ id: 'public-commands', status: 'capability-missing' });
  expect(report.checks.at(-1)?.detail).toContain('orchestration run-create');
});

test('doctor 命令把机器输出写 stdout、诊断写 stderr，并用退出码表达结论', async () => {
  const healthy = captureIO();
  const healthyExit = await main(['doctor'], environment, healthy.io, {
    createDoctorProbe: () => probe(),
  });
  expect(healthyExit).toBe(0);
  const report = JSON.parse(healthy.stdout.join('')) as DoctorReport;
  expect(report.ok).toBe(true);
  expect(healthy.stderr).toEqual([]);

  const broken = captureIO();
  const brokenExit = await main(['doctor'], environment, broken.io, {
    createDoctorProbe: () => probe({ readHosts: () => Promise.resolve({ ok: true, value: [] }) }),
  });
  expect(brokenExit).toBe(1);
  expect((JSON.parse(broken.stdout.join('')) as DoctorReport).ok).toBe(false);
  expect(broken.stderr.join('')).toContain('doctor: hosts: capability-missing');
});

test('未提供或未知子命令时给出明确拒绝，不假装支持 TUI', async () => {
  const noArgs = captureIO();
  expect(await main([], environment, noArgs.io, { createDoctorProbe: () => probe() })).toBe(2);
  expect(noArgs.stderr.join('')).toContain('orca-companion 目前只提供 doctor 与 status');
  expect(noArgs.stdout).toEqual([]);

  const unknown = captureIO();
  expect(await main(['tui', '--json'], environment, unknown.io, { createDoctorProbe: () => probe() })).toBe(2);
  expect(unknown.stderr.join('')).toContain('未知或尚未提供的子命令: tui');

  const help = captureIO();
  expect(await main(['--help'], environment, help.io, { createDoctorProbe: () => probe() })).toBe(0);
  expect(help.stdout.join('')).toContain('orca-companion doctor');
});

test('doctor 不要求 TTY：注入的管道式标准流即可运行', async () => {
  const { stdout, stderr, io } = captureIO();
  const exitCode = await main(['doctor'], environment, io, { createDoctorProbe: () => probe() });

  expect(exitCode).toBe(0);
  expect(stdout.join('')).toContain('"schemaVersion"');
  expect(stderr).toEqual([]);
});

test('身份声明类环境变量不会被隐式继承', () => {
  const child = toChildEnvironment({
    PATH: '/usr/bin',
    ORCA_TERMINAL_HANDLE: 'term_secret',
    ORCA_PANE_KEY: 'pane_secret',
    ORCA_TAB_ID: 'tab_secret',
    ORCA_USER_DATA_PATH: '/tmp/orca',
    EMPTY: undefined,
  });

  expect(child).toEqual({ PATH: '/usr/bin', ORCA_USER_DATA_PATH: '/tmp/orca' });
});

test('版本比较无法解析时返回 undefined，调用方按版本不符处理', () => {
  expect(compareVersions('1.4.198', '1.4.198')).toBe(0);
  expect(compareVersions('1.4.197', '1.4.198')).toBe(-1);
  expect(compareVersions('1.5.0', '1.4.198')).toBe(1);
  expect(compareVersions('dev', '1.4.198')).toBeUndefined();
});

test('真实探测在 Orca 不可执行时给出不可达结论，而不是抛异常', async () => {
  const probeUnderTest = createOrcaDoctorProbe({
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '' },
    executable: '/nonexistent/orca-companion-probe',
  });

  const report = await runDoctor(probeUnderTest);

  expect(report.ok).toBe(false);
  expect(report.checks[0]).toMatchObject({ id: 'orca-executable', status: 'unreachable' });
  expect(report.checks).toHaveLength(1);
});

const builtEntry = path.join(process.cwd(), 'dist', 'src', 'interfaces', 'cli', 'main.js');

test.skipIf(!existsSync(builtEntry))(
  '构建产物在无 TTY 的管道中可运行，stdout 为机器输出',
  () => {
    const child = spawnSync(process.execPath, [builtEntry, 'doctor'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });

    // 结论取决于真实环境，但绝不能因为缺少 TTY 而崩溃或用 2 表示用法错误。
    expect([0, 1]).toContain(child.status);
    const report = JSON.parse(child.stdout) as DoctorReport;
    expect(report.schemaVersion).toBe(DOCTOR_SCHEMA_VERSION);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(child.stdout).not.toContain('用法:');
  },
);
