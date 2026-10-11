// Read-only source render: no build, server, native catalogue or Worker launch.
import { registerHooks, createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { stripVTControlCharacters } from 'node:util';
import ts from 'typescript';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const mode = process.argv[2] ?? 'no-color';
const output = resolve(dirname(fileURLToPath(import.meta.url)), 'capture-' + mode + '-' + Date.now());
mkdirSync(output, { recursive: true });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      for (const extension of ['.ts', '.tsx']) {
        const source = base.slice(0, -3) + extension;
        if (existsSync(source)) return next(pathToFileURL(source).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.tsx?$/u.test(url) && url.startsWith(pathToFileURL(root).href)) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX },
        fileName: fileURLToPath(url),
      }).outputText };
    }
    return next(url, context);
  },
});
const { createElement } = await import('react');
const { cleanup } = await import('ink-testing-library');
const { ModelPicker, RoleModelMenu } = await import(pathToFileURL(resolve(root, 'src/interfaces/tui/components/model-picker.tsx')));
const { renderComponent, renderTui, createFakePorts, frameText, chooseCommand, settle } = await import(pathToFileURL(resolve(root, 'tests/tui/harness.ts')));
const { displayWidth } = await import(pathToFileURL(resolve(root, 'src/interfaces/tui/render/width.ts')));
const { WORKER_HARNESS_IDS } = await import(pathToFileURL(resolve(root, 'src/domain/model-configuration.ts')));
const require = createRequire(resolve(root, 'package.json'));
const imageRequire = createRequire(require.resolve('tuistory'));
const { renderTerminalToImage } = await import(imageRequire.resolve('ghostty-opentui/image'));
const model = 'MiniMax-M3.1-Flash-Preview';
const ids = ['command-code', 'qwen-code'];
const samples = [], checks = [];
const role = harness => ({ role: 'planner', label: 'Planner', group: 'execution', availability: { available: true, reason: null },
  current: { candidateRef: model, provider: '', model, effort: null, harness },
  candidates: [{ candidateRef: model, provider: '', model, effortCapability: null, harness, catalogSource: 'offline-fixture' }] });
async function capture(element, name, width, rows) {
  const app = renderComponent(element);
  try {
    Object.defineProperty(app.stdout, 'columns', { get: () => width });
    app.rerender(element);
    await settle();
    const frame = frameText(app);
    const plain = stripVTControlCharacters(frame);
    assert(plain.split('\n').every(line => displayWidth(line) <= width));
    assert(plain.split('\n').length <= rows);
    assert(!/API Key|credential|baseUrl|options JSON/u.test(plain));
    writeFileSync(resolve(output, name + '.txt'), plain + '\n', { flag: 'wx' });
    writeFileSync(resolve(output, name + '.ansi'), frame, { flag: 'wx' });
    if (mode === 'no-color') {
      const lines = plain.split('\n').map(line => ({ spans: Array.from(line, text => ({ text, width: displayWidth(text), fg: null, bg: null, flags: 0 })) }));
      writeFileSync(resolve(output, name + '.png'), await renderTerminalToImage({ cols: width, rows, cursor: { x: 0, y: 0 }, lines }), { flag: 'wx' });
    }
    samples.push({ name, width, rows, mode, source: 'production source component / synthetic read-only props' });
  } finally { app.unmount(); cleanup(); }
}
for (const [width, rows] of [[120, 40], [80, 24], [50, 40]]) {
  const roleViews = [{ role: 'coordinator', label: 'Coordinator', group: 'current', current: null, candidates: [], availability: { available: true, reason: null } },
    { role: 'planning_utility', label: 'Utility', group: 'planning', current: null, candidates: [], availability: { available: false, reason: '未接通' } },
    ...ids.map(role).map((item, index) => ({ ...item, role: ['planner', 'implementation', 'validator'][index], label: ['Planner', 'Implementation', 'Validator'][index] }))];
  await capture(createElement(ModelPicker, { catalog: { roles: roleViews, options: [], currentConfigurationRef: null, switchable: true, switchBlockReason: null },
    rejection: null, onOpenRole: () => undefined, availableWidth: width, rows, roleIndex: 2, identity: '离线合成 · 新 harness IDs' }), 'roles-' + width + 'x' + rows, width, rows);
  for (const harness of ids) {
    const manual = harness !== 'command-code';
    await capture(createElement(RoleModelMenu, { role: { ...role(harness), candidates: manual ? [] : role(harness).candidates },
      menu: { role: 'planner', selectedCandidateRef: manual ? null : model, focus: 'actions', action: 0, effort: null, harness },
      query: manual ? model : '', admissionReason: null, notice: null, onAction: () => undefined, availableWidth: width, rows,
      identity: '离线合成 · Planner · ' + harness,
      workerCatalog: { role: 'planner', harness, generation: 1, load: manual ? { kind: 'unavailable', code: 'catalog_api_unavailable', message: 'offline' }
        : { kind: 'available', source: 'offline-fixture', models: [{ model, effortCapability: null }] } },
    }), harness + '-menu-' + width + 'x' + rows, width, rows);
  }
}
async function press(app, key) { app.stdin.write(key); await settle(4); }
async function escape(app) { app.stdin.write('\x1b'); await new Promise(done => setTimeout(done, 65)); await settle(4); }
for (const harness of ids) {
  assert(WORKER_HARNESS_IDS.includes(harness));
  const fake = createFakePorts({ modelCatalog: { roles: [role(harness)], configurationRevision: 9 }, modelSettings: {},
    workerModels: () => Promise.resolve({ kind: 'available', source: 'offline-fixture', models: [{ model, effortCapability: null }] }) });
  const app = renderTui(fake.ports);
  try {
    await settle(); await press(app, '保留草稿'); await chooseCommand(app, 'model-picker');
    await press(app, '\x1b[B'); await press(app, '\x1b[B'); await press(app, 'e'); await settle();
    assert.equal(fake.calls.filter(call => call.name === 'modelCatalog.queryWorkerModels').at(-1)?.detail, harness);
    assert(frameText(app).includes('Harness › ' + harness));
    await press(app, '\r'); await press(app, '\t');
    assert(frameText(app).includes('当前区域：操作按钮 · 返回'));
    await press(app, '\r'); assert(frameText(app).includes('Model Picker'));
    await press(app, 'e'); await press(app, '\x1b[C'); await settle();
    const nextHarness = WORKER_HARNESS_IDS[(WORKER_HARNESS_IDS.indexOf(harness) + 1) % WORKER_HARNESS_IDS.length];
    assert.equal(fake.calls.filter(call => call.name === 'modelCatalog.queryWorkerModels').at(-1)?.detail, nextHarness);
    await escape(app); assert(frameText(app).includes('Model Picker'));
    assert(!fake.calls.some(call => call.name === 'modelSettings.apply' || call.name === 'modelSettings.save'));
    await escape(app); await escape(app); await escape(app);
    assert(frameText(app).includes('保留草稿'));
    checks.push({ harness, explicitQuery: true, nextHarness, arrowNavigation: true, escapeToParent: true, defaultReturn: true, noSaveOrApply: true, draftPreserved: true, source: 'production TuiApp / existing isolated fake ports at 100 columns' });
  } finally { app.unmount(); cleanup(); }
}
writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ samples, checks, limits: ['Synthetic source render; not native catalogue/model/Orca proof', 'Behavior at 100 columns; other sizes are component renders', 'No native TTY or IME acceptance'] }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, samples: samples.length, checks }));
