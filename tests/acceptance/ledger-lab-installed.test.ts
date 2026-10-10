/**
 * IP-06 安装包验收：真实 `pnpm pack` → 仓库外临时仓库真实 `pnpm install` → 安装后的 bin 走生产 TUI 配置
 * Coordinator 连接与模型 → 同一个安装包 `--debug` 用用户自己建出来的库完成一轮对话与只读工具调用。
 *
 * 全程只走真实入口：PTY 按键、生产 Home / Provider 库 / 凭据 store，不预写项目配置或用户库来绕过界面。
 * 外部传输使用夹具：模型由本机 scripted-model-server 承担，Orca/gh 仅回答公开查询，API Key 是合成值。
 *
 * 默认跳过：它会真的打包当前工作区、在临时仓库安装 tarball 并启动 PTY，需要先 `pnpm build`，再
 * `ORCA_COMPANION_LAB_INSTALL_ACCEPTANCE=1 pnpm exec vitest run tests/acceptance/ledger-lab-installed.test.ts`。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launchTerminal, type Session } from 'tuistory';
import { describe, expect, it } from 'vitest';

import { scriptedModelServer } from '../support/scripted-model-server.js';
import { emptyRouteMapBody } from '../../src/application/planning/route-map-initialization.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONNECTION_LABEL = 'Installed Lab';
const MODEL_ID = 'fixture-model';
const SYNTHETIC_SECRET = 'sk-local-acceptance-only';
const setupHref = new URL('../../artifacts/ledger-lab/setup.mjs', import.meta.url).href;
const { terminalCommand } = await import(/* @vite-ignore */ setupHref) as {
  terminalCommand: (repositoryPath: string, executable: string) => string;
};

/** 目标行都是列表末项：连按 ↓ 会钳在末行，因此不受模型发现何时返回的影响。 */
async function selectLastRow(terminal: Session, times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await terminal.press('down');
}

