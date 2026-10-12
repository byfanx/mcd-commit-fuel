import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, expiringCoupons, groupCoupons, recommend, type FuelData } from './recommend.js';
import type { NutritionFood } from './nutrition.js';

const food = (name: string, energyKcal: number): NutritionFood => ({
  name,
  energyKj: Math.round(energyKcal * 4.184),
  energyKcal,
  protein: 1,
  fat: 0,
  carbohydrate: 5,
  sodium: 10,
  calcium: 20,
});

const FOODS: NutritionFood[] = [
  food('苹果片', 32),
  food('苹果片', 32),
  food('热美式中杯', 13),
  food('纯牛奶（盒装）', 129),
  food('皮蛋鸡肉粥', 133),
  food('冰浓浓抹茶牛奶中杯', 196),
  food('中薯条', 289),
  food('圆筒冰淇淋', 93),
  food('热牛奶大杯', 260),
];

const NOW = new Date(2026, 9, 10, 14, 0).getTime();

const DATA: FuelData = {
  account: { availablePoints: 1200.5, expiringThisMonth: 0, expiringNextMonth: 0 },
  myCoupons: {
    total: 8,
    coupons: [
      { id: 'c1', title: '晚到期券', endDate: '2026-12-31', orderTypes: [1] },
      { id: 'c2', title: '无日期券', orderTypes: [1] },
      { id: 'c3', title: '早到期券', endDate: '2026-10-20', orderTypes: [1] },
    ],
  },
  claimableCoupons: [{ name: '示例套餐', status: 'CAN_GET', label: '可领取' }],
  stores: [{ storeCode: '1000000001', storeName: '示例门店' }],
  storeCoupons: [
    { id: 's1', code: 'S1-A', title: '美式中杯', endDate: '2026-12-31', products: [{ code: 'p1', name: '美式' }] },
    { id: 's2', title: '奶铁中杯', products: [] },
  ],
  nutrition: FOODS,
  campaigns: [
    { date: '2026-10-09', title: '已结束的活动' },
    { date: '2026-10-10', title: '今天的活动' },
    { date: '2026-10-12', title: '以后的活动' },
    { date: '2026-10-13', title: '以后的活动' },
  ],
};

const base = { lateNight: false, now: NOW, data: DATA, hasToken: true } as const;

test('no token → prompt to set token', () => {
  const r = recommend({ ...base, state: 'focus', hasToken: false });
  assert.equal(r.text, '🍟 设置 token');
  assert.equal(r.items[0]?.action, 'setToken');
});

test('idle/focus show points and coupon count', () => {
  assert.equal(recommend({ ...base, state: 'idle' }).text, '🍟 1200分 · 8券');
  assert.equal(recommend({ ...base, state: 'focus' }).text, '🍟 1200分 · 8券');
  const expiring = { ...DATA, account: { availablePoints: 10, expiringThisMonth: 5, expiringNextMonth: 0 } };
  const r = recommend({ ...base, state: 'idle', data: expiring });
  assert.equal(r.text, '🍟 10分 · 8券 ⚠过期');
  assert.ok(r.items.some((i) => i.description === '本月将过期 5'));
});

test('coupons in details are sorted by end date', () => {
  const items = recommend({ ...base, state: 'idle' }).items;
  assert.deepEqual(
    items.slice(-4, -1).map((i) => i.label),
    ['早到期券', '晚到期券', '无日期券'],
  );
  // 最后一项是查看全部
  assert.deepEqual(items.at(-1), {
    label: '查看全部 8 张券',
    description: '按到期日排序 · 点击券可直接下单',
    action: 'allCoupons',
  });
});

