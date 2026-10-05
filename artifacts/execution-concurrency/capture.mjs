import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

/**
 * 三档多包并发/执行设置假画面采集（IP-05 呈现验收）。
 *
 * 挂载 artifacts/execution-concurrency/preview-runner.mjs（生产 TuiApp + 隔离假端口），用真实 tmux
 * PTY 在三档尺寸下截取帧文本与 PNG。没有真实 Worker、模型或 Orca 调用；画面里的两个活动包与批准额度
 * 是显式夹具，按需求仿真。
 *
 * 用法：pnpm build && node artifacts/execution-concurrency/capture.mjs
 */

const root = process.cwd();
const output = join(root, 'artifacts/execution-concurrency', process.argv[2] ?? 'frames');
mkdirSync(output, { recursive: true });
const require = createRequire(join(root, 'package.json'));
const { launchTerminal } = await import(require.resolve('tuistory'));
const modulePath = createRequire(require.resolve('tuistory')).resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(modulePath);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(modulePath)));

const samples = [];
function screenText(session) {
  const data = session.getTerminalData();
  return data.lines.slice(-data.rows).map((line) => line.spans.map((span) => span.text).join('')).join('\n');
}
function expectText(session, name, terms) {
  const screen = screenText(session);
  const missing = terms.filter((term) => !screen.includes(term));
  if (missing.length) throw new Error(name + ': 缺少语义内容 ' + missing.join(', '));
}
async function press(session, key) { await session.press(key); await delay(140); }
async function shot(session, name, size, mode) {
  await session.text();
  const data = session.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  const stem = name + '-' + size.join('x') + '-' + mode;
  const cells = { ...data, lines: lines.map((line) => ({ ...line, spans: line.spans.flatMap((span) => Array.from(span.text, (character) => ({
    ...span, text: character, width: displayWidth(character),
    ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
  }))) })) };
  writeFileSync(join(output, stem + '.txt'), lines.map((line) => line.spans.map((span) => span.text).join('').trimEnd()).join('\n') + '\n');
  writeFileSync(join(output, stem + '.png'), await renderTerminalToImage(cells));
  samples.push({ name, size, mode, png: stem + '.png', text: stem + '.txt', cursor: data.cursor });
  writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
}
function envFor(mode, icons) {
  const value = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1',
    ORCA_COMPANION_TUI_ICONS: icons, FORCE_COLOR: mode === 'color' ? '1' : '0' };
  if (mode === 'no-color') value.NO_COLOR = '1'; else delete value.NO_COLOR;
  return value;
}
async function launch(size, mode, icons) {
  return launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1],
    env: envFor(mode, icons), args: ['artifacts/execution-concurrency/preview-runner.mjs'] });
}
async function openSettings(session) {
  await press(session, ['ctrl', 'p']);
  session.writeRaw('concurrency');
  await session.waitForText('执行并发设置');
  await delay(200);
  await press(session, 'enter');
  await session.waitForText('默认并行额度');
}

const tiers = [[120, 40], [80, 24], [50, 40]];
try {
  for (const size of tiers) for (const mode of ['color', 'no-color']) {
    const icons = size[0] === 50 ? 'ascii' : 'nerd';
    const session = await launch(size, mode, icons);
    try {
      await session.waitForText('请确认两个工作包');
      expectText(session, 'workspace ' + size.join('x'), ['执行 2 包', 'wp-2', 'wp-3']);
      await shot(session, 'workspace-multi-wp', size, mode);

      if (mode === 'no-color' && size[0] !== 120) continue;

      await openSettings(session);
      expectText(session, 'settings ' + size.join('x'), ['执行并发设置', '默认并行额度', '当前批准额度', '5']);
      await shot(session, 'execution-settings', size, mode);

      await press(session, 'backspace');
      await press(session, '0');
      await session.waitForText('必须是正安全整数');
      await shot(session, 'execution-settings-invalid', size, mode);

      await press(session, 'backspace');
      await press(session, '5');
      await session.waitForText('输入有效');
      await shot(session, 'execution-settings-valid', size, mode);

      await press(session, 'enter');
      await session.waitForText('已保存');
      await shot(session, 'execution-settings-saved', size, mode);

      await press(session, 'escape');
      await session.waitForText('请确认两个工作包');
      await shot(session, 'returned-workspace', size, mode);
      process.stdout.write('captured ' + size.join('x') + ' ' + mode + '\n');
    } finally {
      session.close();
    }
  }
} finally {
  writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
}
