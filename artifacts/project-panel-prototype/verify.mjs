#!/usr/bin/env node
/**
 * #51 项目面板组织与导航原型：真实 PTY 行为检查与截图采集。
 * 只用已安装的 tuistory（PTY/快照）与 ghostty-opentui（PNG）；先运行 pnpm build。
 *
 *   node artifacts/project-panel-prototype/verify.mjs
 *   node artifacts/project-panel-prototype/verify.mjs --capture [--variant tabs]
 *
 * 断言只依赖稳定语义：顶栏会话标记（S-A / S-B）、footer 的方案/场景/栏目、面板标题路径
 * （项目面板 · …）。执行图画布有动画，因此不用整帧相等。capture 每次启动先 Ctrl+B 打开面板再截图，
 * 并另采一张面板收起的主界面。
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { launchTerminal } from 'tuistory';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = ['scripts/tui-preview.mjs', '--project-prototype'];
const STAGE = [120, 40];
const SCENES = ['planning', 'execution', 'blocked', 'answer', 'idle'];
const VARIANTS = { tabs: '栏目切换', sections: '分区总览', menu: '目录导航' };
const SIZES = [[120, 40], [80, 24], [50, 40]];
const hasAnsi = (text) => text.includes('\u001b[');

async function loadWidth() {
  try {
    const url = pathToFileURL(join(ROOT, 'dist/src/interfaces/tui/render/width.js')).href;
    return (await import(url)).displayWidth;
  } catch (error) {
    throw new Error(`缺少构建产物（先运行 pnpm build）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
const displayWidth = await loadWidth();

// 面板标题路径、顶栏会话标记、footer 的方案/场景/栏目；都用固定语义片段，不用整帧比较。
const panelPath = (text) => text.match(/项目面板 · ([^│\n]*)/)?.[1]?.trim() ?? null;
const inspectorPath = (text) => text.match(/执行图检查 · ([^│\n]*)/)?.[1]?.trim() ?? null;
const sessionOf = (text) => text.match(/orca-c\/main · (S-[AB])/)?.[1] ?? null;
const variantOf = (text) => text.match(/原型 ([^·\n]+?) · /)?.[1]?.trim() ?? null;
const sceneOf = (text) => text.match(/原型 [^·\n]+ · ([a-z]+) · /)?.[1] ?? null;
const modeOf = (text) => text.match(/原型 [^·\n]+ · [a-z]+ · ([^·\n]+?) · 滚动/)?.[1]?.trim() ?? null;

function open(scene, variant, [cols, rows]) {
  return launchTerminal({
    command: process.execPath,
    args: [...ENTRY, scene, variant],
    cols, rows, cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', TERM: 'xterm-256color' },
  });
}

async function frame(session, where) {
  await session.text();
  const data = session.getTerminalData();
  const text = data.lines.slice(-data.rows).map((line) => line.spans.map((span) => span.text).join('').trimEnd()).join('\n');
  assert(!hasAnsi(text), `${where}：应无色，实际含 ANSI 转义`);
  assert(text.trim().length > 0, `${where}：画面不应为空`);
  return text;
}

/** 按一个键并等它渲染完，返回新画面；连续导航都用它，避免读到渲染前的旧状态。 */
async function tap(session, keys, where) {
  await session.press(keys);
  return frame(session, where);
}

/** 等待重排/动画收敛：返回第一个满足谓词的画面。 */
async function settled(session, where, predicate, attempts = 20) {
  let text = await frame(session, where);
  for (let step = 0; step < attempts && !predicate(text); step += 1) {
    await sleep(100);
    text = await frame(session, where);
  }
  return text;
}

async function run(scene, variant, size, body) {
  const session = await open(scene, variant, size);
  try {
    return await body(session);
  } finally {
    session.close();
  }
}

