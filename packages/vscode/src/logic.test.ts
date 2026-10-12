import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, type CachedView } from '@mcd-commit-fuel/core';
import {
  ExecutionTracker,
  MIN_AUTO_REFRESH_GAP_MS,
  claimResultDetail,
  couponEntries,
  orderConfirmDetail,
  readSettings,
  shouldRefresh,
  taskCategory,
  teamConfirmDetail,
  toPickEntries,
} from './logic.js';

test('taskCategory prefers the task group, then name and command line', () => {
  assert.equal(taskCategory({ name: 'whatever', groupId: 'test' }), 'test');
  assert.equal(taskCategory({ name: 'whatever', groupId: 'build' }), 'build');
  assert.equal(taskCategory({ name: 'npm: test' }), 'test');
  assert.equal(taskCategory({ name: 'compile', commandLine: 'tsc -b' }), 'build');
  assert.equal(taskCategory({ name: 'serve', commandLine: 'python -m http.server' }), 'other');
});

test('ExecutionTracker pairs start/end and ignores other', () => {
  const tracker = new ExecutionTracker<object>('p');
  const a = {};
  const b = {};
  const start = tracker.start(a, 'test', 1000);
  assert.deepEqual(start, { kind: 'task-start', ts: 1000, id: 'p-1000-1', category: 'test' });
  assert.equal(tracker.start(b, 'other', 1000), undefined);

  assert.deepEqual(tracker.end(a, 1, 5000), { kind: 'task-end', ts: 5000, id: 'p-1000-1', category: 'test', exitCode: 1 });
  assert.equal(tracker.end(a, 0, 6000), undefined, 'ending twice yields nothing');
  assert.equal(tracker.end(b, 0, 6000), undefined, 'untracked execution yields nothing');

  const c = {};
  tracker.start(c, 'build', 7000);
  assert.deepEqual(tracker.end(c, undefined, 8000), { kind: 'task-end', ts: 8000, id: 'p-7000-2', category: 'build' });
});

test('readSettings applies defaults and lower bounds', () => {
  const defaults = readSettings(() => undefined);
  assert.deepEqual(defaults, {
    pollMs: 30 * MINUTE,
    dailyNudgeLimit: 2,
    releaseTagPattern: '^v?\\d+\\.\\d+\\.\\d+',
    trackTerminal: true,
    state: { buildMinutes: 3, lateNightEnabled: true },
  });

  const values: Record<string, unknown> = {
    pollMinutes: 1,
    dailyNudgeLimit: 3.7,
    buildMinutes: 0,
    lateNight: false,
    trackTerminal: 'yes',
    releaseTagPattern: '  ',
  };
  const s = readSettings((k) => values[k]);
  assert.equal(s.pollMs, 5 * MINUTE);
  assert.equal(s.dailyNudgeLimit, 3);
  assert.deepEqual(s.state, { buildMinutes: 1, lateNightEnabled: false });
  assert.equal(s.trackTerminal, true);
  assert.equal(s.releaseTagPattern, '^v?\\d+\\.\\d+\\.\\d+');
});

test('shouldRefresh', () => {
  const base = { focused: true, now: 100 * MINUTE, pollMs: 30 * MINUTE, stateChanged: false };
  assert.equal(shouldRefresh({ ...base }), true, 'never refreshed');
  assert.equal(shouldRefresh({ ...base, lastRefreshAt: 90 * MINUTE }), false);
  assert.equal(shouldRefresh({ ...base, lastRefreshAt: 70 * MINUTE }), true);
  assert.equal(shouldRefresh({ ...base, lastRefreshAt: 99 * MINUTE, stateChanged: true }), true);
  assert.equal(shouldRefresh({ ...base, focused: false }), false);
  assert.equal(
    shouldRefresh({ ...base, stateChanged: true, lastAttemptAt: base.now - MIN_AUTO_REFRESH_GAP_MS + 1 }),
    false,
    'rate limited',
  );
});

test('toPickEntries lists view items then actions without duplicates', () => {
  const view: CachedView = {
    state: 'wrapup',
    lateNight: false,
    quiet: false,
    text: '🧾 收工了 · 今日小票',
    items: [
      { label: '查看今日小票', action: 'receipt' },
      { label: '积分 1200', description: '近期没有过期积分' },
    ],
    computedAt: 0,
  };
  const entries = toPickEntries(view, true);
  assert.deepEqual(
    entries.map((e) => [e.label, e.action ?? null, e.separator ?? false]),
    [
      ['查看今日小票', 'receipt', false],
      ['积分 1200', null, false],
      ['操作', null, true],
      ['$(refresh) 立即刷新', 'refresh', false],
      ['$(coffee) 点一份餐品', 'order', false],
      ['$(organization) 请团队吃一顿', 'teamMeal', false],
      ['$(gift) 领取可领的券', 'claimCoupons', false],
      ['$(trash) 清除 MCP token', 'clearToken', false],
    ],
  );
  assert.equal(entries[1]?.description, '近期没有过期积分');

  // 没有 token 时不提供写操作
  const noToken = toPickEntries(undefined, false).map((e) => e.action);
  assert.deepEqual(noToken, [undefined, 'refresh', 'receipt', 'setToken']);
});

