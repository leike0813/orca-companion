/** Throwaway #52: exercise the revised dialog flows in a real PTY. Run pnpm build first. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { launchTerminal } from 'tuistory';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sizes = [[120, 40], [80, 24], [50, 40]];
const capture = process.argv.includes('--capture');
const graphOnly = process.argv.includes('--graph-only');
const fromTuistory = createRequire(createRequire(import.meta.url).resolve('tuistory'));
const { renderTerminalToImage } = await import(fromTuistory.resolve('ghostty-opentui/image'));
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(fromTuistory.resolve('ghostty-opentui/image'))));
async function frame(s) {
  await s.text();
  const data = s.getTerminalData();
  return data.lines.slice(-data.rows).map((line) => line.spans.map((span) => span.text).join('').trimEnd()).join('\n');
}
async function tap(s, key) { await s.press(key); return frame(s); }
async function settled(s, predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const text = await frame(s);
    if (predicate(text)) return text;
    await sleep(50);
  }
  assert.fail('画面未收敛：\n' + await frame(s));
}
async function run(scene, size, body, color = false, standalone = false) {
  const env = { ...process.env, FORCE_COLOR: color ? '1' : '0', TERM: 'xterm-256color' };
  if (color) delete env.NO_COLOR;
  else env.NO_COLOR = '1';
  const s = await launchTerminal({ command: process.execPath, args: standalone ? ['scripts/tui-preview.mjs', '--graph-prototype', scene, 'adaptive'] : ['scripts/tui-preview.mjs', '--dialog-prototype', scene],
    cwd: root, cols: size[0], rows: size[1], env });
  try { await frame(s); await body(s); } finally { s.close(); }
}
async function command(s, query) { await tap(s, ['ctrl', 'p']); await s.type(query); return tap(s, 'enter'); }
async function confirm(s) { await tap(s, 'right'); return tap(s, 'enter'); }
async function applyModel(s) {
  const noEffort = /此模型不支持|Effort\s+不适用/.test(await frame(s));
  await tap(s, 'enter');
  if (!noEffort) await tap(s, 'enter');
  return tap(s, 'enter');
}
function inverse(s, token) {
  return s.getTerminalData().lines.slice(-s.getTerminalData().rows).some((line) => line.spans.some((span) => span.text.includes(token) && (span.flags & StyleFlags.INVERSE) !== 0));
}
async function dismiss(s) {
  for (let step = 0; step < 6; step++) {
    if (/原型 .* · [a-z]+ · 对话 · 滚动/.test(await frame(s))) return;
    await tap(s, 'esc');
  }
  assert.fail('Esc 应逐层返回对话');
}
async function shot(s, name, size) {
  const text = await frame(s);
  assert(text.split('\n').every((line) => displayWidth(line) <= size[0]), '画面超宽');
  if (!capture) return;
  const path = new URL(`refined-${name}-${size.join('x')}`, import.meta.url);
  writeFileSync(fileURLToPath(path) + '.txt', text + '\n');
  const data = s.getTerminalData();
  // Fixed ASCII/CJK fixtures: separate cells so SVG font shaping preserves terminal column alignment.
  const cells = { ...data, lines: data.lines.slice(-data.rows).map((line) => ({ ...line,
    spans: line.spans.flatMap((span) => Array.from(span.text, (text) => ({ ...span, text, width: displayWidth(text),
      // The rasterizer swaps inverse spans before resolving default colors.
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
    }))),
  })) };
  writeFileSync(fileURLToPath(path) + '.png', await renderTerminalToImage(cells, { format: 'png' }));
}
const sessionOf = (text) => text.match(/orca-c\/main · (S-[AB])/)?.[1];

if (!graphOnly) {
await run('planning', sizes[0], async (s) => {
  await s.type('draft-A-中文'); await tap(s, 'pageup');
  await tap(s, ['ctrl', 's']); await tap(s, 'down');
  assert((await frame(s)).includes('会话信息'));
  const cancelled = await tap(s, 'esc');
  assert.equal(sessionOf(cancelled), 'S-A');
  assert(cancelled.includes('draft-A-中文') && cancelled.includes('滚动2'));
  await tap(s, ['ctrl', 's']); await s.type('S-B'); await tap(s, 'enter');
  assert.equal(sessionOf(await frame(s)), 'S-B');
  await s.type('draft-B');
  await tap(s, ['ctrl', 's']); await s.type('S-A'); await tap(s, 'enter');
  const back = await frame(s);
  assert(back.includes('draft-A-中文') && back.includes('滚动2') && !back.includes('draft-B'));
});
process.stdout.write('✓ 会话摘要分界、选择取消与草稿/滚动隔离\n');

await run('planning', sizes[0], async (s) => {
  await s.type('keep-composer');
  await command(s, 'model');
  const grid = await settled(s, (t) => t.includes('Execution') && t.includes('Finalizer'));
  assert(grid.includes('Planning') && grid.includes('openai') && grid.includes('high'));
  await tap(s, 'enter'); await s.type('config-b'); await applyModel(s);
  assert((await frame(s)).includes('Coordinator 已选择'));
  await tap(s, 'down'); await tap(s, 'down'); // Planner
  await tap(s, 'enter'); await s.type('config-b');
  const menu = await frame(s);
  assert(menu.split('\n').filter((line) => line.includes('openai /')).every((line) => !/low|medium|high/.test(line)), '模型候选行不包含 effort');
  await tap(s, 'enter'); // move to effort
  assert((await frame(s)).includes('当前区域：Effort'));
  await tap(s, 'right'); // B only supports low/medium, wrap medium -> low
  assert(inverse(s, '[low]') && !inverse(s, '[medium]'));
  assert(!(await frame(s)).includes('[high]'));
  await tap(s, 'enter'); assert(inverse(s, '应用选择')); await tap(s, 'enter');
  const changed = await frame(s);
  assert(/Planner\s+openai \/ 示例模型 B \/ low/.test(changed));
  assert(/Implementation\s+openai \/ 示例模型 A \/ high/.test(changed));
  await tap(s, 'enter'); assert(inverse(s, '[low]')); await s.type('config-rejected'); await applyModel(s);
  assert((await frame(s)).includes('被拒绝'));
  await tap(s, 'esc'); await tap(s, 'esc');
  assert((await frame(s)).includes('Command Palette') && (await frame(s)).includes('搜索 › model'));
  await tap(s, 'esc');
  assert((await frame(s)).includes('示例模型 B · 推理 medium') && (await frame(s)).includes('keep-composer'));
  await command(s, 'model'); await tap(s, 'down'); await tap(s, 'down');
  assert(/Planner\s+openai \/ 示例模型 B \/ low/.test(await frame(s)));
  await tap(s, 'enter'); await s.type('config-basic');
  assert((await frame(s)).includes('此模型不支持'));
  await tap(s, 'tab'); assert((await frame(s)).includes('当前区域：操作按钮'));
  await tap(s, 'right'); await tap(s, 'enter');
  assert(/Planner\s+example \/ 示例模型 D \/ 不支持 effort/.test(await frame(s)));
  await tap(s, 'enter'); await tap(s, ['ctrl', 'u']); await applyModel(s);
  assert((await frame(s)).includes('模型清单不可读'));
}, true);
process.stdout.write('✓ 独立模型/effort、能力选项、无 effort、拒绝/不可读与配置隔离\n');
await run('planning', sizes[0], async (s) => {
  await command(s, 'Cancel'); assert((await frame(s)).includes('当前操作：返回'));
  await tap(s, 'right'); assert((await frame(s)).includes('当前操作：停止整个项目'));
  await tap(s, 'esc'); await tap(s, 'esc'); await command(s, 'model'); await tap(s, 'enter');
  assert((await frame(s)).includes('effort high'));
  await tap(s, 'enter'); await tap(s, 'left'); assert((await frame(s)).includes('Effort · medium'));
});
process.stdout.write('✓ NO_COLOR 下当前动作与 effort 仍可辨认\n');

for (const size of sizes) {
  await run('answer', size, async (s) => {
    await s.type('event-draft'); await tap(s, ['ctrl', 's']); await s.type('S-B');
    await shot(s, 'sessions', size); await tap(s, ['ctrl', 'n']);
    assert.equal(sessionOf(await frame(s)), 'S-A');
    for (const [cols, rows] of sizes) {
      s.resize({ cols, rows });
      await settled(s, (t) => t.includes('会话选择') && t.includes('搜索 › S-B') && t.split('\n').every((line) => displayWidth(line) <= cols));
    }
    assert((await tap(s, 'esc')).includes('event-draft'));
  });
  await run('planning', size, async (s) => {
    await s.type('origin-draft'); await tap(s, ['ctrl', 'b']); await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'enter');
    await settled(s, (t) => t.includes('Execution Authorization') && t.includes('执行计划'));
    assert(inverse(s, '返回'));
    await shot(s, 'authorization-overview', size);
    for (const name of ['permissions', 'budget', 'scope', 'full']) {
      await tap(s, 'tab'); await shot(s, 'authorization-' + name, size);
    }
    let last = await frame(s);
    for (let page = 0; page < 8 && !last.includes('Fingerprint'); page++) last = await tap(s, 'pagedown');
    assert(last.includes('Fingerprint'), '完整清单应能滚动到批准绑定身份');
    const back = await tap(s, 'enter'); // default is Return, never approve
    assert(back.includes('项目面板 · 总览') && /›.*查看候选授权/.test(back));
    await tap(s, 'enter'); await settled(s, (t) => t.includes('执行计划')); await confirm(s);
    assert((await frame(s)).includes('项目面板 · 总览'));
    await tap(s, ['ctrl', 'b']); assert((await frame(s)).includes('origin-draft'));
  }, true);
  await run('planning', size, async (s) => {
    await tap(s, ['ctrl', 'p']); await shot(s, 'commands', size);
    await s.type('model'); await tap(s, 'enter');
    await shot(s, 'models', size);
    for (let index = 0; index < 8; index++) {
      await tap(s, 'enter'); await shot(s, 'model-menu-' + index, size);
      if (index === 2) { await tap(s, 'enter'); await shot(s, 'model-effort', size); }
      await tap(s, 'esc');
      if (index < 7) await tap(s, 'down');
    }
    await dismiss(s); await command(s, 'Handoff');
    assert((await frame(s)).includes('选择交接接收方'));
    await shot(s, 'handoff-target', size); await tap(s, 'enter');
    await shot(s, 'handoff-overview', size);
    await tap(s, 'tab'); await shot(s, 'handoff-responsibilities', size);
    await tap(s, 'tab'); await shot(s, 'handoff-binding', size);
    await tap(s, 'enter'); assert((await frame(s)).includes('选择交接接收方'));
    await tap(s, 'enter'); await confirm(s);
    assert((await frame(s)).includes('模拟规划交接已记录'));
    await command(s, 'Cancel'); await shot(s, 'cancel', size); await tap(s, 'tab'); await shot(s, 'cancel-identity', size);
    assert(inverse(s, '返回'));
    await tap(s, 'enter'); assert((await frame(s)).includes('Command Palette'));
    await tap(s, 'enter'); await tap(s, 'right'); assert(inverse(s, '停止整个项目') && !inverse(s, '返回'));
    await shot(s, 'cancel-confirm', size); await tap(s, 'enter'); assert((await frame(s)).includes('模拟意图已记录'));
    await tap(s, ['ctrl', 'c']); await shot(s, 'exit', size); await tap(s, 'enter');
    assert(/原型 .* · planning · 对话/.test(await frame(s)));
    await tap(s, ['ctrl', 'c']); await confirm(s); assert(await s.waitForExit(5000)); assert.equal(s.exitInfo?.exitCode, 0);
  }, true);
}
process.stdout.write('✓ 三档尺寸：连续 resize、授权栏目、8 个角色菜单、交接/取消/退出及返回\n');

for (const scene of ['execution', 'blocked']) {
  await run(scene, sizes[0], async (s) => {
    await command(s, 'model'); await tap(s, 'enter'); await applyModel(s);
    assert((await frame(s)).includes('未挂起') || (await frame(s)).includes('在途'));
    await dismiss(s); await command(s, 'Execution Handoff'); await tap(s, 'enter'); await confirm(s);
    assert((await frame(s)).includes(scene === 'blocked' ? '不可确认' : '模拟执行交接已记录'));
  });
}
process.stdout.write('✓ Coordinator 准入、执行交接与不可核验阻止确认\n');
}

for (const size of sizes) {
  await run('execution', size, async (s) => {
    await s.type('graph-draft');
    await shot(s, 'graph-sidebar', size);
    if (size[0] >= 60) assert((await frame(s)).includes('依赖关系') && !(await frame(s)).includes('执行依据'));
    await command(s, '执行图检查');
    const graph = await frame(s);
    assert(graph.includes('依赖关系') && graph.includes('执行依据') && graph.includes('工作区') && graph.includes('验证'));
    assert(/[◐◓◑◒◉]12/.test(graph), '图形视窗应保留所选节点');
    await shot(s, 'graph-inspector-execution', size);
    await tap(s, 'tab'); assert((await frame(s)).includes('包含') && (await frame(s)).includes('排除'));
    await shot(s, 'graph-inspector-scope', size);
    await tap(s, 'tab'); assert((await frame(s)).includes('基线'));
    await shot(s, 'graph-inspector-identity', size);
    await tap(s, 'down'); await tap(s, 'left'); await tap(s, 'enter');
    assert((await frame(s)).includes('ID：'));
    await tap(s, 'esc'); assert((await frame(s)).includes('完整身份'));
    for (const [cols, rows] of sizes) {
      s.resize({ cols, rows });
      await settled(s, (t) => t.includes('完整身份') && t.includes('基线') && t.split('\n').every((line) => displayWidth(line) <= cols));
    }
    await tap(s, ['ctrl', 'n']); await tap(s, 'esc');
    assert((await frame(s)).includes('graph-draft'));
  }, true);
}
process.stdout.write('✓ 三档图节点卡片、全屏扩展信息、依赖导航/返回与连续 resize\n');
for (const size of sizes) {
  await run('execution', size, async (s) => {
    await settled(s, (text) => size[0] < 60 ? text.includes('sidebar collapsed') : text.includes('依赖关系') && text.includes('后继'));
    await shot(s, 'graph-adaptive', size);
    if (size[0] >= 60) {
      await tap(s, 'j'); await tap(s, 'tab'); await tap(s, 'k'); await tap(s, 'f');
      assert((await frame(s)).includes('12 Composer'));
    }
    for (const [cols, rows] of sizes) {
      s.resize({ cols, rows });
      await settled(s, (text) => (cols < 60 ? text.includes('sidebar collapsed') : text.includes('依赖关系') && text.includes('后继')) && text.split('\n').every((line) => displayWidth(line) <= cols));
    }
  }, true, true);
}
process.stdout.write('✓ 执行图原型联动：节点焦点、横向切换、折叠与三档 resize\n');
process.stdout.write('完成：有色/无色真实 PTY 行为检查' + (capture ? '与修订版 PNG/文本采集' : '') + '\n');