/** 默认收起；Ctrl+B 打开总览；Tab 循环三段；开合不丢 composer 草稿。 */
async function checkPanel(variant) {
  await run('planning', variant, STAGE, async (session) => {
    const draft = 'PP-draft-keep';
    assert.equal(panelPath(await frame(session, '面板/初始')), null, '默认应收起项目面板');
    assert.match(await frame(session, '面板/初始 sidebar'), /执行图侧栏/, '默认主界面保留 sidebar');
    await session.type(draft);
    assert((await frame(session, '面板/草稿')).includes(draft), '普通字符应写入 composer 草稿');

    const opened = await tap(session, ['ctrl', 'b'], '面板/Ctrl+B');
    assert.equal(panelPath(opened), '总览', 'Ctrl+B 应打开项目面板总览');
    assert(opened.includes(draft), '宽屏项目面板使用 sidebar 区域，对话草稿仍可见');
    assert(!opened.includes('执行图侧栏'), '宽屏项目面板替换 sidebar 区域的内容');
    assert(!opened.includes('已接受'), '项目面板不重复 sidebar 的执行进度');
    await session.type('panel-input-must-not-edit');
    for (const target of ['待答列表', '最近事件', '总览']) {
      assert.equal(panelPath(await tap(session, 'tab', `面板/Tab→${target}`)), target, `Tab 应切到${target}`);
    }
    assert.equal(panelPath(await tap(session, 'tab', '面板/Tab→待答')), '待答列表', 'Tab 应切到待答');

    const closed = await tap(session, ['ctrl', 'b'], '面板/Ctrl+B 关闭');
    assert.equal(panelPath(closed), null, 'Ctrl+B 应再次收起面板');
    assert(closed.includes(draft), '收起面板不应丢失草稿');
    assert.match(closed, /执行图侧栏/, '关闭面板恢复 sidebar');
    assert(!closed.includes('panel-input-must-not-edit'), '面板中输入不应修改聊天草稿');
    assert.equal(panelPath(await tap(session, ['ctrl', 'b'], '面板/Ctrl+B 重开')), '待答列表', '重开还原原栏目');
  });
}

/** 外框是用户要求的稳定布局：栏目、长详情、空列表与审阅均不得改变其位置和尺寸。 */
async function checkStableLayout(variant) {
  for (const size of SIZES) {
    await run('planning', variant, size, async (session) => {
      const draft = 'PP-layout-anchor';
      await session.type(draft);
      const bounds = (text) => {
        const lines = text.split('\n');
        const top = lines.findIndex((line) => /╭─+╮/.test(line));
        assert(top >= 0, '项目面板外框应可见');
        const start = lines[top].indexOf('╭');
        const left = displayWidth(lines[top].slice(0, start));
        const width = displayWidth(lines[top].slice(start));
        const bottom = lines.findIndex((line, index) => index > top && /╰─+╯/.test(line)
          && displayWidth(line.slice(0, line.indexOf('╰'))) === left);
        assert(bottom > top, '项目面板底边应可见');
        return { left, top, width, height: bottom - top + 1 };
      };
      const opened = await tap(session, ['ctrl', 'b'], '布局/总览');
      const expected = bounds(opened);
      assert.equal(opened.includes(draft), size[0] >= 100, '宽屏保留对话，窄屏仅显示项目面板');
      assert.equal(expected.left, size[0] >= 100 ? size[0] - expected.width : 0, '面板使用 sidebar 区域或整个主区域');
      assert.equal(expected.height, size[1] - 4, '面板占满固定主区域高度');
      const same = (text) => assert.deepEqual(bounds(text), expected, '切换内容不能移动或改变项目面板尺寸');
      same(await tap(session, 'tab', '布局/空待答'));
      same(await tap(session, 'tab', '布局/事件'));
      same(await tap(session, 'enter', '布局/事件详情'));
      same(await tap(session, 'esc', '布局/返回事件'));
      same(await tap(session, 'tab', '布局/返回总览'));
      await tap(session, 'down', '布局/预算');
      same(await tap(session, 'enter', '布局/预算详情'));
      same(await tap(session, 'esc', '布局/返回总览'));
      await tap(session, 'down', '布局/候选授权');
      same(await tap(session, 'enter', '布局/审阅'));
      same(await tap(session, 'esc', '布局/返回审阅入口'));
      await tap(session, 'down', '布局/项目资料');
      await tap(session, 'down', '布局/工作记录');
      same(await tap(session, 'enter', '布局/长列表'));
      same(await tap(session, 'enter', '布局/工作依据'));
    });
  }
}

/** 缩到 50 列后按显示宽度重排，且不丢草稿。 */
async function checkResize(variant) {
  await run('execution', variant, [120, 40], async (session) => {
    const draft = 'PP-resize-keep';
    await session.type(draft);
    assert((await frame(session, '缩窄/宽')).includes(draft), '宽屏应显示草稿');

    session.resize({ cols: 50, rows: 40 });
    const narrow = await settled(session, '缩窄/窄',
      (text) => text.includes(draft) && text.split('\n').every((line) => displayWidth(line.trimEnd()) <= 50));
    const over = narrow.split('\n').filter((line) => displayWidth(line.trimEnd()) > 50);
    assert.equal(over.length, 0, `缩至 50 列后仍超宽：${JSON.stringify(over.slice(0, 3))}`);
    assert(narrow.includes(draft), '缩窄终端不应丢失草稿');
  });
}