test('groupCoupons merges the same coupon and sorts by end date', () => {
  const groups = groupCoupons(
    [
      { id: 'a', code: 'a-1', title: '美式', endDate: '2026-12-31', orderTypes: [1, 2] },
      { id: 'a', code: 'a-2', title: '美式', endDate: '2026-12-31', orderTypes: [1, 2] },
      { id: 'b', title: '外送券', endDate: '2026-10-12', orderTypes: [2] },
      { id: 'c', title: '无日期', orderTypes: [] },
    ],
    NOW,
  );
  assert.deepEqual(groups, [
    { id: 'b', title: '外送券', endDate: '2026-10-12', daysLeft: 2, count: 1, pickup: false, expiring: true },
    { id: 'a', code: 'a-1', title: '美式', endDate: '2026-12-31', daysLeft: 82, count: 2, pickup: true, expiring: false },
    { id: 'c', title: '无日期', count: 1, pickup: true, expiring: false },
  ]);
});

test('pickup coupons are clickable, delivery-only coupons are display only', () => {
  const data: FuelData = {
    ...DATA,
    myCoupons: {
      total: 2,
      coupons: [
        { id: 'c1', code: 'c1-a', title: '到店券', orderTypes: [1, 2] },
        { id: 'c2', title: '外送券', orderTypes: [2] },
      ],
    },
  };
  const items = recommend({ ...base, state: 'idle', data }).items;
  assert.deepEqual(items.find((i) => i.label === '到店券')?.coupon, { id: 'c1', code: 'c1-a', title: '到店券' });
  assert.equal(items.find((i) => i.label === '到店券')?.action, 'useCoupon');
  assert.equal(items.find((i) => i.label === '外送券')?.action, undefined);
});

test('store coupons in building state carry the store code', () => {
  const item = recommend({ ...base, state: 'building' }).items.find((i) => i.label === '美式中杯');
  assert.equal(item?.action, 'useCoupon');
  assert.deepEqual(item?.coupon, { id: 's1', code: 'S1-A', title: '美式中杯', storeCode: '1000000001' });
});

test('building shows store coupons', () => {
  const r = recommend({ ...base, state: 'building' });
  assert.equal(r.text, '⏳ 构建中 · 收藏门店 2 张券可用');
  assert.ok(r.items.some((i) => i.label === '美式中杯' && i.description === '示例门店'));

  const noStore = recommend({ ...base, state: 'building', data: { ...DATA, storeCoupons: [] } });
  assert.equal(noStore.text, '⏳ 构建中 · 1200分 · 8券');
});

test('stuck in the afternoon suggests afternoon tea with nutrition info', () => {
  // NOW 是 14:00，属于下午茶
  const r = recommend({ ...base, state: 'stuck' });
  const first = r.picks[0];
  assert.ok(first);
  assert.equal(r.text, `☕ 下午茶？${first.name} ${first.kcal}kcal`);
  assert.deepEqual(r.picks.map((p) => p.name).sort(), ['冰浓浓抹茶牛奶中杯', '热美式中杯', '苹果片'].sort());
  assert.ok(r.picks.every((p) => p.kcal <= 300));
  const item = r.items.find((i) => i.label === first.name);
  assert.match(item?.description ?? '', /kcal · 蛋白质 \d+g · 钠 \d+mg/);
  assert.equal(item?.action, 'order');
});

test('late night: light food without caffeine and a note first', () => {
  const r = recommend({ ...base, state: 'stuck', lateNight: true });
  assert.ok(r.text.startsWith('🌙 歇一下？'));
  assert.deepEqual(r.picks.map((p) => p.name).sort(), ['皮蛋鸡肉粥', '纯牛奶（盒装）', '苹果片'].sort());
  assert.equal(r.items[0]?.label, '夜深了');
});

test('stuck prefers the store menu and its frequent item', () => {
  const data: FuelData = {
    ...DATA,
    menu: [
      { code: 'm1', name: '麦咖啡™热美式中杯', price: 1190 },
      { code: 'm2', name: '苹果片', price: 900, frequent: true },
    ],
  };
  const r = recommend({ ...base, state: 'stuck', data });
  // 菜单里没有抹茶，就不推荐；常点排第一
  assert.deepEqual(
    r.picks.map((p) => [p.name, p.frequent, p.parts[0]?.code]),
    [
      ['苹果片', true, 'm2'],
      ['麦咖啡™热美式中杯', false, 'm1'],
    ],
  );
  assert.equal(r.items.find((i) => i.label === '★ 苹果片')?.action, 'order');
});