test('toPickEntries keeps coupon actions only with a token', () => {
  const view: CachedView = {
    state: 'idle',
    lateNight: false,
    quiet: false,
    text: '🍟 1分 · 1券',
    items: [{ label: '美式中杯', description: '到期 2026-12-31', action: 'useCoupon', coupon: { id: 'c1', title: '美式中杯' } }],
    computedAt: 0,
  };
  const withToken = toPickEntries(view, true)[0];
  assert.equal(withToken?.action, 'useCoupon');
  assert.deepEqual(withToken?.coupon, { id: 'c1', title: '美式中杯' });

  const without = toPickEntries(view, false)[0];
  assert.equal(without?.label, '美式中杯');
  assert.equal(without?.action, undefined);
  assert.equal(without?.coupon, undefined);
});

test('orderConfirmDetail lists store, item, kcal, take-away and price', () => {
  const text = orderConfirmDetail({
    storeName: '示例门店',
    itemName: '麦咖啡™热美式中杯',
    kcal: 13,
    takeWay: '外带',
    price: 1190,
    discount: 710,
  });
  assert.match(text, /门店：示例门店（到店自取）/);
  assert.match(text, /餐品：麦咖啡™热美式中杯 × 1（13 kcal）/);
  assert.match(text, /取餐方式：外带/);
  assert.match(text, /应付：¥11\.9（已优惠 ¥7\.1）/);
  assert.match(text, /create-order/);
  assert.doesNotMatch(text, /非麦当劳官方产品|参赛/);
  assert.doesNotMatch(orderConfirmDetail({ storeName: 'a', itemName: 'b', kcal: 1, takeWay: 'c', price: 100, discount: 0 }), /已优惠/);

  // 用券下单：列出券名；营养表里找不到时不显示热量
  const withCoupon = orderConfirmDetail({
    storeName: '示例门店',
    itemName: '麦咖啡™美式',
    couponTitle: '麦咖啡™美式中杯',
    takeWay: '堂食',
    price: 0,
    discount: 1900,
  });
  assert.match(withCoupon, /餐品：麦咖啡™美式 × 1\n/);
  assert.match(withCoupon, /优惠券：麦咖啡™美式中杯/);
  assert.match(withCoupon, /应付：¥0（已优惠 ¥19）/);
});

test('teamConfirmDetail lists address, people, dishes, kcal and per-person price', () => {
  const text = teamConfirmDetail({
    storeName: '示例团餐店',
    addressLabel: '上海市示例区…大厦8楼',
    serviceName: '保鲜速达',
    plan: {
      people: 3,
      lines: [
        { code: 'm1', name: '麦香鱼', quantity: 3, kcal: 350, role: 'main' },
        { code: 'd1', name: '无糖可口可乐', quantity: 3, kcal: 0, role: 'drink' },
      ],
      kcalPerPerson: 350,
    },
    quote: { price: 13400, discount: 110, deliveryPrice: 600, packingPrice: 300 },
  });
  assert.match(text, /门店：示例团餐店（团餐外送）/);
  assert.match(text, /送达：上海市示例区…大厦8楼/);
  assert.match(text, /人数：3 人/);
  assert.match(text, /麦香鱼 × 3（350 kcal\/份）/);
  assert.match(text, /人均约 350 kcal/);
  assert.match(text, /费用：配送费 ¥6 · 打包费 ¥3/);
  assert.match(text, /应付：¥134（已优惠 ¥1\.1），人均 ¥44\.67/);
});

test('couponEntries groups expiring, pickup and delivery-only coupons', () => {
  const entries = couponEntries([
    { id: 'b', title: '外送券', endDate: '2026-10-12', daysLeft: 2, count: 1, pickup: false, expiring: true },
    { id: 'a', code: 'a-1', title: '美式', endDate: '2026-12-31', daysLeft: 82, count: 2, pickup: true, expiring: false },
    { id: 'd', title: '外送长期券', count: 1, pickup: false, expiring: false },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.label, e.separator ?? false, e.action ?? null]),
    [
      ['3 天内到期', true, null],
      ['外送券', false, null],
      ['到店可用', true, null],
      ['美式 ×2', false, 'useCoupon'],
      ['仅外送可用', true, null],
      ['外送长期券', false, null],
    ],
  );
  assert.equal(entries[1]?.description, '2 天后到期 · 2026-10-12');
  assert.equal(entries[1]?.detail, undefined, 'section title already says delivery only');
  assert.deepEqual(entries[3]?.coupon, { id: 'a', code: 'a-1', title: '美式' });
  assert.equal(entries[3]?.detail, undefined, 'no repeated hint under each pickup coupon');
  assert.equal(entries[5]?.description, '长期有效');
});

test('claimResultDetail lists claimed and remaining coupons', () => {
  const ok = claimResultDetail(
    { claimed: [{ name: '厚松饼套餐', count: 2 }, { name: '中薯条买一送一', count: 1 }], remaining: [{ name: '限量券', count: 1 }] },
    'x',
  );
  assert.equal(ok.title, '本次领到 3 张券');
  assert.equal(ok.detail, '· 厚松饼套餐 ×2\n· 中薯条买一送一\n\n以下券没有领到（可能已领完或有限制）：\n· 限量券');
  assert.equal(claimResultDetail({ claimed: [], remaining: [] }, '已提交').title, '这次没有领到券');
  assert.match(claimResultDetail(undefined, '领取 3 张').detail, /^领取 3 张\n/);
});