function run(command: string, args: readonly string[], cwd: string, timeout = 300_000, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 退出 ${String(result.status ?? result.signal)}：${(result.stderr + result.stdout).slice(-2000)}`);
  }
  return result.stdout;
}

async function until(predicate: () => boolean | Promise<boolean>, diagnostics: () => Promise<string> | string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let passed = await predicate();
  while (!passed && Date.now() < deadline) {
    await delay(50);
    passed = await predicate();
  }
  expect(passed, passed ? undefined : await diagnostics()).toBe(true);
}

/** 真实打包当前工作区：tarball 内容只由 package.json 的 files 决定，开发源码不会进入包。 */
function packInstalledTarball(packDirectory: string): string {
  run('pnpm', ['pack', '--pack-destination', packDirectory], repositoryRoot);
  const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith('.tgz'));
  expect(tarballs).toHaveLength(1);
  return join(packDirectory, tarballs[0]!);
}

/** 仓库外的新建演练仓库：只放一个空提交，装完的 bin 就是这个仓库自己的 node_modules/.bin/ocp。 */
function createExternalRepository(root: string, tarball: string): string {
  const repository = join(root, 'repo');
  mkdirSync(repository);
  run('git', ['init', '--initial-branch=main'], repository);
  run('git', ['config', 'user.email', 'installed@example.invalid'], repository);
  run('git', ['config', 'user.name', 'installed acceptance'], repository);
  run('git', ['commit', '--allow-empty', '-m', 'external rehearsal'], repository);
  // 与演练准备一致：仓库内以 file: 依赖指向同轮次的 tarball，再按生产仓库的方式放行依赖 build script。
  writeFileSync(join(repository, 'package.json'), `${JSON.stringify({
    name: 'installed-lab-rehearsal', private: true, version: '0.0.0',
    devDependencies: { 'orca-companion': `file:../packages/${basename(tarball)}` },
  }, null, 2)}\n`);
  // pnpm 11 把「依赖有 build script 但没放行」当安装失败：演练仓库照生产仓库的方式只放行
  // better-sqlite3 的预编译产物，否则安装本身就以 ERR_PNPM_IGNORED_BUILDS 退出 1。
  writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'allowBuilds:\n  better-sqlite3: true\n');
  run('pnpm', ['install'], repository);
  return repository;
}

describe.skipIf(process.env['ORCA_COMPANION_LAB_INSTALL_ACCEPTANCE'] !== '1')('安装包验收（真实 pack/install + 生产 PTY）', () => {
  it('安装后的 bin 用生产界面配置 Coordinator，随后同一个 bin 的调试会话完成对话与只读工具调用', async () => {
    expect(existsSync(join(repositoryRoot, 'dist', 'src', 'interfaces', 'cli', 'main.js')), '先运行 pnpm build').toBe(true);
    const server = await scriptedModelServer();
    const root = mkdtempSync(join(tmpdir(), 'ocp-installed-'));
    const environment: Record<string, string> = {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', NO_COLOR: '1', FORCE_COLOR: '0',
    };
    const terminals: Session[] = [];
    let completed = false;
    try {
      const tarball = packInstalledTarball(join(root, 'packages'));
      const repository = createExternalRepository(root, tarball);
      const bin = join(repository, 'node_modules', '.bin', 'ocp');
      const installedPackage = join(repository, 'node_modules', 'orca-companion');

      // 包内容就是发布面：源码、测试、演练资产与上游 submodule 都不在 tarball 里。
      const entries = run('tar', ['-tzf', tarball], repositoryRoot).split('\n').filter((name) => name !== '');
      expect(entries.length).toBeGreaterThan(100);
      expect(entries.filter((name) => !name.startsWith('package/dist/src/') && !['package/package.json', 'package/README.md'].includes(name)))
        .toEqual([]);

      // bin 是安装出来的真实入口，落在临时仓库的 node_modules 里；包内没有任何开发目录路径。
      const shim = readFileSync(bin, 'utf8');
      const entry = /^# cmd-shim-target=(.+)$/mu.exec(shim)?.[1]?.trim() ?? '';
      const packageRoot = realpathSync(installedPackage);
      expect(packageRoot.startsWith(realpathSync(repository)), shim).toBe(true);
      expect(realpathSync(entry).startsWith(packageRoot + sep), shim).toBe(true);
      expect(entry.endsWith(join('dist', 'src', 'interfaces', 'cli', 'main.js'))).toBe(true);
      const help = run(bin, ['--help'], repository, 60_000, { ...process.env, NODE_PATH: '' });
      expect(help).toContain('ocp --debug');
      expect(help).toContain('ocp status [--json]');
      const packaged = readdirSync(installedPackage, { recursive: true, encoding: 'utf8' }).filter((name) => /\.(?:js|json)$/u.test(name));
      expect(packaged.length).toBeGreaterThan(100);
      expect(packaged.filter((name) => readFileSync(join(installedPackage, name), 'utf8').includes(repositoryRoot))).toEqual([]);
      const catalog = JSON.parse(readFileSync(join(installedPackage, 'dist', 'src', 'adapters', 'agents', 'provider-catalog.json'), 'utf8')) as {
        presets: unknown[]; models: unknown[];
      };
      expect(catalog.presets.length).toBeGreaterThan(0);

      // Public CLI fixtures exercise production transport/schema; they never touch a real Orca/GitHub project.
      const fixtureBin = join(root, 'fixture-bin');
      mkdirSync(fixtureBin);
      const orca = join(fixtureBin, 'orca');
      writeFileSync(orca, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.222'); process.exit(0); }
let result;
if (args[0] === 'status') result = {runtime:{reachable:true,state:'running',capabilities:[]}};
else if (args[0] === 'terminal' && args[1] === 'list') result = {terminals:[{handle:'fixture-terminal',connected:true,writable:true,orphaned:false,executionHostId:'local'}],hostScope:{hostIds:['local'],omittedHostIds:[]}};
else if (args[0] === 'orchestration' && args[1] === 'run-current') result = {run:null};
else { console.error('Unexpected public Orca query'); process.exit(2); }
console.log(JSON.stringify({id:'fixture-request',ok:true,result,_meta:{runtimeId:'fixture-runtime'}}));
`, { mode: 0o700 });
      writeFileSync(join(fixtureBin, 'gh'), `#!/usr/bin/env node
const args=process.argv.slice(2), body=${JSON.stringify(emptyRouteMapBody())};
if(args[0]==='repo' && args[1]==='view') console.log(JSON.stringify({nameWithOwner:'fixture/installed'}));
else if(args[0]==='issue' && args[1]==='view') console.log(JSON.stringify({number:42,title:'Route Map',body,state:'OPEN',assignees:[],updatedAt:'2026-10-09T00:00:00Z',url:'https://github.com/fixture/installed/issues/42'}));
else { console.error('Unexpected GitHub mutation'); process.exit(2); }
`, { mode: 0o700 });
      environment['PATH'] = `${fixtureBin}:${environment['PATH'] ?? ''}`;

      const terminal = await launchTerminal({ command: process.env['SHELL'] ?? '/bin/sh', cwd: repository, env: environment, cols: 100, rows: 30 });
      terminals.push(terminal);
      await terminal.type(terminalCommand(repository, orca));
      await terminal.press('enter');
      await terminal.type('ocp --debug');
      await terminal.press('enter');

      // Debug-first: no project config, Orca or provider library is needed to reach configuration.
      await terminal.waitForText('新建或继续', { timeout: 30_000 });
      expect(existsSync(join(environment['XDG_CONFIG_HOME']!, 'orca-companion', 'providers.json'))).toBe(false);
      await terminal.press('p');
      await terminal.waitForText('已保存 Provider 连接');
      await selectLastRow(terminal, 2);
      await terminal.press('enter');
      await terminal.waitForText('服务 / 地区 / 产品线');
      // 公共目录里有上百个 Provider，自定义协议是最后一项：地址与协议都由我们自己填。
      for (let index = 0; index < 200; index += 1) await terminal.press('down');
      await terminal.press('enter');
      await terminal.waitForText('连接信息');
      await terminal.type(CONNECTION_LABEL);
      await terminal.press('down');
      await terminal.type(server.baseUrl);
      await terminal.press('down');
      await terminal.type(SYNTHETIC_SECRET);
      await terminal.press('enter');
      await terminal.waitForText('连接已保存');
      await terminal.waitForText('模型候选与手动填写');
      await terminal.type(MODEL_ID);
      // 首行要么是发现回来的同名模型，要么是手动填写行：两者保存的都是这个模型编号。
      await terminal.press('down');
      await terminal.press('enter');
      await terminal.waitForText('选择模型（会话固定该配置）');
      await terminal.press('enter');
      await terminal.waitForText('普通消息', { timeout: 30_000 });
      expect(existsSync(join(repository, 'orca-companion.json'))).toBe(false);
      terminal.sendKey(['ctrl', 'c']);
      await delay(300);
      await terminal.type('ocp');
      await terminal.press('enter');
      await terminal.waitForText('已保存 Provider 连接', { timeout: 30_000 });
      await terminal.press('enter');
      await terminal.waitForText('模型候选与手动填写');
      await terminal.type(MODEL_ID);
      await terminal.press('down');
      await terminal.press('enter');
      await terminal.waitForText('设置 Route Map');
      await terminal.press('down');
      await terminal.type('42');
      await terminal.press('enter');
      await terminal.waitForText('准备开始规划');
      expect(existsSync(join(repository, 'orca-companion.json'))).toBe(false);
      await terminal.press('enter');
      await terminal.waitForText('普通消息', { timeout: 30_000 });

      // 界面保存的结果：连接与模型在用户库，凭据只在凭据 store，项目配置只保存引用。
      const libraryPath = join(environment['XDG_CONFIG_HOME']!, 'orca-companion', 'providers.json');
      const libraryText = readFileSync(libraryPath, 'utf8');
      const library = JSON.parse(libraryText) as {
        connections: { connectionRef: string; label: string; providerId: string; providerIntegration: string; baseUrl: string;
          credential: { kind: string; credentialRef: string } }[];
        models: { modelRef: string; connectionRef: string; model: string }[];
      };
      const connection = library.connections[0]!;
      expect(connection).toMatchObject({ label: CONNECTION_LABEL, providerId: 'custom', providerIntegration: 'openai-chat', baseUrl: server.baseUrl });
      expect(library.models).toEqual([expect.objectContaining({ connectionRef: connection.connectionRef, model: MODEL_ID })]);
      expect(libraryText).not.toContain(SYNTHETIC_SECRET);
      const credentials = JSON.parse(readFileSync(join(environment['XDG_CONFIG_HOME']!, 'orca-companion', 'credentials.json'), 'utf8')) as {
        entries: { credentialRef: string; secret: string }[];
      };
      expect(credentials.entries).toEqual([{ credentialRef: connection.credential.credentialRef, secret: SYNTHETIC_SECRET }]);
      expect(statSync(libraryPath).mode & 0o777).toBe(0o600);
      const projectConfigText = readFileSync(join(repository, 'orca-companion.json'), 'utf8');
      const projectConfig = JSON.parse(projectConfigText) as {
        schemaVersion: number;
        providerConnections: { connectionRef: string; credential: { credentialRef: string } }[];
        coordinatorModels: { configurationRef: string; model: string; credentialRefs: string[] }[];
        defaultCoordinatorModelRef: string;
        tracker: { routeMapIssueNumber: number };
      };
      expect(projectConfig).toMatchObject({
        schemaVersion: 5,
        defaultCoordinatorModelRef: projectConfig.coordinatorModels[0]!.configurationRef,
        tracker: { routeMapIssueNumber: 42 },
      });
      expect(projectConfig.coordinatorModels[0]).toMatchObject({ model: MODEL_ID, credentialRefs: [connection.credential.credentialRef] });
      expect(projectConfigText).not.toContain(SYNTHETIC_SECRET);
      expect(server.requests).toHaveLength(0);

      terminal.sendKey(['ctrl', 'c']);
      await delay(200);
      await terminal.type('exit');
      await terminal.press('enter');
      expect(await terminal.waitForExit(20_000)).toBe(true);
      expect(terminal.exitInfo?.exitCode).toBe(0);

      // 同一个安装包、同一个用户库：调试会话不需要再配置一次。
      const debugDirectory = join(root, 'debug-workspace');
      mkdirSync(debugDirectory);
      writeFileSync(join(debugDirectory, 'sample.txt'), 'installed package read-only evidence\n');
      environment['PATH'] = `${join(repository, 'node_modules', '.bin')}:${environment['PATH'] ?? ''}`;
      environment['ORCA_CLI_COMMAND'] = orca;
      const debug = await launchTerminal({ command: 'ocp', args: ['--debug', debugDirectory], cwd: repository, env: environment, cols: 100, rows: 30 });
      terminals.push(debug);
      const debugScreen = async (): Promise<string> => debug.text();
      await debug.waitForText('新建或继续', { timeout: 30_000 });
      await debug.press('n');
      await debug.waitForText('选择模型');
      await debug.press('enter');
      await debug.waitForText('普通消息', { timeout: 30_000 });
      expect(await debugScreen()).toContain(MODEL_ID);

      const send = async (text: string): Promise<void> => {
        await debug.type(text);
        await debug.waitForText(text);
        await debug.press('enter');
      };
      await send('你好');
      await until(() => server.requests.length === 1, debugScreen);
      await debug.waitForText('E2E回复');
      await send('__TOOL__');
      await until(() => server.requests.length === 3, debugScreen);
      await debug.waitForText('工具结果已收到');
      const toolTurn = server.requests.at(-1) as { messages: { role: string; content: unknown }[] } | undefined;
      expect(toolTurn?.messages.filter((message) => message.role === 'tool').map((message) => String(message.content)).join(''))
        .toContain('installed package read-only evidence');

      debug.sendKey(['ctrl', 'c']);
      expect(await debug.waitForExit(20_000)).toBe(true);
      expect(debug.exitInfo?.exitCode).toBe(0);
      await until(() => server.activeRequests() === 0, debugScreen);
      await delay(300);
      // 退出后没有残留请求，这一整轮只有约定的对话与工具请求。
      expect(server.requests).toHaveLength(3);
      completed = true;
    } finally {
      for (const terminal of terminals) terminal.close();
      await server.close();
      // 失败保留现场供诊断，成功只留下测试结果。
      if (completed) rmSync(root, { recursive: true, force: true });
      else console.warn(`安装包验收失败，临时目录保留在 ${root}`);
    }
  }, 300_000);
});
