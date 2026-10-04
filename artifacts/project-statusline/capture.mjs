import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd(), output = join(root, 'artifacts/project-statusline', process.argv[2] ?? 'release');
const scratch = mkdtempSync(join(tmpdir(), 'orca-statusline-'));
mkdirSync(output, { recursive: true });
const require = createRequire(join(root, 'package.json'));
const { launchTerminal } = await import(require.resolve('tuistory'));
const modulePath = createRequire(require.resolve('tuistory')).resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(modulePath);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(modulePath)));
const samples = [], checks = [];

function text(session) {
  const data = session.getTerminalData();
  return data.lines.slice(-data.rows).map(line => line.spans.map(span => span.text).join('')).join('\n');
}
function has(session, name, terms) {
  const screen = text(session), missing = terms.filter(term => !screen.includes(term));
  if (missing.length) throw new Error(`${name}: missing semantic content ${missing.join(', ')}`);
}
async function press(session, key) { await session.press(key); await delay(120); }
async function command(session, query, result = query) {
  await press(session, ['ctrl', 'p']); session.writeRaw(query); await session.waitForText(result); await delay(200); await press(session, 'enter');
}
async function shot(session, name, size, color, icons, phase) {
  await session.text();
  const data = session.getTerminalData(), lines = data.lines.slice(-data.rows);
  const stem = `${name}-${phase}-${size[0]}x${size[1]}-${color}-${icons}`;
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span => Array.from(span.text, character => ({
    ...span, text: character, width: displayWidth(character),
    ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
  }))) })) };
  writeFileSync(join(output, `${stem}.txt`), lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n');
  writeFileSync(join(output, `${stem}.png`), await renderTerminalToImage(cells));
  samples.push({ name, phase, size, color, icons, png: `${stem}.png`, text: `${stem}.txt`, cursor: data.cursor });
  writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
}
function env(configHome, phase, color, icons, { fail = false, transient = icons } = {}) {
  const value = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', FORCE_COLOR: color === 'color' ? '1' : '0',
    ORCA_COMPANION_PROJECT_STATUSLINE: '1', ORCA_COMPANION_PREVIEW_CONFIG_HOME: configHome,
    ORCA_COMPANION_PREVIEW_PHASE: phase, ORCA_COMPANION_TUI_ICONS: transient };
  if (color === 'no-color') value.NO_COLOR = '1'; else delete value.NO_COLOR;
  if (fail) value.ORCA_COMPANION_PREVIEW_SAVE_FAIL = '1'; else delete value.ORCA_COMPANION_PREVIEW_SAVE_FAIL;
  return value;
}
async function launch(size, color, icons, phase, configHome, options) {
  return launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1],
    env: env(configHome, phase, color, icons, options), args: ['scripts/tui-preview.mjs', 'alignment-planning'] });
}