/** Ctrl+N 事件到达：事件数与未读标记更新，面板保持，草稿不丢。 */
async function checkEvent(variant) {
  await run('planning', variant, STAGE, async (session) => {
    const draft = 'PP-event-keep';
    await session.type(draft);
    await session.press(['ctrl', 'b']);
    await tap(session, 'tab', '事件/Tab1');
    const before = await tap(session, 'tab', '事件/Tab2');
    assert.equal(panelPath(before), '最近事件', '应切到最近事件');
    const countBefore = Number(before.match(/最近 (\d+) 条/)?.[1]);
    const after = await tap(session, ['ctrl', 'n'], '事件/Ctrl+N');
    assert.equal(Number(after.match(/最近 (\d+) 条/)?.[1]), countBefore + 1, 'Ctrl+N 应带来一条新事件');
    assert.match(after, /新消息/, '事件到达应标记未读');
    assert.equal(panelPath(after), '最近事件', '事件到达时面板应保持');
    assert((await tap(session, ['ctrl', 'b'], '事件/收起')).includes(draft), '事件到达不应丢失草稿');
  });
}

/** Ctrl+G 打开执行图，Enter 下钻节点详情，Esc 逐层退出；用面板路径标题识别。 */
async function checkGraph(variant) {
  await run('execution', variant, STAGE, async (session) => {
    const graph = await tap(session, ['ctrl', 'g'], '图/Ctrl+G');
    assert.equal(panelPath(graph), null, '图检查独立于项目面板');
    assert.equal(inspectorPath(graph), '执行图', 'Ctrl+G 打开独立图检查');
    assert.equal(inspectorPath(await tap(session, 'enter', '图/Enter')), '执行图 › 详情', 'Enter 下钻');
    assert.equal(inspectorPath(await tap(session, 'esc', '图/Esc')), '执行图', 'Esc 返回图');
    assert.match(await tap(session, 'esc', '图/Esc2'), /执行图侧栏/, '退出检查回 sidebar');
  });
}

/** 面板打开时连续 resize（120→80×24→50×40→120），栏目与图选择维持。 */
async function checkPanelResize(variant) {
  await run('execution', variant, [120, 40], async (session) => {
    await session.press(['ctrl', 'b']);
    for (let step = 0; step < 4; step += 1) await tap(session, 'down', '面板尺寸/选工作记录');
    await tap(session, 'enter', '面板尺寸/记录');
    assert.equal(panelPath(await tap(session, 'enter', '面板尺寸/详情')), '总览 › 工作记录 › 详情');
    for (const [cols, rows] of [[80, 24], [50, 40], [120, 40]]) {
      session.resize({ cols, rows });
      const resized = await settled(session, `面板尺寸/${String(cols)}x${String(rows)}`, (text) => /ID：wp-1/.test(text)
        && panelPath(text) === '总览 › 工作记录 › 详情');
      assert.equal(panelPath(resized), '总览 › 工作记录 › 详情', 'resize 保留详情');
      assert.match(resized, /ID：wp-1/, 'resize 保留对象');
      if (cols < 100) assert(!resized.includes('执行图侧栏'), '窄屏项目面板全屏');
    }
    assert.match(await tap(session, ['ctrl', 'b'], '面板尺寸/关闭'), /执行图侧栏/, '宽屏关闭恢复 sidebar');
  });
}

/** 项目面板提供工作记录和完整依据，不重复状态摘要。 */
async function checkDrilldown(variant) {
  await run('blocked', variant, STAGE, async (session) => {
    await session.press(['ctrl', 'b']);
    for (let step = 0; step < 4; step += 1) await tap(session, 'down', '下钻/工作记录');
    assert.equal(panelPath(await tap(session, 'enter', '下钻/记录')), '总览 › 工作记录');
    assert.equal(panelPath(await tap(session, 'enter', '下钻/详情')), '总览 › 工作记录 › 详情');
    assert.equal(panelPath(await tap(session, 'esc', '下钻/Esc 返回')), '总览 › 工作记录');
    assert.equal(panelPath(await tap(session, 'esc', '下钻/Esc 总览')), '总览');
    assert.equal(panelPath(await tap(session, 'esc', '下钻/Esc 关闭')), null, 'Esc 应逐层退出面板');
  });
}

