import process from 'node:process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd();
const output = join(root, 'artifacts/project-statusline', process.argv[2] ?? 'supplement');
const scratch = mkdtempSync(join(tmpdir(), 'orca-statusline-supplement-'));
mkdirSync(output, { recursive: true });

const require = createRequire(join(root, 'package.json'));
const { launchTerminal } = await import(require.resolve('tuistory'));
const imageModule = createRequire(require.resolve('tuistory')).resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const { createTuiPreferencesStore } = await import('../../dist/src/adapters/storage/tui-preferences-store.js');

const samples = [];
const checks = [];
const operations = [];
const sizes = [[120, 40], [80, 24], [50, 40]];
const colors = ['color', 'no-color'];
const iconModes = ['nerd', 'ascii'];

function screen(session) {
  const data = session.getTerminalData();
  return data.lines.slice(-data.rows).map(line => line.spans.map(span => span.text).join('')).join('\n');
}

function semantic(name, value, terms) {
  const missing = terms.filter(term => !value.includes(term));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(', ')}`);
}

async function stable(session, name, predicate = () => true, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    const value = screen(session);
    if (predicate(value)) {
      count += 1;
      if (count >= 3) return value;
    } else count = 0;
    await delay(50);
  }
  throw new Error(`${name}: screen did not reach a stable expected state\n${screen(session)}`);
}

async function changed(session, key, name, predicate = () => true) {
  const previous = screen(session);
  await session.press(key);
  return stable(session, name, value => value !== previous && predicate(value));
}

function terminalEnv(configHome, phase, color, icons, { failSave = false, transientIcons = icons } = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    NODE_NO_WARNINGS: '1',
    FORCE_COLOR: color === 'color' ? '1' : '0',
    ORCA_COMPANION_PROJECT_STATUSLINE: '1',
    ORCA_COMPANION_PREVIEW_CONFIG_HOME: configHome,
    ORCA_COMPANION_PREVIEW_PHASE: phase,
    ORCA_COMPANION_TUI_ICONS: transientIcons ?? '',
  };
  if (transientIcons === null) delete env.ORCA_COMPANION_TUI_ICONS;
  if (color === 'no-color') env.NO_COLOR = '1';
  else delete env.NO_COLOR;
  if (failSave) env.ORCA_COMPANION_PREVIEW_SAVE_FAIL = '1';
  else delete env.ORCA_COMPANION_PREVIEW_SAVE_FAIL;
  return env;
}

async function launch(size, color, icons, phase, configHome, options = {}) {
  return launchTerminal({
    command: process.execPath,
    cwd: root,
    cols: size[0],
    rows: size[1],
    env: terminalEnv(configHome, phase, color, icons, options),
    args: ['scripts/tui-preview.mjs', 'alignment-planning'],
  });
}

async function capture(session, name, size, color, icons, state, extra = {}) {
  const value = await stable(session, `${name}/${state}`);
  const data = session.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  const stem = `${name}-${state}-${size[0]}x${size[1]}-${color}-${icons}`;
  const cells = {
    ...data,
    lines: lines.map(line => ({
      ...line,
      spans: line.spans.flatMap(span => Array.from(span.text, character => ({
        ...span,
        text: character,
        width: displayWidth(character),
        ...((span.flags & StyleFlags.INVERSE) !== 0
          ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' }
          : {}),
      }))),
    })),
  };
  writeFileSync(join(output, `${stem}.txt`), lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n');
  writeFileSync(join(output, `${stem}.png`), await renderTerminalToImage(cells));
  samples.push({ name, state, size, color, icons, png: `${stem}.png`, text: `${stem}.txt`, cursor: data.cursor, ...extra });
  return value;
}

async function openCommand(session, query, name, expected) {
  await changed(session, ['ctrl', 'p'], `${name}: open command directory`, value => value.includes('Command Palette · 命令目录'));
  operations.push({ action: 'open-command-directory', query });
  if (query) {
    await session.writeRaw(query);
    await stable(session, `${name}: find command`, expected instanceof Function ? expected : value => value.includes(expected));
    operations.push({ action: 'filter-command-directory', query });
  }
  await changed(session, 'enter', `${name}: execute directory selection`, expected instanceof Function ? expected : value => value.includes(expected));
  operations.push({ action: 'execute-command', query });
}

async function openStatusline(session, name) {
  await changed(session, ['ctrl', 'p'], `${name}: open command directory`, value => value.includes('Command Palette · 命令目录'));
  operations.push({ action: 'open-command-directory', command: 'statusline' });
  await session.writeRaw('statusline');
  await stable(session, `${name}: statusline candidate`, value => value.includes('状态栏设置'));
  await changed(session, 'enter', `${name}: open statusline editor`, value => value.includes('状态栏 · ↑↓选择') && value.includes('Enter 保存'));
  operations.push({ action: 'open-statusline-settings' });
}

function writeJson(name, value) {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
}

async function waitForPreference(store, name, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await store.load();
    if (result.kind === 'loaded' && predicate(result.preferences)) return result;
    await delay(50);
  }
  throw new Error(`${name}: preference store did not reach the expected value`);
}

try {
  // Graph Inspector, command directory, and slash adopt/execute/return: full 3×2×2 matrix.
  for (const size of sizes) for (const color of colors) for (const icons of iconModes) {
    const configHome = mkdtempSync(join(scratch, 'matrix-'));
    const session = await launch(size, color, icons, 'execution', configHome);
    const tuple = `${size[0]}x${size[1]}-${color}-${icons}`;
    try {
      await stable(session, `matrix ${tuple} workspace`, value => value.includes('普通消息'));

      await changed(session, ['ctrl', 'g'], `Inspector ${tuple}`, value => value.includes('执行图检查 · Graph Inspector'));
      semantic(`Inspector ${tuple}`, screen(session), ['执行图检查 · Graph Inspector', 'G1 v3', '节点']);
      await capture(session, 'graph-inspector', size, color, icons, 'open');
      await changed(session, 'esc', `Inspector return ${tuple}`, value => value.includes('普通消息'));

      await changed(session, ['ctrl', 'p'], `Command directory ${tuple}`, value => value.includes('Command Palette · 命令目录'));
      await capture(session, 'command-directory', size, color, icons, 'open');
      await changed(session, 'esc', `Command directory return ${tuple}`, value => value.includes('普通消息'));

      await session.writeRaw('/op');
      const candidates = await stable(session, `slash candidates ${tuple}`, value => value.includes('命令候选') && value.includes('/options'));
      semantic(`slash candidate list ${tuple}`, candidates, ['/options']);
      await capture(session, 'slash-candidates', size, color, icons, 'before-adopt');

      const adopted = await changed(session, 'tab', `slash adopt ${tuple}`, value => value.includes('/options') && !value.includes('命令候选'));
      semantic(`slash adopted alias ${tuple}`, adopted, ['/options', '普通消息']);
      await capture(session, 'slash-candidates', size, color, icons, 'adopted');

      const executed = await changed(session, 'enter', `slash execute ${tuple}`, value => value.includes('当前图标'));
      semantic(`slash execution ${tuple}`, executed, ['ASCII', 'Nerd Fonts']);
      await capture(session, 'slash-candidates', size, color, icons, 'executed-options');

      await changed(session, 'esc', `slash return ${tuple}`, value => value.includes('普通消息'));
      await capture(session, 'slash-candidates', size, color, icons, 'returned');
      operations.push({ tuple, sequence: ['Ctrl+G Inspector', 'Esc', 'Ctrl+P command directory', 'Esc', '/op', 'Tab adopt /options', 'Enter execute', 'Esc return'] });
      checks.push({ tuple, graphInspector: true, commandDirectory: true, slashCandidate: true, adoptedBeforeExecution: true, returnedToWorkspace: true });
    } finally { session.close(); }
  }

  // Approved authorization details: 20-item page, UTF-8 continuation, PgDn and resize.
  {
    const size = [120, 40], color = 'color', icons = 'nerd';
    const configHome = mkdtempSync(join(scratch, 'authorization-'));
    const session = await launch(size, color, icons, 'execution', configHome);
    try {
      await stable(session, 'authorization workspace', value => value.includes('普通消息'));
      await changed(session, ['ctrl', 'b'], 'open execution project panel', value => value.includes('项目面板 · 总览'));
      await changed(session, 'down', 'select budget and authorization', value => value.includes('预算与授权'));
      await changed(session, 'enter', 'open approved authorization details', value => value.includes('批准字段 1') && value.includes('PgDn 读取后续字段'));
      semantic('approved authorization page one', screen(session), ['已批准授权', '批准字段 1', 'PgDn 读取后续字段']);
      await capture(session, 'approved-authorization', size, color, icons, 'page-1');
      operations.push({ action: 'project-budget-authorization', page: 1, key: 'Enter' });

      const pageTwo = await changed(session, 'pagedown', 'authorization UTF-8 continuation', value => value.includes('长授权字段') && value.includes('中文🙂授权说明'));
      semantic('approved authorization page two', pageTwo, ['长授权字段', '中文🙂授权说明']);
      await capture(session, 'approved-authorization', size, color, icons, 'utf8-page-2');
      operations.push({ action: 'page-down', detail: 'approved authorization', continuation: 'long UTF-8 value' });

      let currentSize = size;
      for (const nextSize of [[80, 24], [50, 40], [120, 40]]) {
        session.resize({ cols: nextSize[0], rows: nextSize[1] });
        await stable(session, `authorization resize ${nextSize[0]}x${nextSize[1]}`,
          value => session.getTerminalData().cols === nextSize[0] && value.includes('长授权字段') && value.includes('中文🙂授权说明'));
        await capture(session, 'approved-authorization', nextSize, color, icons, `utf8-resize-from-${currentSize[0]}`);
        operations.push({ action: 'resize', from: currentSize, to: nextSize, page: 2 });
        currentSize = nextSize;
      }

      const pageThree = await changed(session, 'pagedown', 'authorization next UTF-8 page', value => value.includes('长授权字段') && value.includes('中文🙂授权说明'));
      await capture(session, 'approved-authorization', currentSize, color, icons, 'utf8-page-3');
      checks.push({ approvedAuthorization: true, boundedPagination: true, utf8Continuation: true, resizeRetainedObject: true, nextPage: pageThree.includes('长授权字段') });
      operations.push({ action: 'page-down', detail: 'approved authorization', continuation: 'next UTF-8 range' });
    } finally { session.close(); }
  }

  // A real second storage adapter advances the shared revision while the editor is open.
  {
    const size = [120, 40], color = 'color', icons = 'nerd';
    const configHome = mkdtempSync(join(scratch, 'cas-'));
    const otherWriter = createTuiPreferencesStore({ configHome });
    const initial = await otherWriter.load();
    if (initial.kind !== 'loaded' || !initial.writable) throw new Error('CAS fixture store did not load as writable');
    const session = await launch(size, color, icons, 'planning', configHome);
    try {
      await stable(session, 'CAS workspace', value => value.includes('普通消息'));
      await openStatusline(session, 'CAS');
      await changed(session, 'down', 'CAS select effort row');
      await changed(session, 'down', 'CAS select context row');
      await changed(session, 'right', 'CAS edit retained statusline draft');
      await capture(session, 'preferences-cas', size, color, icons, 'draft-before-conflict');
      operations.push({ action: 'edit-statusline-draft', field: 'contextFormat', operation: 'right-arrow' });

      const external = await otherWriter.save({
        expectedRevision: initial.preferences.revision,
        patch: { kind: 'icons', iconMode: 'ascii' },
      });
      if (external.kind !== 'saved') throw new Error(`Second real preferences writer failed: ${external.kind}`);
      operations.push({ action: 'second-storage-writer', result: external.kind, revision: external.preferences.revision, patch: 'icons/ascii' });

      await changed(session, 'enter', 'CAS conflict keeps statusline editor open', value => value.includes('偏好已在其他进程更新；草稿保留，再按 Enter 明确保存'));
      semantic('CAS conflict', screen(session), ['状态栏 · ↑↓选择', '偏好已在其他进程更新', 'Enter 明确保存']);
      await capture(session, 'preferences-cas', size, color, icons, 'conflict-draft-retained');
      operations.push({ action: 'explicit-statusline-save', result: 'conflict', retry: 'user Enter required' });

      await changed(session, 'enter', 'CAS explicit retry returns to workspace', value => value.includes('普通消息') && !value.includes('状态栏 · ↑↓选择'));
      const persisted = await otherWriter.load();
      if (persisted.kind !== 'loaded' || persisted.preferences.revision !== 2 || persisted.preferences.iconMode !== 'ascii' || persisted.preferences.statusline.contextFormat !== 'remaining') {
        throw new Error(`CAS retry did not preserve and save the edited statusline: ${JSON.stringify(persisted)}`);
      }
      await capture(session, 'preferences-cas', size, color, icons, 'explicit-retry-return');
      checks.push({ realSecondStore: true, conflictShown: true, draftRetained: true, explicitEnterRetry: true, finalRevision: persisted.preferences.revision });
      operations.push({ action: 'explicit-statusline-save', result: 'saved', revision: persisted.preferences.revision, retainedContextFormat: 'remaining' });
    } finally { session.close(); }
  }

  // Failed saves stay visible at all three approved terminal sizes.
  for (const [index, size] of sizes.entries()) {
    const color = index === 1 ? 'no-color' : 'color';
    const icons = index === 2 ? 'ascii' : 'nerd';
    const configHome = mkdtempSync(join(scratch, `failed-${size[0]}x${size[1]}-`));
    const session = await launch(size, color, icons, 'planning', configHome, { failSave: true });
    try {
      await stable(session, `failed save workspace ${size[0]}x${size[1]}`, value => value.includes('普通消息'));
      await openStatusline(session, `failed save ${size[0]}x${size[1]}`);
      await session.press('enter');
      const failure = await stable(session, `statusline save failure ${size[0]}x${size[1]}`, value => value.includes('fixture_write_failed'));
      semantic(`statusline save failure ${size[0]}x${size[1]}`, failure, ['状态栏 · ↑↓选择', 'fixture_write_failed']);
      await capture(session, 'statusline-save-failed', size, color, icons, 'draft-retained');
      checks.push({ kind: 'statusline-save-failure', size, color, icons, draftRetained: true });
      operations.push({ action: 'statusline-save', result: 'fixture port rejected', size, terminalState: 'editor remains open' });
    } finally { session.close(); }
  }

  // Persist ASCII, leave the icon parent overlay with Esc, then restart with no env override.
  {
    const size = [120, 40], color = 'color';
    const configHome = mkdtempSync(join(scratch, 'icon-restart-'));
    const store = createTuiPreferencesStore({ configHome });
    const first = await launch(size, color, 'nerd', 'planning', configHome);
    try {
      await stable(first, 'icon save workspace', value => value.includes('普通消息'));
      await changed(first, ['ctrl', 'p'], 'open icon command directory', value => value.includes('Command Palette · 命令目录'));
      await first.writeRaw('icons-ascii');
      await stable(first, 'ASCII command selection', value => value.includes('ASCII'));
      await first.press('enter');
      const disk = await waitForPreference(store, 'save ASCII icon mode', preferences => preferences.iconMode === 'ascii');
      await changed(first, 'esc', 'leave parent command overlay', value => value.includes('普通消息'));
      await capture(first, 'icon-preference', size, color, 'ascii', 'saved-workspace');
      operations.push({ action: 'save-icons-ascii', result: 'saved', revision: disk.preferences.revision, then: 'Esc to workspace' });
    } finally { first.close(); }

    const restarted = await launch(size, color, 'nerd', 'planning', configHome, { transientIcons: null });
    try {
      await stable(restarted, 'icon restart workspace', value => value.includes('普通消息'));
      await changed(restarted, ['ctrl', 'p'], 'icon restart open command directory', value => value.includes('Command Palette · 命令目录'));
      await restarted.writeRaw('options');
      await stable(restarted, 'icon restart options command', value => value.includes('选项'));
      const options = await changed(restarted, 'enter', 'icon restart options overlay', value => value.includes('ASCII') && value.includes('Nerd Fonts'));
      semantic('saved icon restored without environment override', options, ['› ASCII', 'Nerd Fonts']);
      await capture(restarted, 'icon-preference', size, color, 'ascii', 'restart-no-env-override');
      checks.push({ savedIcon: 'ascii', restartHadNoEnvironmentOverride: true, restoredSelection: 'ascii' });
      operations.push({ action: 'restart', environmentIconOverride: null, restoredIcon: 'ascii' });
    } finally { restarted.close(); }
  }

  // Icon save failure is visible in both the options overlay and the workspace risk area.
  {
    const size = [50, 40], color = 'color';
    const configHome = mkdtempSync(join(scratch, 'icon-save-failure-'));
    const store = createTuiPreferencesStore({ configHome });
    const failed = await launch(size, color, 'nerd', 'planning', configHome, { failSave: true });
    try {
      await stable(failed, 'icon failure workspace', value => value.includes('普通消息'));
      await changed(failed, ['ctrl', 'p'], 'icon failure open command directory', value => value.includes('Command Palette · 命令目录'));
      await failed.writeRaw('options');
      await stable(failed, 'icon failure options candidate', value => value.includes('选项'));
      await changed(failed, 'enter', 'icon failure options overlay', value => value.includes('ASCII') && value.includes('Nerd Fonts'));
      await changed(failed, 'down', 'select ASCII icon option');
      await failed.press('enter');
      const failure = await stable(failed, 'icon save failure remains visible in options', value => value.includes('未保存') || value.includes('fixture_write_failed'));
      semantic('icon save failure options', failure, ['ASCII', '未保存']);
      await capture(failed, 'icon-save-failed', size, color, 'nerd', 'options-unsaved');
      await changed(failed, 'esc', 'icon failure return to command directory', value => value.includes('Command Palette · 命令目录'));
      await changed(failed, 'esc', 'icon failure return to workspace', value => value.includes('普通消息') && value.includes('图标已切换但未保存'));
      await capture(failed, 'icon-save-failed', size, color, 'nerd', 'workspace-notice');
      const persisted = await store.load();
      if (persisted.kind !== 'loaded' || persisted.preferences.iconMode !== 'nerd') throw new Error('Failed icon save unexpectedly changed persisted preference');
      checks.push({ iconSaveFailure: true, failureVisibleInOptions: true, failureVisibleInWorkspace: true, unsavedSelectionRetained: true, persistedIcon: 'nerd' });
      operations.push({ action: 'save-icons-ascii', result: 'rejected by fixture port', retry: 'reselect and press Enter' });
    } finally { failed.close(); }

    const retry = await launch(size, color, 'nerd', 'planning', configHome);
    try {
      await stable(retry, 'icon retry workspace', value => value.includes('普通消息'));
      await changed(retry, ['ctrl', 'p'], 'icon retry open command directory', value => value.includes('Command Palette · 命令目录'));
      await retry.writeRaw('options');
      await stable(retry, 'icon retry options candidate', value => value.includes('选项'));
      await changed(retry, 'enter', 'icon retry options overlay', value => value.includes('ASCII') && value.includes('Nerd Fonts'));
      await changed(retry, 'down', 'icon retry select ASCII');
      await retry.press('enter');
      const saved = await stable(retry, 'icon retry explicit save', value => value.includes('ASCII') && !value.includes('未保存'));
      semantic('icon explicit retry', saved, ['ASCII']);
      const persisted = await waitForPreference(store, 'icon retry explicit save', preferences => preferences.iconMode === 'ascii');
      await capture(retry, 'icon-save-failed', size, color, 'ascii', 'explicit-retry');
      checks.push({ iconSaveRetry: true, explicitReselection: true, persistedIcon: 'ascii' });
      operations.push({ action: 'retry-icon-save', result: 'saved', revision: persisted.preferences.revision });
    } finally { retry.close(); }
  }

  // Statusline save under a transient ASCII override must leave persisted iconMode untouched.
  {
    const size = [80, 24], color = 'no-color', transientIcons = 'ascii';
    const configHome = mkdtempSync(join(scratch, 'statusline-env-override-'));
    const store = createTuiPreferencesStore({ configHome });
    const session = await launch(size, color, 'nerd', 'planning', configHome, { transientIcons });
    try {
      await stable(session, 'transient override workspace', value => value.includes('普通消息'));
      await openStatusline(session, 'transient icon override statusline save');
      await changed(session, 'down', 'transient override select effort');
      await changed(session, 'down', 'transient override select context');
      await changed(session, 'right', 'transient override edit context format');
      await capture(session, 'statusline-env-icon-override', size, color, transientIcons, 'draft');
      const savedScreen = await changed(session, 'enter', 'statusline saves without persisting env icon override', value => value.includes('普通消息'));
      semantic('statusline save return', savedScreen, ['普通消息']);
      const stored = await store.load();
      if (stored.kind !== 'loaded' || stored.preferences.iconMode !== 'nerd' || stored.preferences.statusline.contextFormat !== 'remaining') {
        throw new Error(`Statusline-only save persisted transient icon override or lost statusline edit: ${JSON.stringify(stored)}`);
      }
      await capture(session, 'statusline-env-icon-override', size, color, transientIcons, 'saved-workspace');
      checks.push({ statuslinePatchOnly: true, transientEnvironmentIcon: 'ascii', persistedIcon: stored.preferences.iconMode, statuslineSaved: true });
      operations.push({ action: 'save-statusline-with-transient-icon-override', environmentIcon: 'ascii', persistedIcon: stored.preferences.iconMode, revision: stored.preferences.revision });
    } finally { session.close(); }

    const restarted = await launch(size, color, 'nerd', 'planning', configHome, { transientIcons: null });
    try {
      await stable(restarted, 'statusline-only restart workspace', value => value.includes('普通消息'));
      await changed(restarted, ['ctrl', 'p'], 'statusline-only restart command directory', value => value.includes('Command Palette · 命令目录'));
      await restarted.writeRaw('options');
      await stable(restarted, 'statusline-only restart options candidate', value => value.includes('选项'));
      const options = await changed(restarted, 'enter', 'statusline-only restart options', value => value.includes('ASCII') && value.includes('Nerd Fonts'));
      semantic('statusline save did not persist environment icon override', options, ['› Nerd Fonts', 'ASCII']);
      await capture(restarted, 'statusline-env-icon-override', size, color, 'nerd', 'restart-no-env-override');
      operations.push({ action: 'restart-after-statusline-only-save', environmentIconOverride: null, restoredIcon: 'nerd' });
    } finally { restarted.close(); }
  }

  // The answer probe writes evidence only when the actual bound answer composer is mounted.
  for (const size of sizes) {
    const color = 'color', icons = 'nerd';
    const configHome = mkdtempSync(join(scratch, `answer-${size[0]}x${size[1]}-`));
    const session = await launch(size, color, icons, 'answer', configHome);
    try {
      await stable(session, `answer probe workspace ${size[0]}x${size[1]}`, value => value.includes('普通消息'));
      await openCommand(session, 'answer', `answer probe ${size[0]}x${size[1]}`, value => value.includes('待答') || value.includes('回答'));
      const answer = await stable(session, `bound answer composer ${size[0]}x${size[1]}`,
        value => value.includes('› 回答 1/') && value.includes('请确认中文路径'));
      semantic(`bound answer interaction ${size[0]}x${size[1]}`, answer, ['› 回答 1/', '请确认中文路径', '继续', '稍后']);
      if (answer.includes('› 普通消息')) throw new Error('Answer probe resolved to the ordinary message composer');
      await capture(session, 'answer-composer-bound', size, color, icons, 'interaction-answer-panel', { interaction: 'current pending question and choices visible' });
      checks.push({ answerComposer: true, size, interactionQuestionAndChoicesVisible: true, ordinaryComposerRejected: true });
      operations.push({ action: 'open-answer-command', result: 'current bound interaction panel shown', size });
    } finally { session.close(); }
  }

  writeJson('samples.json', samples);
  writeJson('checks.json', checks);
  writeJson('operations.json', operations);
  process.stdout.write(`captured ${samples.length} supplemental PTY screens into ${output}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
