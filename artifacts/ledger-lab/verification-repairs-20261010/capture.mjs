/**
 * 修复批 TUI 证据采集（repair-ledger-lab-verification-findings / IP-08 4.2）。
 *
 * 每个画面都在真实 PTY（tuistory + ghostty 渲染）里驱动 fixture.mjs 挂载的生产组件，
 * 覆盖 120x40 / 80x24 / 50x40 三档，每档两套：彩色 + Nerd、NO_COLOR + ASCII。
 * 不写任何既有 artifacts 目录，不连接真实 Orca / GitHub / provider。
 *
 * 语义片段检查与 observed 判定是硬门槛：任一不成立即记入 manifest 并以非零状态退出。
 *
 * 用法：先 pnpm build，再 node artifacts/ledger-lab/verification-repairs-20261010/capture.mjs
 * 可选环境变量（只用于缩小试跑范围，正式采集不设置）：
 *   OCP_CAPTURE_ONLY=workspace-mouse,workspace-empty  只跑这些场景；
 *   OCP_CAPTURE_SIZES=80x24                          只跑这些尺寸。
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = join(root, 'artifacts/ledger-lab/verification-repairs-20261010',
  'capture-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });

const require = createRequire(join(root, 'package.json'));
const local = createRequire(require.resolve('tuistory'));
const imageModule = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(imageModule);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(imageModule)));
const { displayWidth } = await import(pathToFileURL(join(root, 'dist/src/interfaces/tui/render/width.js')));
const { launchTerminal } = await import(require.resolve('tuistory'));

const fixture = join(root, 'artifacts/ledger-lab/verification-repairs-20261010/fixture.mjs');
const samples = [];
const failures = [];
/** 画面文件名必须带尺寸与色彩/图标后缀，否则三档两套会互相覆盖；命名沿既有证据的「画面-尺寸-变体」顺序。 */
let runSuffix = '';

async function frameOf(terminal) {
  await terminal.text();
  const data = terminal.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  return {
    text: lines.map(line => line.spans.map(span => span.text).join('').trimEnd()).join('\n') + '\n',
    cells: { ...data, lines: lines.map(line => ({ ...line, spans: line.spans.flatMap(span =>
      Array.from(span.text, character => ({ ...span, text: character, width: displayWidth(character),
        ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}) }))) })) },
    columns: data.cols,
    rows: data.rows,
    cursor: data.cursor,
  };
}

/** 一张画面：写同名 PNG/TXT；语义片段缺失即判失败。 */
async function shot(terminal, stem, expects) {
  await delay(200);
  const file = stem + '-' + runSuffix;
  const frame = await frameOf(terminal);
  writeFileSync(join(output, file + '.txt'), frame.text);
  writeFileSync(join(output, file + '.png'), await renderTerminalToImage(frame.cells));
  const checks = (expects ?? []).map(fragment => ({ fragment, ok: frame.text.includes(fragment) }));
  for (const check of checks) {
    if (!check.ok) failures.push({ stem: file, kind: 'fragment', detail: check.fragment });
  }
  samples.push({ stem: file, columns: frame.columns, rows: frame.rows, cursor: frame.cursor, checks });
  return frame.text;
}

const press = async (terminal, key) => { await terminal.press(key); await delay(200); };
const send = async (terminal, text) => { terminal.writeRaw(text); await delay(200); };
async function awaitText(terminal, fragment) {
  try { await terminal.waitForText(fragment); }
  catch { failures.push({ kind: 'await', detail: fragment }); await delay(1200); }
}
function expect(label, ok, detail) {
  if (!ok) failures.push({ kind: 'observed', detail: label + (detail === undefined ? '' : ' :: ' + detail) });
  return ok;
}

