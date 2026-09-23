/**
 * 授权后工作区连续性（`tui/execution-monitoring`，Owner: `m2-deliver-execution-tui`）。
 *
 * 断言的是用户可观察事实：Scope 从 route_planning 切到 execution_coordination（模式、授权与 Graph
 * Generation 都变了）之后，transcript 与 composer 草稿仍是原内容，顶栏换成新的 Generation /
 * Authorization / active 计数；进程重启遇到未对账事实时先显示 reconciling，且不产生任何新的派发或
 * 集成意图（`execute` 调用计数为 0）。
 *
 * 快照刷新需要一个真实用户动作触发（`pause` 从不要求确认、也不重置草稿），因此这里用 Command Palette
 * 的 pause 提交一次意图并让容器重新读快照；断言只针对刷新前后的工作区内容与顶栏片段。
 */

import { describe, expect, test } from 'vitest';

import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import type { TuiPorts } from '../../src/interfaces/tui/ports.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  makeWorkPackageExecution,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

/** 打开 Command Palette 并选中第 `index` 个命令后执行。 */
async function runPaletteCommand(rendered: RenderedTui, index: number): Promise<void> {
  await pressKey(rendered, '\u0010');
  for (let step = 0; step < index; step += 1) {
    await pressKey(rendered, '\u001b[B');
  }
  await pressKey(rendered, '\r');
}

describe('execution-monitoring / 授权后工作区连续性', () => {
  test('Scenario: 授权不重置工作区', async () => {
    const planning = makeSnapshot({
      mode: 'route_planning',
      authorization: null,
      graph: { graphId: 'graph-1', graphVersion: 2, generation: 1 },
      frontier: [],
    });
    const authorized = makeSnapshot({
      mode: 'execution_coordination',
      authorization: { authorizationId: 'auth-1', version: 4 },
      executionLeaseHolderSessionId: 'session-a',
      graph: { graphId: 'graph-1', graphVersion: 2, generation: 2 },
      frontier: [
        makeWorkPackageExecution('wp-1', {
          state: 'implementing',
          role: 'implementation',
          attemptId: 'attempt-1',
          liveness: 'live',
          worktreePath: '/tmp/worktrees/wp-1',
          baselineHead: 'head-1',
        }),
      ],
    });

    let current = planning;
    let snapshotCalls = 0;
    const fake = createFakePorts();
    const ports: TuiPorts = {
      ...fake.ports,
      snapshot: (selectedSessionId) => {
        snapshotCalls += 1;
        return Promise.resolve({ kind: 'snapshot', snapshot: { ...current, selectedSessionId } });
      },
    };

    const rendered = renderTui(ports);
    await settle(12);

    // 授权前：规划态的工作区，transcript 与 composer 都是原内容。
    const before = frameText(rendered);
    expect(before).toContain('route_planning');
    expect(before).toContain('gen=1');
    expect(before).toContain('auth=none');
    expect(before).toContain('先看看地图');

    await pressKey(rendered, '继续实现 wp-1');
    expect(frameText(rendered)).toContain('继续实现 wp-1');

    // 上游完成授权：下一次读到的快照已经是 Execution Coordination。
    current = authorized;
    await runPaletteCommand(rendered, COMMAND_IDS.indexOf('pause'));

    expect(snapshotCalls).toBeGreaterThanOrEqual(2);
    expect(fake.executeIntents.filter((intent) => intent.kind === 'scope-control')).toHaveLength(1);

    const after = frameText(rendered);
    // 顶栏换成新的 Generation、Authorization 与 active Work Package 计数。
    expect(after).toContain('execution_coordination');
    expect(after).toContain('gen=2');
    expect(after).toContain('auth=auth-1 v4');
    expect(after).toContain('active=1');
    // 工作区没有被重置：transcript 条目与 composer 草稿都还在。
    expect(after).toContain('先看看地图');
    expect(after).toContain('好的');
    expect(after).toContain('继续实现 wp-1');
    // composer 仍可继续编辑（草稿不是只读展示）。
    await pressKey(rendered, '！');
    expect(frameText(rendered)).toContain('继续实现 wp-1！');

    rendered.unmount();
  });

  test('Scenario: 重启先对账', async () => {
    const fake = createFakePorts({
      snapshot: {
        mode: 'execution_coordination',
        executionReconciliation: {
          pending: true,
          unresolvedIntentCount: 2,
          activeWorkerCount: 1,
          reasons: ['worker 仍在运行', '存在未决 Operation Intent'],
        },
        frontier: [
          makeWorkPackageExecution('wp-1', {
            state: 'implementing',
            role: 'implementation',
            attemptId: 'attempt-1',
            liveness: 'unverifiable',
          }),
        ],
      },
    });

    const rendered = renderTui(fake.ports);
    await settle(12);

    const frame = frameText(rendered);
    // 先进入 reconciling 投影：Sidebar 头部与状态行都显示对账中（顶栏片段在 100 列下会被裁切）。
    expect(frame).toContain('reconciling');
    // 生命周期仍如实来自事实（不可核验的 Worker 不被读成已退出，也不被读成已完成）。
    expect(frame).toContain('wp-1 [implementing]');
    expect(frame).toContain('unverifiable');
    expect(frame).not.toContain('[accepted]');
    expect(frame).not.toContain('exited');
    // 对账完成前不出现新的派发或集成动作：重启本身不产生任何意图。
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});