try {
  for (const size of process.env.ORCA_COMPANION_CAPTURE_INTERACTIONS_ONLY === '1' ? [] : [[120, 40], [80, 24], [50, 40]]) for (const color of ['color', 'no-color']) for (const icons of ['nerd', 'ascii']) {
    for (const phase of ['blocked', 'planning', 'execution', 'answer', 'idle']) {
      const configHome = mkdtempSync(join(scratch, 'host-'));
      const session = await launch(size, color, icons, phase, configHome);
      try {
        await session.waitForText('普通消息'); has(session, phase, ['示例']);
        if (phase === 'answer') {
          await command(session, 'answer', '当前会话回答');
          await session.waitForText('请确认中文路径'); has(session, 'answer panel', ['请确认中文路径']);
          await shot(session, 'answer-panel', size, color, icons, phase);
        } else await shot(session, 'workspace', size, color, icons, phase);
        if (phase === 'planning') {
          await command(session, 'statusline', '状态栏设置'); has(session, 'statusline settings', ['模型名称']);
          await shot(session, 'statusline-settings', size, color, icons, phase); await press(session, 'esc'); await press(session, 'esc');
          await press(session, ['ctrl', 'b']); await press(session, 'down'); await press(session, 'enter');
          has(session, 'project budget', ['工作包', '实现尝试', '恢复']);
          await shot(session, 'project-budget', size, color, icons, phase); await press(session, 'esc');
          await press(session, 'down'); await press(session, 'down'); await press(session, 'enter');
          has(session, 'project identity', ['仓库', '分支', 'Session']);
          await shot(session, 'project-identity', size, color, icons, phase); await press(session, 'esc'); await press(session, 'esc');
        }
        checks.push({ phase, size, color, icons, productionApp: true, isolatedPorts: true });
      } finally { session.close(); }
    }
    process.stdout.write(`captured baseline ${size[0]}x${size[1]} ${color} ${icons}\n`);
  }

  const size = [120, 40], color = 'color', icons = 'nerd';
  const configHome = mkdtempSync(join(scratch, 'interaction-host-'));
  const session = await launch(size, color, icons, 'planning', configHome);
  try {
    await session.waitForText('普通消息'); session.writeRaw('首尾'); await session.waitForText('首尾'); await press(session, 'left'); session.writeRaw('中');
    await session.waitForText('首中尾');
    has(session, 'CJK cursor', ['首中尾']); await shot(session, 'cjk-cursor', size, color, icons, 'planning');
    await press(session, ['ctrl', 'b']); has(session, 'project frame', ['项目面板']);
    await shot(session, 'project-overview', size, color, icons, 'planning');
    await press(session, 'down'); await press(session, 'enter'); has(session, 'budget page', ['工作包', '实现尝试', '恢复']);
    await shot(session, 'project-budget', size, color, icons, 'planning');
    for (const [width, height] of [[80, 24], [50, 40], [120, 40]]) {
      session.resize({ cols: width, rows: height }); await delay(180);
      await shot(session, 'project-budget-resize', [width, height], color, icons, 'planning');
    }
    await press(session, 'esc'); await press(session, 'down'); await press(session, 'down'); await press(session, 'enter');
    has(session, 'identity page', ['仓库', '分支', 'Session']); await shot(session, 'project-identity', size, color, icons, 'planning');
    await press(session, 'esc'); await press(session, 'esc'); await press(session, ['ctrl', 'g']);
    has(session, 'shared graph acceptance', ['验收']); await shot(session, 'graph-inspector', size, color, icons, 'planning');
    await press(session, 'esc'); await command(session, 'statusline', '状态栏设置');
    has(session, 'statusline editor', ['模型名称']); await shot(session, 'statusline-editor', size, color, icons, 'planning');
    await press(session, 'down'); await press(session, 'space'); await press(session, 'right');
    await shot(session, 'statusline-draft', size, color, icons, 'planning');
    for (let row = 0; row < 10; row++) await press(session, 'down');
    has(session, 'restore defaults row', ['默认']); await press(session, 'space');
    await shot(session, 'statusline-defaults-draft', size, color, icons, 'planning');
    await press(session, 'enter'); await session.waitForText('首中尾'); has(session, 'save returns to original draft', ['首中尾']);
    await shot(session, 'statusline-saved-returned-draft', size, color, icons, 'planning');
    await press(session, ['ctrl', 'e']);
    for (let count = 0; count < 3; count++) await press(session, 'backspace');
    session.writeRaw('/'); await session.waitForText('命令候选');
    await shot(session, 'slash-above-draft-return', size, color, icons, 'planning');
    await press(session, 'esc');
    await press(session, 'backspace'); session.writeRaw('首中尾'); await session.waitForText('首中尾');
    for (const [width, height] of [[80, 24], [50, 40], [120, 40]]) {
      session.resize({ cols: width, rows: height }); await delay(180);
      has(session, 'resize draft retention', ['首中尾']);
      await shot(session, 'returned-draft-resize', [width, height], color, icons, 'planning');
    }
    checks.push({ cjkCursor: true, fixedProjectFrame: true, statuslineDraftRestoreSave: true, slashReturn: true });
  } finally { session.close(); }

  const failedConfig = mkdtempSync(join(scratch, 'failed-host-'));
  const failed = await launch(size, color, icons, 'planning', failedConfig, { fail: true });
  try {
    await failed.waitForText('普通消息'); await command(failed, 'statusline', '状态栏设置');
    await press(failed, 'down'); await press(failed, 'space'); await press(failed, 'enter');
    await failed.waitForText('保存失败'); has(failed, 'failed statusline save', ['保存失败']);
    await shot(failed, 'statusline-failed-save-draft-retained', size, color, icons, 'planning');
    checks.push({ kind: 'statusline-save-failure', draftRetained: true, separateHost: true });
  } finally { failed.close(); }

  const iconHome = mkdtempSync(join(scratch, 'icon-host-'));
  for (const fail of [true, false]) {
    const host = await launch(size, color, 'nerd', 'planning', iconHome, { fail });
    try {
      await host.waitForText('普通消息'); await command(host, 'icons-ascii', 'ASCII');
      await press(host, 'esc'); await command(host, 'options', '选项');
      if (fail) { await host.waitForText('图标未保存'); has(host, 'failed icon save', ['ascii', '未保存']); await shot(host, 'icon-failed-save-retained', size, color, 'ascii', 'planning'); }
      else { await shot(host, 'icon-saved', size, color, 'ascii', 'planning'); }
    } finally { host.close(); }
  }
  const restarted = await launch(size, color, 'ascii', 'planning', iconHome, { transient: 'nerd' });
  try {
    await restarted.waitForText('普通消息'); await shot(restarted, 'icon-restart-env-override', size, color, 'nerd', 'planning');
    const saved = JSON.parse(readFileSync(join(iconHome, 'orca-companion/tui-preferences.json'), 'utf8'));
    if (saved.iconMode !== 'ascii') throw new Error('transient icon environment override was persisted');
    writeFileSync(join(output, 'preference-verification.json'), JSON.stringify({ iconMode: saved.iconMode, transientOverridePersisted: false }, null, 2) + '\n');
    checks.push({ savedIcon: 'ascii', transientEnvironmentOverride: 'nerd', persistedOverride: false });
  } finally { restarted.close(); }

  writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
  writeFileSync(join(output, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
  process.stdout.write(`captured ${samples.length} samples into ${output}\n`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
