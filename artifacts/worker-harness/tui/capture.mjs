// 逐角色 Harness 选择与原生连接编辑的生产画面采集。
//
// 挂载生产 TuiApp（scripts/tui-preview.mjs 的 alignment-planning 场景）与隔离 fixture 端口，
// 不连接模型、tracker 或 Orca。用法：`pnpm build` 后 `node artifacts/worker-harness/tui/capture.mjs [目录] [组合过滤]`。
// 组合键形如 `120x40-color-nerd`；过滤参数是匹配该键的正则，缺省采集全部三档 × 彩色/NO_COLOR × Nerd/ASCII。
// 目标目录已有 PNG/TXT 时拒绝覆盖，需显式 `FORCE_OVERWRITE=1`。
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { displayWidth } from '../../../dist/src/interfaces/tui/render/width.js';

const root = process.cwd();
const name = process.argv[2] ?? 'frames';
const filter = process.argv[3] === undefined ? null : new RegExp(process.argv[3]);
const output = root + '/artifacts/worker-harness/tui/' + name;
if (
  process.env.FORCE_OVERWRITE !== '1' &&
  existsSync(output) &&
  readdirSync(output).some((entry) => entry.endsWith('.png'))
) {
  throw new Error(`目标目录已有画面，拒绝覆盖：${output}（如确需重采，设 FORCE_OVERWRITE=1）`);
}
mkdirSync(output, { recursive: true });
const require = createRequire(root + '/package.json');
const { launchTerminal } = await import(require.resolve('tuistory'));
const local = createRequire(require.resolve('tuistory'));
const modulePath = local.resolve('ghostty-opentui/image');
const { renderTerminalToImage } = await import(modulePath);
const { StyleFlags } = await import(new URL('./ffi.js', pathToFileURL(modulePath)));
const samples = [];
const checks = [];

async function shot(session, frame, size, mode, icons) {
  await session.text();
  const data = session.getTerminalData();
  const lines = data.lines.slice(-data.rows);
  const stem = frame + '-' + size.join('x') + '-' + mode + '-' + icons;
  // 按字符拆 span 并显式给宽字符宽度：CJK 与反色块在 PNG 里才不会错位。
  const cells = {
    ...data,
    lines: lines.map((line) => ({
      ...line,
      spans: line.spans.flatMap((span) =>
        Array.from(span.text, (character) => ({
          ...span,
          text: character,
          width: displayWidth(character),
          ...((span.flags & StyleFlags.INVERSE) !== 0 ? { fg: span.fg ?? '#c0caf5', bg: span.bg ?? '#1a1b26' } : {}),
        })),
      ),
    })),
  };
  writeFileSync(
    output + '/' + stem + '.txt',
    lines.map((line) => line.spans.map((span) => span.text).join('').trimEnd()).join('\n') + '\n',
  );
  writeFileSync(output + '/' + stem + '.png', await renderTerminalToImage(cells));
  samples.push({ frame, size, mode, icons, png: stem + '.png', text: stem + '.txt', cursor: data.cursor });
}

async function press(session, key) {
  await session.press(key);
  await delay(150);
}

async function command(session, id) {
  await press(session, ['ctrl', 'p']);
  session.writeRaw(id);
  await delay(200);
  await press(session, 'enter');
}