// 每个场景：fixture scene 名、合成端口条件（写进 manifest）、驱动脚本与判定。
const scenes = [
  {
    stem: 'declare-candidate',
    scene: 'declare',
    conditions: ['合成 ProviderLibrary/Catalog：1 个连接、1 个带 effortCapability 与窗口/模态的目录候选',
      '目录候选选定即保存，随后只确认独立横向 effort，不出现元数据字段'],
    run: async terminal => {
      await awaitText(terminal, '合成连接');
      await press(terminal, 'enter');
      await press(terminal, 'down');
      await press(terminal, 'enter');
      await awaitText(terminal, 'Coordinator · effort');
      await shot(terminal, 'declare-candidate-effort-default', ['Coordinator · effort', 'Model', 'Effort', '不指定']);
      await press(terminal, 'right');
      await press(terminal, 'right');
      await shot(terminal, 'declare-candidate-effort', ['当前区域：Effort · medium']);
      // 动作区默认「返回」，确认必须显式选择：Enter 到动作区 → → 应用选择 → Enter。
      await press(terminal, 'enter');
      await press(terminal, 'right');
      await press(terminal, 'enter');
      await shot(terminal, 'declare-candidate-applied', ['模型候选与手动填写']);
    },
  },
  {
    stem: 'declare-manual',
    scene: 'declare',
    conditions: ['同一合成端口；手填 exact ID 不发起目录查询，确认后才保存',
      '手填步才显示上下文窗口、输入模态与来源字段'],
    run: async terminal => {
      await awaitText(terminal, '合成连接');
      await press(terminal, 'enter');
      await press(terminal, 'down');
      await press(terminal, 'enter');
      await awaitText(terminal, 'Coordinator · effort');
      await press(terminal, 'esc');
      await send(terminal, 'vendor/manual-model-x');
      await press(terminal, 'down');
      await press(terminal, 'enter');
      await awaitText(terminal, 'Coordinator · 模型声明');
      // 声明必须完整：窗口与输入模态要么都声明、要么都是未知，因此先填窗口再切模态。
      await send(terminal, '128000');
      await shot(terminal, 'declare-manual-metadata', ['vendor/manual-model-x', '128000', '未声明（未知）', 'user_declared', '当前区域：上下文窗口']);
      await press(terminal, 'tab');
      // 第一格恒是 text：第一次空格声明 text-only，之后 → 到 image 再空格才追加 image。
      await send(terminal, ' ');
      await press(terminal, 'right');
      await send(terminal, ' ');
      // 断言声明结果本身（'text · image' 只在两个模态都声明后出现），而不是模态行里恒有的名字。
      await shot(terminal, 'declare-manual-modalities', ['当前区域：输入模态', '输入模态 text · image']);
      await press(terminal, 'enter');
      await press(terminal, 'right');
      await press(terminal, 'enter');
      await shot(terminal, 'declare-manual-saved', ['模型候选与手动填写']);
    },
  },
  {
    stem: 'onboarding-route-create',
    scene: 'onboarding-route-create',
    conditions: ['scopeSetup.verifyEnvironment 逐项报告后全部通过',
      'home=wizard；modelSettings.load=config_unavailable 进入模型步',
      'routeMapInitialization.create() 永不结算，界面停在真实在途 spinner'],
    run: async terminal => {
      await awaitText(terminal, '正在准备项目环境');
      await awaitText(terminal, '合成连接');
      await press(terminal, 'enter');
      await press(terminal, 'down');
      await press(terminal, 'enter');
      await awaitText(terminal, 'Coordinator · effort');
      await press(terminal, 'enter');
      await press(terminal, 'right');
      await press(terminal, 'enter');
      await awaitText(terminal, '设置 Route Map');
      await shot(terminal, 'onboarding-route-map', ['设置 Route Map', '创建空 Route Map', '选择已有 issue']);
      await press(terminal, 'enter');
      await awaitText(terminal, '正在创建 Route Map');
      await shot(terminal, 'onboarding-route-create-busy', ['正在创建 Route Map']);
    },
  },
  {
    stem: 'onboarding-final-busy',
    scene: 'onboarding-final-busy',
    conditions: ['routeMapInitialization.create() 返回 #42 后进入确认步',
      '确认后 verify 只报告 repository/orca/identity 三项并保持未决，画面停在五项 busy 核验'],
    run: async terminal => {
      await awaitText(terminal, '正在准备项目环境');
      await awaitText(terminal, '合成连接');
      await press(terminal, 'enter');
      await press(terminal, 'down');
      await press(terminal, 'enter');
      await awaitText(terminal, 'Coordinator · effort');
      await press(terminal, 'enter');
      await press(terminal, 'right');
      await press(terminal, 'enter');
      await awaitText(terminal, '设置 Route Map');
      await press(terminal, 'enter');
      await awaitText(terminal, '确认初始化');
      await shot(terminal, 'onboarding-confirm', ['准备开始规划', 'Route Map  #42', '确认初始化']);
      await press(terminal, 'enter');
      await awaitText(terminal, '模型能力');
      await delay(600);
      await shot(terminal, 'onboarding-confirm-busy', ['模型能力', 'Route Map']);
    },
  },
  {
    stem: 'workspace-running',
    scene: 'workspace-running',
    conditions: ['TuiApp + 合成 ports；snapshot.sessions[0].turn = running（真实轮次事实，不由租约推断）'],
    run: async terminal => {
      await awaitText(terminal, '历史条目 12');
      await shot(terminal, 'workspace-running', ['历史条目', '运行中']);
    },
  },
  {
    stem: 'workspace-empty',
    scene: 'workspace-empty',
    conditions: ['新注册会话：transcript 与 reading 端口都为空页'],
    run: async terminal => {
      await awaitText(terminal, '尚无对话记录');
      await shot(terminal, 'workspace-empty', ['尚无对话记录']);
    },
  },
  {
    stem: 'workspace-pending',
    scene: 'workspace-pending',
    conditions: ['输入「修复输入隔离回归」并提交；execute 永不结算，界面停在真实 pending 状态'],
    run: async terminal => {
      await awaitText(terminal, '历史条目 6');
      await send(terminal, '修复输入隔离回归');
      await press(terminal, 'enter');
      await awaitText(terminal, '正在提交');
      await shot(terminal, 'workspace-pending', ['修复输入隔离回归', '正在提交']);
    },
  },
  {
    stem: 'workspace-mouse',
    scene: 'workspace-mouse',
    conditions: ['40 条历史 + 未提交草稿；PTY 直接发送 SGR 滚轮报告（button 64）',
      '公开出口：Ctrl+C 退出，退出时鼠标模式必须恢复'],
    run: async (terminal, rows) => {
      const chunks = [];
      const unsubscribe = terminal.subscribe(data => {
        chunks.push(data);
        if (chunks.length > 400) chunks.shift();
      });
      try {
        await awaitText(terminal, '历史条目 40');
        await send(terminal, '草稿ABC-输入隔离');
        const before = await shot(terminal, 'mouse-before', ['草稿ABC-输入隔离', '历史条目']);
        await send(terminal, '\u001b[<64;20;8M');
        await delay(600);
        const afterWheel = await shot(terminal, 'mouse-after-transcript-wheel', []);
        await send(terminal, '\u001b[');
        await delay(150);
        await send(terminal, '<64;20;8M');
        await delay(600);
        const afterSplit = await shot(terminal, 'mouse-after-split-wheel', []);
        await send(terminal, '\u001b[<64;20;' + Math.max(2, rows - 3) + 'M');
        await delay(600);
        const afterComposer = await shot(terminal, 'mouse-composer-wheel-ignored', []);
        await press(terminal, ['ctrl', 'p']);
        await delay(400);
        const overlayOpen = await shot(terminal, 'mouse-overlay-open', ['Command Palette · 命令目录']);
        await send(terminal, '\u001b[<64;20;8M');
        await delay(600);
        const afterOverlay = await shot(terminal, 'mouse-overlay-wheel-ignored', []);
        await press(terminal, 'esc');
        await delay(300);
        await press(terminal, ['ctrl', 'c']);
        const exited = await terminal.waitForExit(5000);
        await delay(300);
        const tail = chunks.join('').slice(-600);
        const line = text => text.split('\n').find(item => item.includes('草稿ABC-输入隔离')) ?? '';
        expect('transcript 滚轮后视窗移动', before !== afterWheel);
        expect('滚轮不改写 composer 草稿行', line(before) !== '' && line(before) === line(afterWheel));
        expect('分段 SGR 报告移动视窗且保留草稿', afterWheel !== afterSplit && line(before) === line(afterSplit));
        expect('分段 SGR 报告不进入输入', !afterSplit.includes('<64;20;8M'));
        expect('composer 区域滚轮不改变画面', afterSplit === afterComposer);
        expect('overlay 打开时滚轮不滚动 transcript', overlayOpen === afterOverlay);
        expect('Ctrl+C 退出前台', exited, 'exited=' + exited);
        expect('退出时恢复终端鼠标模式',
          tail.includes('\u001b[?1006l') && tail.includes('\u001b[?1000l'));
      } finally { unsubscribe(); }
    },
  },
];

