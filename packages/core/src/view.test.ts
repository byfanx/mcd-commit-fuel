import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCache, type CacheFile } from './cache.js';
import type { Signal } from './signals.js';
import { dailyStats } from './stats.js';
import { DAY, MINUTE } from './time.js';
import { computeView, isAuthFailed, toFuelData } from './view.js';

const NOW = new Date(2026, 9, 10, 14, 0).getTime();
const building: Signal[] = [{ kind: 'task-start', ts: NOW - 5 * MINUTE, id: 'b', category: 'build' }];

function cacheWith(signals: Signal[]): CacheFile {
  const c = emptyCache();
  c.signals = signals;
  c.data.account = { fetchedAt: NOW, value: { availablePoints: 100, expiringThisMonth: 0, expiringNextMonth: 0 } };
  c.data.myCoupons = { fetchedAt: NOW, value: { total: 2, coupons: [] } };
  return c;
}

/** 依次经过若干状态，返回每一步的 view。 */
function walk(steps: Signal[][], limit = 2, start = NOW) {
  let cache = cacheWith([]);
  return steps.map((signals, i) => {
    const now = start + i * MINUTE;
    const { view, throttle } = computeView({ ...cache, signals }, now, { hasToken: true, dailyNudgeLimit: limit });
    cache = { ...cache, view, throttle };
    return view;
  });
}

test('staying in the same state counts once', () => {
  const views = walk([building, building, building]);
  assert.deepEqual(
    views.map((v) => v.quiet),
    [false, false, false],
  );
});

test('third entry into a nudge state on the same day is quiet', () => {
  const views = walk([building, [], building, [], building]);
  assert.deepEqual(
    views.map((v) => [v.state, v.quiet]),
    [
      ['building', false],
      ['idle', false],
      ['building', false],
      ['idle', false],
      ['building', true],
    ],
  );
  assert.equal(views[4]?.text, '🍟 100分 · 2券');
});

test('counts reset on a new day', () => {
  const c = cacheWith(building);
  c.throttle = { date: '2026-10-09', counts: { building: 9 } };
  const { view, throttle } = computeView(c, NOW, { hasToken: true });
  assert.equal(view.quiet, false);
  assert.deepEqual(throttle, { date: '2026-10-10', counts: { building: 1 } });
});

test('idle and focus do not consume nudges', () => {
  const { throttle } = computeView(cacheWith([]), NOW, { hasToken: true });
  assert.deepEqual(throttle.counts, {});
});

test('toFuelData and isAuthFailed', () => {
  const c = cacheWith([]);
  assert.deepEqual(Object.keys(toFuelData(c.data)).sort(), ['account', 'myCoupons']);
  assert.equal(isAuthFailed(c.data), false);
  c.data.account = { ...c.data.account, errorAt: NOW + 1, errorKind: 'AUTH' };
  assert.equal(isAuthFailed(c.data), true);
  // 失败之后又成功过，就不算失效
  c.data.account = { ...c.data.account, fetchedAt: NOW + 2 };
  assert.equal(isAuthFailed(c.data), false);
});

test('dailyStats counts only today and sums task durations', () => {
  const s = (minutesAgo: number) => NOW - minutesAgo * MINUTE;
  const stats = dailyStats(
    [
      { kind: 'commit', ts: NOW - DAY + MINUTE, revert: false }, // 昨天
      { kind: 'commit', ts: s(120), revert: false },
      { kind: 'commit', ts: s(60), revert: true },
      { kind: 'tag', ts: s(50), release: true },
      { kind: 'task-start', ts: s(40), id: 't1', category: 'test' },
      { kind: 'task-end', ts: s(38), id: 't1', category: 'test', exitCode: 1 },
      { kind: 'task-start', ts: s(30), id: 't2', category: 'build' },
      { kind: 'task-end', ts: s(25), id: 't2', category: 'build', exitCode: 0 },
      { kind: 'task-end', ts: s(20), id: 't3', category: 'test', exitCode: 0 },
      { kind: 'task-start', ts: s(10), id: 'x', category: 'other' },
      { kind: 'task-end', ts: s(9), id: 'x', category: 'other', exitCode: 0 },
      { kind: 'commit', ts: NOW + MINUTE, revert: false }, // 未来
    ],
    NOW,
  );
  assert.deepEqual(stats, {
    date: '2026-10-10',
    commits: 2,
    reverts: 1,
    releases: 1,
    testsPassed: 1,
    testsFailed: 1,
    buildMs: 7 * MINUTE,
    firstTs: s(120),
    lastTs: s(9),
  });
});