for (const size of [[120, 40], [80, 24], [50, 40]]) {
  for (const mode of ['color', 'no-color']) {
    for (const icons of ['nerd', 'ascii']) {
      const key = size.join('x') + '-' + mode + '-' + icons;
      if (filter !== null && !filter.test(key)) continue;
      const env = {
        ...process.env,
        TERM: 'xterm-256color',
        NODE_NO_WARNINGS: '1',
        ORCA_COMPANION_TUI_ICONS: icons,
        FORCE_COLOR: mode === 'color' ? '1' : '0',
      };
      if (mode === 'no-color') env.NO_COLOR = '1';
      else delete env.NO_COLOR;
      const session = await launchTerminal({
        command: process.execPath,
        cwd: root,
        cols: size[0],
        rows: size[1],
        env,
        args: ['scripts/tui-preview.mjs', 'alignment-planning'],
      });
      const snap = (frame) => shot(session, frame, size, mode, icons);
      const seen = {};
      const expect = (frame, token) => {
        seen[frame] = (seen[frame] ?? '') + token;
      };
      try {
        await session.waitForText('普通消息');
        session.writeRaw('首尾');
        await press(session, 'left');
        await snap('workspace');

        await command(session, 'model-picker');
        await session.waitForText('Model Picker');
        await snap('roles');
        expect('roles', 'Model Picker');

        // Coordinator：始终走 LangChain，编辑页不出现 Harness 与原生字段。
        await press(session, 'e');
        await session.waitForText('连接名称');
        await delay(200);
        await snap('editor-coordinator');
        const coordinatorText = await session.text();
        if (!coordinatorText.includes('Codex') || coordinatorText.includes('native')) {
          throw new Error('coordinator editor exposed harness/native fields');
        }
        expect('editor-coordinator', 'Codex 可见/native 不可见');
        await press(session, 'esc');
        await session.waitForText('Model Picker');

        // Planner（既有 Worker fixture，harness=codex）：原生字段隐藏，Codex 字段保留。
        await press(session, 'down');
        await press(session, 'down');
        await press(session, 'e');
        await session.waitForText('连接名称');
        session.writeRaw('中文连接');
        await delay(220);
        await snap('editor-cjk');
        if (!(await session.text()).includes('中文连接')) throw new Error('editor lost CJK input');
        expect('editor-cjk', '中文连接 可见');
        for (let down = 0; down < 4; down++) await press(session, 'down');
        await snap('harness-codex');
        if (!(await session.text()).includes('Codex')) throw new Error('codex harness lost codex fields');
        expect('harness-codex', 'Harness=codex 时可编辑 Codex 字段');

        // 切到 claude：Codex 字段消失，只出现该 harness 适用的原生字段。
        await press(session, 'right');
        await press(session, 'down');
        await snap('native-fields');
        const nativeText = await session.text();
        if (!nativeText.includes('native') || nativeText.includes('Codex')) {
          throw new Error('native harness kept codex fields or lost native fields');
        }
        expect('native-fields', 'Harness=claude 时仅 native 字段');

        session.writeRaw('anthropic');
        await press(session, 'down');
        session.writeRaw('https://api.anthropic.com');
        await press(session, 'down');
        await press(session, 'right');
        await snap('native-filled');
        expect('native-filled', 'native providerId/baseUrl/api');

        // managed 凭据的 key 始终遮罩：固定无效字符串不得出现在屏幕上。
        for (let down = 0; down < 6; down++) await press(session, 'down');
        session.writeRaw('fixture-key-mask-only');
        await delay(220);
        await snap('masked-key');
        if ((await session.text()).includes('fixture-key-mask-only')) throw new Error('editor key was visible');
        expect('masked-key', 'key 未出现在屏幕');

        await press(session, 'enter');
        await session.waitForText('尚未应用');
        await snap('saved');
        expect('saved', '保存独立于应用');

        // 应用 Worker profile 仍须完整 Manifest 审阅，默认返回。
        await press(session, 'enter');
        await session.waitForText('当前区域：模型列表');
        await press(session, 'tab');
        await press(session, 'right');
        await snap('effort');
        // 区域标题大写 `Effort`、列表态提示小写 `effort`，两种焦点都要能证明选择器存在。
        if (!/effort/i.test(await session.text())) throw new Error('role menu lost effort selector');
        expect('effort', '独立 effort 选择');
        await press(session, 'tab');
        await press(session, 'right');
        await press(session, 'enter');
        await session.waitForText('Execution Authorization Review');
        await snap('reapproval');
        expect('reapproval', '重新授权审阅');

        // 逐层返回：模型页离开后普通草稿与光标保持。
        await press(session, 'esc');
        for (let back = 0; back < 3; back++) await press(session, 'esc');
        session.writeRaw('中');
        await session.waitForText('首中尾');
        await snap('returned-draft');
        expect('returned-draft', '返回后草稿=首中尾');

        if (key === '120x40-color-nerd') {
          await command(session, 'model-picker');
          await press(session, 'down');
          await press(session, 'down');
          await press(session, 'e');
          await session.waitForText('连接名称');
          for (let down = 0; down < 4; down++) await press(session, 'down');
          await press(session, 'right');
          await press(session, 'down');
          for (const resized of [[80, 24], [50, 40], [120, 40]]) {
            session.resize({ cols: resized[0], rows: resized[1] });
            await delay(250);
            await shot(session, 'resize-native', resized, mode, icons);
          }
          expect('resize-native', '80x24/50x40/120x40 连续 resize');
        }

        checks.push({
          combo: key,
          size,
          mode,
          icons,
          expectations: seen,
          source: 'production TuiApp / scripts/tui-preview.mjs alignment-planning / isolated fixture ports',
        });
        process.stdout.write('captured ' + key + '\n');
      } finally {
        session.close();
      }
    }
  }
}

writeFileSync(output + '/samples.json', JSON.stringify(samples, null, 2) + '\n');
writeFileSync(output + '/checks.json', JSON.stringify(checks, null, 2) + '\n');
process.stdout.write('frames: ' + String(samples.length) + ' in ' + output + '\n');
