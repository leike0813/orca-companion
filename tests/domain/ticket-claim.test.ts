/**
 * Ticket Claim 与 Frontier 领域行为测试（change: `m1-plan-and-authorize-execution`，Owner: IP-2）。
 *
 * 覆盖 Requirement「Ticket Claim binds a ticket to one Session」下的 Scenario：
 * - 已认领票据不出现在 Frontier：开放且未阻塞的票据被任一 Session 的 active Claim 持有即被投影排除。
 * - 进程退出不释放认领：活跃性只看 Claim 的 state，不读时钟或进程存活。
 * 另外覆盖 Frontier 的其余门禁输入（blockedBy、resolved）、`claimBlocker`、`claimedTickets`
 * 与进入 Execution Coordination 前的 `hasOpenPlanningWork`。
 */

import { expect, test } from 'vitest';

import type { CoordinatorSessionId, EntityRef } from '../../src/application/dto/identity.js';
import {
  type DecisionTicket,
  type DecisionTicketState,
} from '../../src/domain/planning/route-map.js';
import {
  type ClaimProjection,
  type TicketClaim,
  type TicketClaimState,
  activeClaimFor,
  claimBlocker,
  claimedTickets,
  hasOpenPlanningWork,
  projectFrontier,
} from '../../src/domain/planning/ticket-claim.js';

const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

function ticket(
  id: string,
  options: {
    readonly state?: DecisionTicketState;
    readonly blockedBy?: readonly EntityRef<'decision-ticket'>[];
    readonly assignee?: string | null;
  } = {},
): DecisionTicket {
  return {
    ticketRef: { kind: 'decision-ticket', id, version: 1 },
    state: options.state ?? 'open',
    blockedBy: options.blockedBy ?? [],
    assignee: options.assignee ?? null,
  };
}

function claim(
  id: string,
  session: CoordinatorSessionId,
  state: TicketClaimState = 'active',
): ClaimProjection {
  return { ticketRef: { kind: 'decision-ticket', id }, coordinatorSessionId: session, state };
}

test('已被某个 Session 认领的开放票据不出现在 Frontier', () => {
  const tickets = [ticket('t-1')];

  const claimed = projectFrontier({ tickets, claims: [claim('t-1', SESSION_B)] });
  expect(claimed).toEqual([]);

  const unclaimed = projectFrontier({ tickets, claims: [] });
  expect(unclaimed.map((item) => item.ticketRef.id).sort()).toEqual(['t-1']);
});

test('Claim 不随 Runtime Incarnation 退出而释放，活跃性只看 state', () => {
  const longLived: TicketClaim = {
    ticketRef: { kind: 'decision-ticket', id: 't-1' },
    coordinatorSessionId: SESSION_B,
    state: 'active',
    claimedAt: 1,
  };
  const ref: EntityRef<string> = { kind: 'decision-ticket', id: 't-1' };

  expect(longLived.claimedAt).toBe(1);
  expect(activeClaimFor([longLived], ref)).not.toBeNull();
  expect(claimBlocker([longLived], ref)).toEqual({ kind: 'claimed', claim: longLived });
  expect(projectFrontier({ tickets: [ticket('t-1')], claims: [longLived] })).toEqual([]);
});

test('completed / released 的 Claim 不阻止票据出现在 Frontier', () => {
  const ref: EntityRef<string> = { kind: 'decision-ticket', id: 't-1' };

  for (const state of ['completed', 'released'] as const) {
    const claims = [claim('t-1', SESSION_B, state)];

    expect(activeClaimFor(claims, ref)).toBeNull();
    expect(claimBlocker(claims, ref)).toBeNull();
    expect(projectFrontier({ tickets: [ticket('t-1')], claims }).map((item) => item.ticketRef.id)).toEqual([
      't-1',
    ]);
  }
});

test('被阻塞或已解决的票据不出现在 Frontier', () => {
  const tickets = [
    ticket('t-open'),
    ticket('t-blocked', { blockedBy: [{ kind: 'decision-ticket', id: 't-open' }] }),
    ticket('t-resolved', { state: 'resolved' }),
  ];

  const frontier = projectFrontier({ tickets, claims: [] });
  expect(frontier.map((item) => item.ticketRef.id).sort()).toEqual(['t-open']);
});

test('claimBlocker 只在存在他人 active Claim 时报告阻塞', () => {
  const ref: EntityRef<string> = { kind: 'decision-ticket', id: 't-1' };

  expect(claimBlocker([], ref)).toBeNull();

  const held = claim('t-1', SESSION_B);
  const blocker = claimBlocker([held], ref);
  expect(blocker?.kind).toBe('claimed');
  expect(blocker?.claim.coordinatorSessionId).toBe(SESSION_B);
  expect(blocker?.claim.ticketRef.id).toBe('t-1');
});

test('claimedTickets 只返回指定 Session 的 active 票据', () => {
  const claims = [
    claim('t-1', SESSION_A, 'active'),
    claim('t-2', SESSION_A, 'released'),
    claim('t-3', SESSION_B, 'active'),
    claim('t-4', SESSION_A, 'active'),
    claim('t-5', SESSION_A, 'completed'),
  ];

  expect(claimedTickets(claims, SESSION_A).map((ref) => ref.id).sort()).toEqual(['t-1', 't-4']);
  expect(claimedTickets(claims, SESSION_B).map((ref) => ref.id)).toEqual(['t-3']);
  expect(claimedTickets([], SESSION_A)).toEqual([]);
});

test('frontier 非空或 fog 非空白即存在未完成的规划工作', () => {
  expect(hasOpenPlanningWork({ frontier: [ticket('t-1')], fog: '' })).toBe(true);
  expect(hasOpenPlanningWork({ frontier: [], fog: '还有雾' })).toBe(true);
  expect(hasOpenPlanningWork({ frontier: [], fog: '   \n\t ' })).toBe(false);
  expect(hasOpenPlanningWork({ frontier: [], fog: '' })).toBe(false);
});
