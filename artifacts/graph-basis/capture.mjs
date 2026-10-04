import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

const root = process.cwd();
const retiredHistoryOnly = process.argv.includes('--retired-history');
const basisPathOnly = process.argv.includes('--basis-path');
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = join(root, 'artifacts/graph-basis/screenshots', `${retiredHistoryOnly ? 'retired-history' : basisPathOnly ? 'basis-path' : 'capture'}-${runId}`);
const scratch = mkdtempSync(join(tmpdir(), 'orca-graph-basis-capture-'));
mkdirSync(output, { recursive: true });
const require = createRequire(join(root, 'package.json'));
const { launchTerminal } = await import(require.resolve('tuistory'));
const imagePath = createRequire(require.resolve('tuistory')).resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imagePath);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imagePath)));
const { displayWidth } = await import('../../dist/src/interfaces/tui/render/width.js');
const samples = [], operations = [];
const matrix = retiredHistoryOnly
  ? [[[120, 40], 'color', 'nerd']]
  : [[120, 40], [80, 24], [50, 40]].flatMap(size => ['color', 'no-color'].flatMap(color => ['nerd', 'ascii'].map(icons => [size, color, icons])));
if (process.argv.includes('--one')) matrix.splice(1);

function screen(session) {
  const data = session.getTerminalData();
  return data.lines.slice(-data.rows).map(line => line.spans.map(span => span.text).join('')).join('\n');
}
async function waitText(session, term, timeoutMs = 10000) {
  const deadline = Date.now() + Math.min(timeoutMs, 20000);
  while (Date.now() < deadline) {
    if (screen(session).replace(/\s+/gu, '').includes(term.replace(/\s+/gu, ''))) return;
    await delay(100);
  }
  throw new Error(`semantic timeout (${Math.min(timeoutMs, 20000)}ms): ${term}\n${screen(session)}`);
}
async function press(session, key) { await session.press(key); await delay(250); }
function textFile(lines) { return lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n'; }
async function shot(session, label, size, color, icons) {
  await delay(180);
  const data = session.getTerminalData(), lines = data.lines.slice(-data.rows);
  const stem = `${label}-${size[0]}x${size[1]}-${color}-${icons}`;
  const cells = { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span => Array.from(span.text, character => ({
    ...span, text: character, width: displayWidth(character),
    ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
  }))) })) };
  writeFileSync(join(output, `${stem}.txt`), textFile(lines));
  writeFileSync(join(output, `${stem}.png`), await renderTerminalToImage(cells));
  samples.push({ label, size, color, icons, png: `${stem}.png`, text: `${stem}.txt`, cursor: data.cursor });
  writeFileSync(join(output, 'samples.json'), JSON.stringify(samples, null, 2) + '\n');
}
function env(size, color, icons, configHome) {
  const value = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', FORCE_COLOR: color === 'color' ? '1' : '0',
    ORCA_COMPANION_PREVIEW_CONFIG_HOME: configHome, ORCA_COMPANION_TUI_ICONS: icons,
    ORCA_COMPANION_PREVIEW_RETIRED_HISTORY: retiredHistoryOnly ? '1' : '0' };
  if (color === 'no-color') value.NO_COLOR = '1'; else delete value.NO_COLOR;
  return value;
}
function log(name, size, color, icons, check) { operations.push({ name, size, color, icons, check }); }