test('stuck without nutrition data still renders', () => {
  const r = recommend({ ...base, state: 'stuck', data: { account: DATA.account! } });
  assert.equal(r.text, '☕ 下午茶？');
  assert.deepEqual(r.picks, []);
});

test('shipped lists upcoming campaigns, deduplicated upcoming campaigns, deduplicated', () => {
  const r = recommend({ ...base, state: 'shipped' });
  assert.equal(r.text, '🎉 发版了 · 请团队吃一顿？');
  assert.equal(r.items[0]?.action, 'teamMeal');
  const labels = r.items.map((i) => i.label);
  assert.ok(!labels.includes('已结束的活动'));
  assert.equal(labels.filter((l) => l === '以后的活动').length, 1);
  assert.equal(r.items.find((i) => i.label === '今天的活动')?.description, '进行中');
  assert.ok(labels.includes('1 张券可领'));

  // 已领取的券不算可领
  const received = recommend({
    ...base,
    state: 'shipped',
    data: { ...DATA, claimableCoupons: [{ name: '示例', status: 'HAVING_RECEIVE', label: '已领取' }] },
  });
  assert.ok(!received.items.some((i) => i.label.endsWith('张券可领')));
});

test('wrapup links to the receipt', () => {
  const r = recommend({ ...base, state: 'wrapup' });
  assert.equal(r.text, '🧾 收工了 · 今日小票');
  assert.equal(r.items[0]?.action, 'receipt');
});

test('quiet mode keeps details but shows only the summary', () => {
  const r = recommend({ ...base, state: 'shipped', quiet: true });
  assert.equal(r.text, '🍟 1200分 · 8券');
  assert.ok(r.items.some((i) => i.label === '今天的活动'));
});

test('no data at all degrades gracefully', () => {
  assert.equal(recommend({ ...base, state: 'idle', data: {} }).text, '🍟 麦麦');
});

test('daysUntil counts calendar days in local time', () => {
  assert.equal(daysUntil('2026-10-10', NOW), 0);
  assert.equal(daysUntil('2026-10-13', NOW), 3);
  assert.equal(daysUntil('2026-10-09', NOW), -1);
  assert.equal(daysUntil('not-a-date', NOW), undefined);
});

test('expiring pickup coupons are highlighted and clickable', () => {
  const data: FuelData = {
    ...DATA,
    myCoupons: {
      total: 5,
      coupons: [
        { id: 'e1', code: 'e1-a', title: '今天到期', endDate: '2026-10-10', orderTypes: [1] },
        { id: 'e1', code: 'e1-b', title: '今天到期', endDate: '2026-10-10', orderTypes: [1] },
        { id: 'e2', title: '三天后到期', endDate: '2026-10-13', orderTypes: [1, 2] },
        { id: 'e3', title: '外送券', endDate: '2026-10-11', orderTypes: [2] },
        { id: 'e4', title: '还早', endDate: '2026-10-20', orderTypes: [1] },
      ],
    },
  };
  assert.deepEqual(
    expiringCoupons(data.myCoupons!.coupons, NOW).map((c) => c.id),
    ['e1', 'e2'],
  );
  const r = recommend({ ...base, state: 'idle', data });
  assert.equal(r.text, '🍟 1200分 · 5券 · 2张临期');
  const first = r.items.find((i) => i.label === '🎟 今天到期');
  assert.equal(first?.description, '今天到期');
  assert.equal(first?.action, 'useCoupon');
  assert.deepEqual(first?.coupon, { id: 'e1', code: 'e1-a', title: '今天到期' });
  // 临期券不在普通券列表里重复出现
  assert.equal(r.items.filter((i) => i.label.endsWith('今天到期')).length, 1);
  assert.ok(r.items.some((i) => i.label === '还早'));
});
