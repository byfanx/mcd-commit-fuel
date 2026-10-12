import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, formatDuration, renderReceipt, truncate, RECEIPT_WIDTH } from './receipt.js';
import type { DailyStats } from './stats.js';
import type { NutritionFood } from './nutrition.js';
import { MINUTE } from './time.js';

const T = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();

const STATS: DailyStats = {
  date: '2026-10-10',
  commits: 12,
  reverts: 1,
  releases: 0,
  testsPassed: 8,
  testsFailed: 3,
  buildMs: 14 * MINUTE,
  firstTs: T(9, 5),
  lastTs: T(18, 40),
};

const apple: NutritionFood = {
  name: '苹果片',
  energyKj: 133,
  energyKcal: 32,
  protein: 0,
  fat: 0,
  carbohydrate: 7,
  sodium: 0,
  calcium: 18,
};

test('receipt has counts and a light pick with nutrition, no disclaimer', () => {
  const r = renderReceipt({
    stats: STATS,
    data: {
      nutrition: [apple],
      account: { availablePoints: 1200.5, expiringThisMonth: 0, expiringNextMonth: 0 },
      myCoupons: { total: 8, coupons: [] },
    },
    lateNight: false,
    printedAt: T(18, 40),
  });
  assert.doesNotMatch(r, /非麦当劳官方产品|参赛/);
  assert.match(r, /提交 +x 12/);
  assert.match(r, /Revert +x 1/);
  assert.match(r, /测试 +通过 8 \/ 失败 3/);
  assert.match(r, /14 分钟/);
  assert.match(r, /时间 +18:40/);
  assert.doesNotMatch(r, /时段/);
  assert.match(r, /苹果片/);
  assert.match(r, /32 kcal/);
  assert.match(r, /积分 +1200/);
  assert.match(r, /可用券 +8 张/);
  assert.doesNotMatch(r, /发版/);
});

test('every line fits the receipt width', () => {
  const longName = { ...apple, name: '一个名字特别特别特别长的轻食苹果片' };
  const r = renderReceipt({ stats: STATS, data: { nutrition: [longName] }, lateNight: false });
  for (const line of r.split('\n')) assert.ok(displayWidth(line) <= RECEIPT_WIDTH, `too wide: ${line}`);
});

test('without data it still renders and suggests water', () => {
  const r = renderReceipt({
    stats: { ...STATS, firstTs: undefined as never, lastTs: undefined as never },
    data: {},
    lateNight: true,
  });
  assert.match(r, /喝杯水/);
  assert.doesNotMatch(r, /积分/);
});

test('helpers', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('提交'), 4);
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('提交提交', 5), '提交…');
  assert.equal(truncate('ok', 4), 'ok');
  assert.equal(formatDuration(0), '0 分钟');
  assert.equal(formatDuration(59 * MINUTE), '59 分钟');
  assert.equal(formatDuration(60 * MINUTE), '1 小时');
  assert.equal(formatDuration(95 * MINUTE), '1 小时 35 分钟');
});