try {
  for (const [size, color, icons] of matrix) {
    const configHome = mkdtempSync(join(scratch, 'config-'));
    const session = await launchTerminal({ command: process.execPath, cwd: root, cols: size[0], rows: size[1], env: env(size, color, icons, configHome),
      waitForData: false,
      args: ['artifacts/graph-basis/preview-runner.mjs'] });
    try {
      await waitText(session, '输入消息');
      await waitText(session, '请检查这次图历史');
      await shot(session, 'workspace-baseline', size, color, icons);
      log('六票工作区基线', size, color, icons, 'continuous 主区、composer、adaptive 图与状态栏可见');

      if (basisPathOnly) {
        await press(session, ['ctrl', 'b']);
        await waitText(session, '项目面板 · 总览');
        let workEntry = false;
        for (let row = 0; row < 12; row += 1) {
          const selected = screen(session).split('\n').find(line => line.includes('›') && line.includes('工作记录与依据')) ?? '';
          if (selected.includes('工作记录与依据')) { workEntry = true; break; }
          await press(session, 'down');
        }
        if (!workEntry) throw new Error(`project work entry is not selected\n${screen(session)}`);
        await press(session, 'enter');
        await waitText(session, '项目面板 · 总览 · 详情');
        await waitText(session, 'wp-');
        await shot(session, 'P51-project-work-detail', size, color, icons);
        await press(session, 'enter');
        await waitText(session, '执行依据与历史图');
        await shot(session, 'P51-project-to-graph-basis', size, color, icons);
        await press(session, 'down');
        await press(session, 'enter');
        await waitText(session, '依据来源目录');
        await shot(session, 'P43-project-basis-source-directory', size, color, icons);
        let routeMap = false;
        for (let row = 0; row < 20; row += 1) {
          const selected = screen(session).split('\n').find(line => line.includes('›') && line.includes('当前 Route Map')) ?? '';
          if (selected.includes('当前 Route Map')) { routeMap = true; break; }
          await press(session, 'down');
        }
        if (!routeMap) throw new Error(`current Route Map source is not selected\n${screen(session)}`);
        await press(session, 'enter');
        await waitText(session, '目标：完成图历史与执行依据阅读');
        await shot(session, 'P43-project-basis-body', size, color, icons);
        log('项目工作 → GraphBasis → 来源正文', size, color, icons, '生产项目面板、依据入口、Route Map 正文；内容由隔离 fixture 提供');
        for (const [width, height] of [[80, 24], [50, 40], [120, 40]]) {
          session.resize({ cols: width, rows: height }); await delay(260);
          if (!screen(session).includes('PgDn')) throw new Error(`basis reader footer missing after resize ${width}x${height}\n${screen(session)}`);
          await shot(session, `P43-project-basis-body-resize-from-${size.join('x')}`, [width, height], color, icons);
          log('项目依据正文 resize', [width, height], color, icons, '保留原来源与阅读位置；按新宽度重新排版');
        }
        const returnFrames = [];
        for (let layer = 0; layer < 4; layer += 1) {
          await press(session, 'esc');
          returnFrames.push(screen(session).split('\n').find(line => line.includes('项目面板 ·'))?.trim()
            ?? screen(session).split('\n').find(line => line.includes('执行依据'))?.trim()
            ?? screen(session).split('\n').find(line => line.includes('输入消息'))?.trim()
            ?? 'fixture frame');
        }
        if (!screen(session).includes('项目面板 · 总览') || screen(session).includes(' · 详情')) throw new Error(`Esc did not return to project overview\n${screen(session)}`);
        await press(session, ['ctrl', 'b']);
        await waitText(session, '输入消息');
        log('项目依据逐层 Esc 返回', size, color, icons, returnFrames.join(' → ') + ' → 工作区');
        process.stdout.write(`captured basis path ${size.join('x')} ${color} ${icons}\n`);
        continue;
      }

      session.writeRaw('/op');
      await waitText(session, '命令候选');
      await waitText(session, '/options');
      await shot(session, 'P47-slash-candidates', size, color, icons);
      await press(session, 'tab');
      await waitText(session, '普通消息');
      await shot(session, 'P47-slash-adopted', size, color, icons);
      await press(session, 'enter');
      await waitText(session, 'Nerd Fonts');
      await shot(session, 'P47-slash-executed-P52-options', size, color, icons);
      await press(session, 'esc');
      await waitText(session, '普通消息');
      log('P47 候选与 P52 图标设置', size, color, icons, '命令候选先采用，再以 Enter 执行；Esc 回到 composer');

      await press(session, ['ctrl', 'p']);
      await waitText(session, 'Command Palette · 命令目录');
      await shot(session, 'P52-command-directory', size, color, icons);
      await press(session, 'esc');
      await waitText(session, '普通消息');
      log('P52 命令目录与返回', size, color, icons, '固定弹层、候选/说明分栏及默认返回状态可见');

      await press(session, ['ctrl', 'b']);
      await waitText(session, '项目面板 · 总览');
      await shot(session, 'P51-project-overview', size, color, icons);
      await press(session, 'tab');
      await shot(session, 'P51-project-pending', size, color, icons);
      await press(session, 'tab');
      await shot(session, 'P51-project-events', size, color, icons);
      await press(session, ['ctrl', 'b']);
      await waitText(session, '普通消息');
      log('P51 项目面板栏目与返回', size, color, icons, '总览/待答/最近事件同一固定区域，关闭返回原工作区');

      await press(session, ['ctrl', 'g']);
      await waitText(session, '执行图检查');
      await shot(session, 'inspector-baseline', size, color, icons);
      log('P-43 Inspector 基线', size, color, icons, '保留图画布与 Inspector 原布局');
      await press(session, 'enter');
      await waitText(session, '完整记录');
      await press(session, 'enter');
      await waitText(session, '执行依据与历史图');
      if (retiredHistoryOnly) {
        await press(session, 'enter');
        await waitText(session, '图版本历史');
        for (let page = 0; page < 6 && !screen(session).includes('G1·v2 scope-1#g1'); page += 1) {
          await press(session, 'pagedown');
          await delay(500);
        }
        await waitText(session, 'G1·v2 scope-1#g1');
        let selected = false;
        for (let row = 0; row < 20; row += 1) {
          if (screen(session).split('\n').some(line => line.includes('›') && line.includes('G1·v2 scope-1#g1'))) { selected = true; break; }
          await press(session, 'down');
        }
        if (!selected) throw new Error(`retired version could not be selected after 20 Down keys\n${screen(session)}`);
        await press(session, 'enter');
        await waitText(session, '所选工作包 wp-d 不在本版本拓扑中');
        await shot(session, 'retired-work-package-historical-version', size, color, icons);
        log('退休包历史版本', size, color, icons, '隔离 SQLite fixture 中 G1·v2 的 accepted revision 明确退役 wp-d；非真实执行证据');
        continue;
      }
      await shot(session, 'basis-root', size, color, icons);
      await press(session, 'enter');
      await waitText(session, '图版本历史');
      await shot(session, 'all-generations-first-page', size, color, icons);
      log('全代际目录', size, color, icons, '真实 GraphBasisService/schema17 分页目录');
      await press(session, 'pagedown');
      await waitText(session, 'G1·v');
      await shot(session, 'all-generations-next-page', size, color, icons);
      log('目录翻页', size, color, icons, 'PgDn 取得后续版本且版本身份持续可见');

      await press(session, 'esc');
      await press(session, 'esc');
      await press(session, 'enter');
      await waitText(session, '执行依据与历史图');
      await press(session, 'down'); await press(session, 'enter');
      await waitText(session, '原始 Implementation Plan');
      await shot(session, 'current-source-directory', size, color, icons);
      await press(session, 'enter');
      await waitText(session, 'planRevision');
      await shot(session, 'plan-body-first-range', size, color, icons);
      await press(session, 'esc');
      await waitText(session, '依据来源目录');
      let routeMap = false;
      for (let row = 0; row < 20; row += 1) {
        if (screen(session).split('\n').some(line => line.includes('›') && line.includes('当前 Route Map'))) { routeMap = true; break; }
        await press(session, 'down');
      }
      if (!routeMap) throw new Error(`current Route Map source not found\n${screen(session)}`);
      await press(session, 'enter');
      await waitText(session, '目标：完成图历史与执行依据阅读');
      await shot(session, 'tracker-body-pinned-continuation', size, color, icons);
      log('计划与 tracker 正文', size, color, icons, '计划正文来源版本与当前 Route Map 来源身份分别可见；历史正文不可用时明确标示');

      for (const [width, height] of [[80, 24], [50, 40], [120, 40]]) {
        session.resize({ cols: width, rows: height }); await delay(220);
        await waitText(session, '路线图修订');
        await shot(session, 'basis-body-resize', [width, height], color, icons);
        log('正文 resize', [width, height], color, icons, '来源身份与偏移保留');
      }
      const returnFrames = [];
      for (let layer = 0; layer < 6 && !screen(session).includes('输入消息'); layer += 1) {
        await press(session, 'esc');
        returnFrames.push(screen(session).split('\n').find(line => line.includes('│'))?.trim() ?? screen(session).slice(0, 80));
      }
      if (!screen(session).includes('输入消息')) throw new Error(`Esc return did not reach workspace\n${screen(session)}`);
      log('逐层 Esc 返回', size, color, icons, returnFrames.join(' → '));
    } catch (error) {
      operations.push({ name: 'semantic-failure', size, color, icons, error: String(error) });
      await shot(session, 'failed-frame', size, color, icons);
      writeFileSync(join(output, 'operations.json'), JSON.stringify(operations, null, 2) + '\n');
      throw error;
    } finally { session.close(); }
    process.stdout.write(`captured ${size.join('x')} ${color} ${icons}\n`);
  }
  writeFileSync(join(output, 'operations.json'), JSON.stringify(operations, null, 2) + '\n');
  writeFileSync(join(output, 'capture-report.md'), [
    '# IP05 Graph Basis 画面采集', '',
    retiredHistoryOnly
      ? '状态：完成单配置历史退休记录截图。内容来自隔离合成 SQLite fixture，不代表真实 Worker 执行或业务验收。'
      : basisPathOnly
        ? '状态：项目工作入口到依据正文的补充生产画面采集完成。每张画面的业务状态与来源正文均来自明确隔离的 fixture；不证明真实 Worker、Orca 或用户项目事实。'
        : '状态：采集脚本已完成；此报告在全矩阵运行成功后由 capture.mjs 写入。',
    '证据入口：PNG、同名 PTY 文本、samples.json、operations.json。',
    `运行目录：${output}`,
  ].join('\n') + '\n');
  process.stdout.write(`captured ${samples.length} PNG/text pairs into ${output}\n`);
} finally {
  // 每个配置目录只用于预览偏好；采集产物不放在 scratch 中。
  const { rmSync } = await import('node:fs');
  rmSync(scratch, { recursive: true, force: true });
}
