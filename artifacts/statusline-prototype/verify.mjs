/** Shared workbench comparison: build first, then run this file [--capture]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { launchTerminal } from 'tuistory';
import { displayWidth } from '../../dist/src/interfaces/tui/render/width.js';
import { defaultStatusPreferences, prototypeStatusText, statusPreferenceSchema } from '../../dist/src/interfaces/tui/statusline-prototype.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('./custom-direct/', import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'orca-status-verify-'));
let runId = 0;
const capture = process.argv.includes('--capture');
const customOnly = process.argv.includes('--custom-only');
const sizes = [[120, 40], [80, 24], [50, 40]];
const records = [];
const fromTuistory = createRequire(createRequire(import.meta.url).resolve('tuistory'));
const imageModule = fromTuistory.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
if (capture) mkdirSync(output, { recursive: true });

async function frame(s) {
  await s.text();
  const d = s.getTerminalData();
  return d.lines.slice(-d.rows).map((l) => l.spans.map((p) => p.text).join('').trimEnd()).join('\n');
}
async function tap(s, key) { await s.press(key); return frame(s); }
async function ready(s, predicate) {
  for (let i = 0; i < 30; i++) {
    const text = await frame(s);
    if (predicate(text)) return text;
    await sleep(50);
  }
  assert.fail('画面未收敛：\n' + await frame(s));
}
async function run(scene, variant, size, body, color = false, preferencePath = join(scratch, `${++runId}.json`)) {
  const env = { ...process.env, FORCE_COLOR: color ? '1' : '0', TERM: 'xterm-256color', ORCA_STATUS_PROTOTYPE_CONFIG: preferencePath };
  if (color) delete env.NO_COLOR;
  else env.NO_COLOR = '1';
  const s = await launchTerminal({ command: process.execPath, args: ['scripts/tui-preview.mjs', '--status-prototype', scene, variant],
    cols: size[0], rows: size[1], cwd: root, env });
  try { await ready(s, (t) => t.includes(`原型 ${variant}`)); await body(s); } finally { s.close(); }
}
async function shot(s, name, size) {
  const text = await frame(s);
  assert(text.split('\n').every((line) => displayWidth(line) <= size[0]), '终端画面超宽');
  if (!capture) return;
  const filename = `${name}-${size.join('x')}`;
  writeFileSync(new URL(filename + '.txt', output), text + '\n');
  const data = s.getTerminalData();
  const cells = { ...data, lines: data.lines.slice(-data.rows).map((line) => ({ ...line,
    spans: line.spans.flatMap((span) => Array.from(span.text, (text) => ({ ...span, text, width: displayWidth(text),
      ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
    }))),
  })) };
  writeFileSync(new URL(filename + '.png', output), await renderTerminalToImage(cells));
  records.push({ name, columns: size[0], rows: size[1], png: filename + '.png', text: filename + '.txt' });
}
const sessionOf = (text) => text.split('\n')[0].match(/S-[AB]/)?.[0];
const modelLine = (text) => text.split('\n').find((l) => /推理.*上下文/.test(l));
const command = async (s, query) => { await tap(s, ['ctrl', 'p']); await s.type(query); return tap(s, 'enter'); };
const options = async (s) => { await command(s, '选项'); await s.type('状态栏'); await tap(s, 'enter'); return ready(s, (t) => t.includes('预览 · 主区域')); };
const save = async (s) => {
  await tap(s, 'enter');
  await ready(s, (t) => !t.includes('预览 · 主区域') && /原型 .* · [a-z]+ · 对话 · 滚动/.test(t));
};
async function back(s) {
  for (let i = 0; i < 6; i++) {
    if (/原型 .* · [a-z]+ · 对话 · 滚动/.test(await frame(s))) return;
    await tap(s, 'esc');
  }
  assert.fail('未返回原对话');
}

for (const size of sizes) {
  if (!customOnly) {
  for (const variant of ['current', 'fixed', 'custom']) {
    for (const scene of ['planning', 'execution', 'blocked', 'answer', 'idle']) {
      await run(scene, variant, size, async (s) => {
        const text = await frame(s);
        if (variant !== 'current') {
          assert.equal(sessionOf(text), 'S-A');
          assert.match(text, /待答[03]/);
          assert.match(modelLine(text) ?? '', /示例模型 A.*high.*62%/);
          assert(text.split('\n').filter((line) => line.startsWith('!')).length <= 2);
          if (scene === 'blocked') assert.match(text.split('\n').slice(0, 3).join('\n'), /未知.*待对账[\s\S]*持有S-B|持有S-B[\s\S]*未知.*待对账/);
        }
        await shot(s, `${variant}-${scene}`, size);
      }, capture);
    }
  }
  await run('blocked', 'fixed', size, async (s) => {
    await s.type('1mns-draft-中文'); await tap(s, 'pageup');
    const original = modelLine(await frame(s));
    const notified = await tap(s, ['ctrl', 'w']);
    assert.equal(modelLine(notified), original);
    assert(notified.includes('1mns-draft-中文') && notified.includes('待对账'));
    await shot(s, 'notification', size);
    await tap(s, ['ctrl', 'b']);
    assert((await frame(s)).includes('项目面板') && (await frame(s)).includes('待对账'));
    await shot(s, 'project', size);
    await tap(s, 'tab'); await tap(s, 'tab');
    for (const [cols, rows] of sizes) {
      s.resize({ cols, rows });
      await ready(s, (t) => t.includes('最近事件') && t.includes('待对账') && t.split('\n').every((l) => displayWidth(l) <= cols));
    }
    s.resize({ cols: size[0], rows: size[1] });
    await ready(s, (t) => t.includes('最近事件'));
    const closed = await tap(s, ['ctrl', 'b']);
    assert(closed.includes('1mns-draft-中文') && closed.includes('滚动2'));
    await tap(s, ['ctrl', 's']); await s.type('S-B'); await tap(s, ['ctrl', 'n']);
    assert.equal(sessionOf(await frame(s)), 'S-A');
    await shot(s, 'session-dialog-risk', size);
    await tap(s, 'esc');
    assert((await frame(s)).includes('1mns-draft-中文'));
    await tap(s, ['ctrl', 's']); await s.type('S-B'); await tap(s, 'enter');
    assert.equal(sessionOf(await frame(s)), 'S-B');
    assert.match(modelLine(await frame(s)) ?? '', /28%/);
    await shot(s, 'other-session', size);
  });
  await run('planning', 'fixed', size, async (s) => {
    await s.type('source-draft');
    for (const state of ['unset', 'unavailable', 'available']) {
      const text = await tap(s, ['ctrl', 'e']);
      const line = modelLine(text) ?? '';
      assert.match(line, state === 'unset' ? /推理 未设置.*上下文 不可用/ : state === 'unavailable' ? /推理 不可用.*上下文 不可用/ : /high.*62%/);
      await shot(s, `source-${state}`, size);
    }
    for (const variant of ['custom', 'current', 'fixed']) {
      const text = await tap(s, ['ctrl', 't']);
      assert(text.includes(`原型 ${variant}`) && text.includes('source-draft'));
    }
    await tap(s, ['ctrl', 't']);
    await options(s);
    await shot(s, 'custom-options', size);
    await tap(s, 'esc'); await back(s);
    assert((await frame(s)).includes('source-draft'));
    await tap(s, ['ctrl', 't']); await tap(s, ['ctrl', 't']);
    await command(s, 'model'); await tap(s, 'enter'); await s.type('config-basic');
    await tap(s, 'enter'); await tap(s, 'enter');
    await back(s);
    assert.match(modelLine(await frame(s)) ?? '', /示例模型 D.*推理 不支持.*上下文 不可用/);
    await shot(s, 'model-no-effort', size);
    await command(s, 'model'); await tap(s, 'enter'); await s.type('config-b');
    await tap(s, 'enter'); await tap(s, 'right'); await tap(s, 'enter'); await tap(s, 'enter');
    await back(s);
    assert.match(modelLine(await frame(s)) ?? '', /示例模型 B.*推理 low.*上下文 不可用/);
    assert((await frame(s)).includes('source-draft'));
    await shot(s, 'model-changed', size);
    await command(s, 'model'); await tap(s, 'enter'); await s.type('config-rejected');
    await tap(s, 'enter'); await tap(s, 'enter'); await tap(s, 'enter');
    assert((await frame(s)).includes('被拒绝'));
    await back(s);
    assert.match(modelLine(await frame(s)) ?? '', /示例模型 B.*low/);
  });
  }
  const preferencePath = join(scratch, `saved-${size[0]}.json`);
  await run('execution', 'custom', size, async (s) => {
    await s.type('custom-draft-中文'); await tap(s, 'pageup');
    const original = modelLine(await frame(s));
    await options(s);
    await tap(s, 'right'); // provider/model
    await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'right'); // remaining context
    await tap(s, ['ctrl', 'n']);
    assert.equal(sessionOf(await frame(s)), 'S-A');
    await shot(s, 'custom-preview', size);
    await tap(s, 'esc'); await back(s);
    assert.equal(modelLine(await frame(s)), original);
    assert(!existsSync(preferencePath), '取消不写偏好文件');
    await options(s);
    await tap(s, 'right'); await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'right');
    // Enable work-package, progress and budget; selected rows move into the ordered list.
    await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'space');
    await tap(s, 'left'); // work-package before graph
    await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'space');
    await tap(s, 'down'); await tap(s, 'down'); await tap(s, 'space');
    await shot(s, 'custom-ordered', size);
    await save(s);
    const persisted = JSON.parse(readFileSync(preferencePath, 'utf8'));
    assert.deepEqual(persisted.fields, ['work-package', 'graph', 'progress', 'budget']);
    assert.equal(persisted.modelFormat, 'provider-model'); assert.equal(persisted.contextFormat, 'remaining');
    assert.match(modelLine(await frame(s)) ?? '', /上下文剩余 38%/);
    assert.match(modelLine(await frame(s)) ?? '', /示例模型 A/);
    assert((await frame(s)).includes('custom-draft-中文') && (await frame(s)).includes('滚动2'));
    await shot(s, 'custom-saved', size);
    await tap(s, ['ctrl', 's']); await s.type('S-B'); await tap(s, 'enter');
    assert.match(modelLine(await frame(s)) ?? '', /上下文剩余 72%/);
    await shot(s, 'custom-other-session', size);
    // Configuration opened from a panel returns to the same panel.
    await tap(s, ['ctrl', 'b']); await options(s); await tap(s, 'esc');
    await tap(s, 'esc'); await tap(s, 'esc');
    assert((await frame(s)).includes('项目面板'));
    await options(s); await tap(s, 'enter');
    await ready(s, (t) => !t.includes('预览 · 主区域') && t.includes('项目面板'));
    await tap(s, ['ctrl', 'b']);
    await options(s);
    for (let index = 0; index < 10; index++) await tap(s, 'down');
    await tap(s, 'space');
    await shot(s, 'custom-reset-preview', size);
    await save(s);
    assert.deepEqual(JSON.parse(readFileSync(preferencePath, 'utf8')), defaultStatusPreferences);
  }, capture, preferencePath);
  // Restart restoration and malformed-config fallback use isolated scratch preferences.
  const restored = { ...defaultStatusPreferences, contextFormat: 'tokens', fields: ['progress', 'budget', 'graph'] };
  writeFileSync(preferencePath, JSON.stringify(restored));
  await run('execution', 'custom', size, async (s) => {
    assert.match(modelLine(await frame(s)) ?? '', /上下文 62k\/100k/);
    if (size[0] === 120) assert.match(modelLine(await frame(s)) ?? '', /验收 9\/20/);
    await shot(s, 'custom-restored', size);
    await options(s);
    for (const [cols, rows] of sizes) {
      s.resize({ cols, rows });
      await ready(s, (t) => t.includes('预览 · 主区域') && t.split('\n').every((line) => displayWidth(line) <= cols));
    }
  }, capture, preferencePath);
  writeFileSync(preferencePath, '{invalid');
  await run('planning', 'custom', size, async (s) => { assert.match(modelLine(await frame(s)) ?? '', /上下文 62%/); }, false, preferencePath);
  const blockedPath = join(scratch, `parent-${size[0]}`);
  writeFileSync(blockedPath, 'not a directory');
  await run('blocked', 'custom', size, async (s) => {
    await s.type('save-failure-draft'); await options(s);
    await tap(s, 'right'); await tap(s, 'enter');
    await ready(s, (t) => t.includes('保存失败'));
    assert.match((await frame(s)).split('\n').slice(0, 3).join('\n'), /待对账/);
    await shot(s, 'custom-save-failed', size);
    await tap(s, 'esc'); await back(s);
    assert((await frame(s)).includes('save-failure-draft'));
    assert.match(modelLine(await frame(s)) ?? '', /示例模型 A.*62%/);
  }, capture, join(blockedPath, 'preferences.json'));
  let coloredText;
  await run('blocked', 'custom', size, async (s) => {
    coloredText = modelLine(await frame(s));
    const data = s.getTerminalData();
    const statusLine = data.lines.slice(-data.rows).find((line) => /推理.*上下文/.test(line.spans.map((span) => span.text).join('')));
    assert(new Set(statusLine.spans.filter((span) => span.text.trim() !== '' && span.text.trim() !== '·').map((span) => JSON.stringify(span.fg))).size >= 3,
      '核心字段应使用不同颜色');
    await shot(s, 'field-colors', size);
    await options(s); await shot(s, 'direct-options-colors', size);
    const before = modelLine(await frame(s));
    await tap(s, 'tab'); // There is no secondary focus or save-button navigation.
    assert.equal(modelLine(await frame(s)), before);
    await save(s);
  }, true);
  await run('blocked', 'custom', size, async (s) => {
    assert.equal(modelLine(await frame(s)), coloredText, '关闭颜色保留相同字段与含义');
    await shot(s, 'field-monochrome', size);
    await options(s); await shot(s, 'direct-options-monochrome', size);
  }, false);
  process.stdout.write(`✓ ${customOnly ? '自定义设置、直接保存、字段配色与返回' : '五场景/三方案、通知、来源、模型、返回'}与 resize ${size.join('x')}\n`);
}
// Pure display checks exercise width priority and missing facts without another fixture system.
// Reuse the archived fixture shapes via a minimal view: only read fields are supplied here.
const status = { configurationRef: 'config-a', effort: 'high', availability: 'available', contextAvailable: true,
  width: 120, variant: 'custom', preferences: { ...defaultStatusPreferences, fields: ['progress', 'budget', 'graph'] },
  samples: { ticket: null, context: { used: 62000, capacity: 100000 }, progress: null },
  view: { scope: { mode: 'execution_coordination' }, graph: null, budgets: [], execution: {} } };
assert.match(prototypeStatusText(status), /验收进度不可用.*工作包预算未登记.*未建立图/);
assert(!prototypeStatusText({ ...status, width: 43 }).includes('验收'));
assert.match(prototypeStatusText({ ...status, samples: { ...status.samples, progress: { accepted: 9, total: 20 } } }), /验收 9\/20/);
assert.match(prototypeStatusText({ ...status, preferences: { ...status.preferences, progressFormat: 'percent' }, samples: { ...status.samples, progress: { accepted: 9, total: 20 } } }), /验收 45%/);
assert.match(prototypeStatusText({ ...status, preferences: { ...status.preferences, budgetKey: 'recovery', fields: ['budget'] },
  view: { ...status.view, budgets: [{ budgetKey: 'work-packages', consumed: 7 }, { budgetKey: 'recovery', consumed: 1 }] } }), /恢复已用 1/);
assert.match(prototypeStatusText({ ...status, preferences: { ...status.preferences, fields: ['ticket'] },
  view: { ...status.view, scope: { mode: 'route_planning' } }, samples: { ...status.samples, ticket: { number: '48', title: '长中文标题'.repeat(20) } } }), /规划 #48/);
assert(!prototypeStatusText({ ...status, preferences: { ...status.preferences, fields: ['ticket'] } }).includes('规划'));
assert(!statusPreferenceSchema.safeParse({ ...defaultStatusPreferences, fields: ['graph', 'graph'] }).success);
if (capture) {
  const previous = customOnly && existsSync(new URL('samples.json', output))
    ? JSON.parse(readFileSync(new URL('samples.json', output), 'utf8')).samples.filter((sample) => !records.some((record) => record.png === sample.png)) : [];
  writeFileSync(new URL('samples.json', output), JSON.stringify({ capturedAt: new Date().toISOString(), ticket: 48,
    renderer: 'tuistory PTY + ghostty-opentui bundled Nerd Font and CJK fallback', samples: [...previous, ...records] }, null, 2) + '\n');
}
process.stdout.write(`通过；${capture ? `保存 ${records.length} 组 PNG/文本` : '未改写截图'}\n`);