/** 授权审阅弹窗：Esc 返回原面板并保持原焦点。 */
async function checkReview(variant) {
  await run('planning', variant, STAGE, async (session) => {
    await session.press(['ctrl', 'b']);
    let text = await frame(session, '审阅/总览');
    for (let step = 0; step < 8 && !/›.*查看候选授权/.test(text); step += 1) {
      text = await tap(session, 'down', `审阅/↓${String(step)}`);
    }
    assert.match(text, /›.*查看候选授权/, '应能选中“查看候选授权”行');
    assert.match(await tap(session, 'enter', '审阅/打开'), /授权审阅/, '应打开授权审阅弹窗');
    const back = await tap(session, 'esc', '审阅/Esc 返回');
    assert.equal(panelPath(back), '总览', 'Esc 应返回原面板');
    assert.match(back, /›.*查看候选授权/, 'Esc 应保持原焦点');
  });
}

/** 源 S-A 写草稿 → 总览选待答行 → 待答列表选第 3 条 S-B → 提交回答 → Ctrl+R 回原列表与 S-A。 */
async function checkAnswer(variant) {
  await run('answer', variant, STAGE, async (session) => {
    const draft = 'PP-source-S-A';
    await session.type(draft);
    assert((await frame(session, '待答/草稿')).includes(draft), 'S-A 草稿应显示在 composer');

    await session.press(['ctrl', 'b']);
    assert.equal(panelPath(await frame(session, '待答/总览')), '总览', 'Ctrl+B 应打开总览');
    assert.equal(panelPath(await tap(session, 'enter', '待答/列表')), '总览 › 待答列表', '总览应能打开待答列表');
    await tap(session, 'down', '待答/下1');
    await tap(session, 'down', '待答/下2');
    const answering = await tap(session, 'enter', '待答/回答');
    assert.equal(sessionOf(answering), 'S-B', '选中第 3 条应切到 S-B');
    assert.equal(panelPath(answering), null, '进入回答应关闭项目面板');
    assert.equal(modeOf(answering), '回答', 'footer 应进入回答模式');

    await session.type('PP-reply-S-B');
    await session.press('enter');
    const back = await tap(session, ['ctrl', 'r'], '待答/返回');
    assert.equal(panelPath(back), '总览 › 待答列表', 'Ctrl+R 应回原待答列表');
    assert.equal(sessionOf(back), 'S-A', 'Ctrl+R 应回到源会话 S-A');
    const closed = await tap(session, ['ctrl', 'b'], '待答/收起');
    assert.equal(panelPath(closed), null, 'Ctrl+B 应收起面板');
    assert(closed.includes(draft), '源会话草稿应保留');
  });
}

/** Ctrl+U：图与问题正文都不可读；不可读的问题不能进入回答模式或假提交。 */
async function checkUnavailable(variant) {
  await run('answer', variant, STAGE, async (session) => {
    const missing = await tap(session, ['ctrl', 'u'], '缺失/Ctrl+U');
    assert.match(missing, /问题正文不可读/, 'Ctrl+U 后问题正文应不可读');
    assert.match(await tap(session, ['ctrl', 'g'], '缺失/图'), /图不可读 · 不能视为空图/, 'Ctrl+U 后执行图应不可读');
    await tap(session, 'esc', '缺失/Esc');
    await session.press(['ctrl', 'b']);
    await tap(session, 'enter', '缺失/列表');
    await tap(session, 'down', '缺失/下1');
    await tap(session, 'down', '缺失/下2');
    const refused = await tap(session, 'enter', '缺失/尝试回答');
    assert.equal(panelPath(refused), '总览 › 待答列表', '不可读问题不应离开待答列表');
    assert.notEqual(modeOf(refused), '回答', '不可读问题不应进入回答模式');
    assert.match(refused, /不能回答/, '应提示问题不可读不能回答');
  });
}