const variants = [['color', 'nerd'], ['no-color', 'ascii']];
const results = [];
const only = process.env.OCP_CAPTURE_ONLY?.split(',').map(item => item.trim()).filter(Boolean);
const sizes = process.env.OCP_CAPTURE_SIZES?.split(',').map(item => item.trim()).filter(Boolean);
const allSizes = [[120, 40], [80, 24], [50, 40]].filter(([cols, rows]) => sizes === undefined || sizes.includes(cols + 'x' + rows));

for (const [cols, rows] of allSizes) {
  for (const [mode, icons] of variants) {
    for (const spec of scenes.filter(item => only === undefined || only.includes(item.stem))) {
      const stem = spec.stem + '-' + cols + 'x' + rows + '-' + mode + '-' + icons;
      runSuffix = cols + 'x' + rows + '-' + mode + '-' + icons;
      const env = { ...process.env, TERM: 'xterm-256color', NODE_NO_WARNINGS: '1',
        ORCA_COMPANION_TUI_ICONS: icons, FORCE_COLOR: mode === 'color' ? '1' : '0' };
      if (mode === 'no-color') env.NO_COLOR = '1'; else delete env.NO_COLOR;
      const terminal = await launchTerminal({ command: process.execPath, cwd: root, cols, rows, env,
        args: [fixture, spec.scene] });
      let error = null;
      try { await spec.run(terminal, rows); }
      catch (cause) {
        error = String(cause?.message ?? cause);
        failures.push({ kind: 'scene', detail: stem + ' :: ' + error });
        await shot(terminal, 'FAILURE-' + stem, []);
      } finally { terminal.close(); }
      results.push({ scene: spec.stem, size: cols + 'x' + rows, variant: mode + '/' + icons,
        conditions: spec.conditions, error });
      process.stdout.write((error ? 'FAIL ' : 'ok   ') + stem + (error ? ' :: ' + error : '') + '\n');
    }
  }
}

writeFileSync(join(output, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  fixture: 'artifacts/ledger-lab/verification-repairs-20261010/fixture.mjs', scenes: results,
  samples, failures }, null, 2) + '\n');
process.stdout.write(output + '\n');
if (failures.length > 0) {
  process.stderr.write(failures.length + ' 项证据判定失败，已记入 manifest.json\n');
  for (const failure of failures) process.stderr.write('  - ' + JSON.stringify(failure) + '\n');
  process.exitCode = 1;
}