/** Ctrl+T 循环三方案、Ctrl+Y 循环五场景；只读 footer 语义。 */
async function checkCycles(variant) {
  await run('planning', variant, STAGE, async (session) => {
    const seen = [variantOf(await frame(session, '切换/方案0'))];
    for (let index = 1; index <= 3; index += 1) {
      seen.push(variantOf(await tap(session, ['ctrl', 't'], `切换/方案${String(index)}`)));
    }
    assert.deepEqual([...new Set(seen)].sort(), [...Object.values(VARIANTS)].sort(), 'Ctrl+T 应覆盖三种方案');
    assert.equal(seen[3], seen[0], '循环三次应回到起始方案');

    const scenes = [];
    for (let index = 0; index < SCENES.length; index += 1) {
      scenes.push(sceneOf(await frame(session, `切换/场景${String(index)}`)));
      await tap(session, ['ctrl', 'y'], `切换/场景键${String(index)}`);
    }
    assert.deepEqual([...scenes].sort(), [...SCENES].sort(), 'Ctrl+Y 应覆盖五种场景');
    assert.equal(sceneOf(await frame(session, '切换/场景循环')), scenes[0], '循环五次应回到起始场景');
  });
}

async function checkExit(variant) {
  const session = await open('planning', variant, STAGE);
  try {
    await frame(session, '退出/前');
    session.sendKey(['ctrl', 'c']);
    assert(await session.waitForExit(5000), 'Ctrl+C 应退出 TUI');
    assert.equal(session.exitInfo?.exitCode, 0, `Ctrl+C 退出码应为 0，实际 ${String(session.exitInfo?.exitCode)}`);
  } finally {
    session.close();
  }
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

async function capture(variantArg) {
  const variants = variantArg === null ? Object.keys(VARIANTS) : [variantArg];
  assert(variants.every((name) => name in VARIANTS), `--variant 只能是 ${Object.keys(VARIANTS).join(' / ')}`);
  mkdirSync(HERE, { recursive: true });
  const fromTuistory = createRequire(createRequire(import.meta.url).resolve('tuistory'));
  const { renderTerminalToImage } = await import(fromTuistory.resolve('ghostty-opentui/image'));
  const shoot = async (session, name, panelOpen) => {
    const text = await session.text({ trimEnd: true });
    assert(!hasAnsi(text), `${name}：应无色，实际含 ANSI 转义`);
    assert.equal(panelPath(text) !== null, panelOpen, `${name}：面板开合状态不符`);
    if (!panelOpen) assert.match(text, /执行图侧栏/, '主界面默认保留 sidebar');
    assert.match(text, /\^Y/, `${name}：footer 应显示 ^Y（旧 build 会显示 ^M）`);
    writeFileSync(join(HERE, `${name}.txt`), `${text}\n`);
    writeFileSync(join(HERE, `${name}.png`), await renderTerminalToImage(session.getTerminalData(), { format: 'png' }));
    process.stdout.write(`采集 ${name}\n`);
  };
  for (const variant of variants) {
    for (const scene of SCENES) {
      for (const [cols, rows] of SIZES) {
        await run(scene, variant, [cols, rows], async (session) => {
          await session.press(['ctrl', 'b']);
          await shoot(session, `${variant}-${scene}-${String(cols)}x${String(rows)}`, true);
        });
      }
    }
    await run('execution', variant, STAGE, (session) => shoot(session, `main-${variant}-${String(STAGE[0])}x${String(STAGE[1])}`, false));
  }
  process.stdout.write(`完成：写入 ${HERE}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--capture')) {
    await capture(flagValue(args, '--variant'));
    return;
  }
  const variant = flagValue(args, '--variant') ?? 'tabs';
  assert(variant in VARIANTS, `--variant 只能是 ${Object.keys(VARIANTS).join(' / ')}`);
  const cases = [
    ['面板开合与栏目循环', () => checkPanel(variant)],
    ['三档尺寸下布局稳定', () => checkStableLayout(variant)],
    ['缩窄重排与草稿', () => checkResize(variant)],
    ['事件到达不丢', () => checkEvent(variant)],
    ['执行图下钻返回', () => checkGraph(variant)],
    ['面板尺寸与对象选择', () => checkPanelResize(variant)],
    ['工作依据下钻返回', () => checkDrilldown(variant)],
    ['授权审阅返回', () => checkReview(variant)],
    ['跨会话回答返回', () => checkAnswer(variant)],
    ['缺失事实不可用', () => checkUnavailable(variant)],
    ['方案与场景切换', () => checkCycles(variant)],
    ['Ctrl+C 退出', () => checkExit(variant)],
  ];
  for (const [name, runCase] of cases) {
    await runCase();
    process.stdout.write(`✓ ${name}\n`);
  }
  process.stdout.write(`行为检查通过：${String(cases.length)} 项 ${ENTRY.join(' ')}\n`);
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
