import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoreCoupon } from './api.js';
import {
  McdActions,
  couponOrderItem,
  defaultAssistance,
  diffClaimed,
  findStoreCoupon,
  formatYuan,
  maskAddress,
  parseAddresses,
  parseGroupStores,
  parseMealAssistance,
  parseMenu,
  planTeamMeal,
  parseOrder,
  parseQuote,
  summarizeClaim,
} from './actions.js';
import { McpError } from './errors.js';
import { menuCandidates, pickMeals } from './mealtime.js';
import type { ToolCaller } from './mcp-client.js';
import { matchNutrition, normalizeFoodName, type NutritionFood } from './nutrition.js';

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

const FOODS = [
  food('热美式中杯', 13),
  food('纯牛奶（盒装）', 129),
  food('优品豆浆小杯', 151),
  food('优品豆浆大杯', 202),
  food('100%苹果汁', 88),
  food('中薯条', 289),
  food('圆筒冰淇淋', 93),
];

// 字段结构来自 2026-10-12 实测，取值均为虚构
const MENU_DATA = {
  categories: [],
  meals: {
    '1001': { name: '麦咖啡™热美式中杯', currentPrice: '11.9' },
    '1002': { name: '纯牛奶(盒装)', currentPrice: '10.5' },
    '1003': { name: '优品豆浆', currentPrice: '10' },
    '1004': { name: '100% 苹果汁(盒装)', currentPrice: '11.5' },
    '1005': { name: '中薯条', currentPrice: '12' },
    '1006': { name: '圆筒冰淇淋', currentPrice: '6' },
    '1007': { name: '脆香油条豆浆组合', currentPrice: '18' },
    '1008': { name: '没有营养数据的饮品', currentPrice: '9' },
    '1009': { name: '' },
  },
};

const QUOTE_DATA = {
  productOriginalPrice: '1900',
  productPrice: '1190',
  originalPrice: '1900',
  discount: '710',
  price: '1190',
  productList: [{ productCode: '1001', productName: '麦咖啡™热美式中杯', quantity: 1, originalSubtotal: 1900, subtotal: 1190 }],
  takeWayList: [
    { code: 'eat-in', title: '堂食', subtitle: '店内用餐' },
    { code: 'take-out', title: '外带' },
    { title: '缺 code 被跳过' },
  ],
};

class StubCaller implements ToolCaller {
  calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  constructor(private readonly results: Record<string, unknown>) {}
  async callTool(name: string, args?: Record<string, unknown>) {
    this.calls.push({ name, args });
    return this.results[name];
  }
}

test('parseMenu converts yuan to fen and skips nameless items', () => {
  const menu = parseMenu(MENU_DATA);
  assert.equal(menu.length, 8);
  assert.deepEqual(menu[0], { code: '1001', name: '麦咖啡™热美式中杯', price: 1190 });
  assert.deepEqual(parseMenu({ meals: null }), []);
  assert.throws(() => parseMenu('x'), (e: unknown) => e instanceof McpError && e.kind === 'PROTOCOL');
});

test('parseQuote reads fen amounts and take-away options', () => {
  assert.deepEqual(parseQuote(QUOTE_DATA), {
    price: 1190,
    originalPrice: 1900,
    discount: 710,
    products: [{ code: '1001', name: '麦咖啡™热美式中杯', quantity: 1, subtotal: 1190 }],
    takeWays: [
      { code: 'eat-in', title: '堂食' },
      { code: 'take-out', title: '外带' },
    ],
  });
  assert.equal(parseQuote({ price: '500' }).discount, 0);
  assert.throws(() => parseQuote({ price: 'n/a' }), (e: unknown) => e instanceof McpError && e.kind === 'PROTOCOL');
});

test('parseOrder finds the order id in common places', () => {
  assert.deepEqual(parseOrder({ orderId: 'A1' }), { orderId: 'A1', summary: '订单号 A1' });
  assert.deepEqual(parseOrder({ order: { orderNo: 'B2' } }), { orderId: 'B2', summary: '订单号 B2' });
  assert.deepEqual(parseOrder({ other: 1 }), { summary: '订单已提交' });
  assert.deepEqual(parseOrder('下单成功'), { summary: '下单成功' });
  assert.throws(() => parseOrder(42), (e: unknown) => e instanceof McpError);
});

test('summarizeClaim', () => {
  assert.equal(summarizeClaim('领取成功 3 张'), '领取成功 3 张');
  assert.equal(summarizeClaim([1, 2]), '领取 2 张');
  assert.equal(summarizeClaim({ successCount: '4' }), '领取 4 张');
  assert.equal(summarizeClaim({ coupons: [1] }), '领取 1 张');
  assert.equal(summarizeClaim(null), '已提交');
});

test('findStoreCoupon prefers the exact coupon code, then the coupon id', () => {
  const store: StoreCoupon[] = [
    { id: 'A', code: 'A-1', title: '美式', products: [{ code: 'p1', name: '美式' }] },
    { id: 'A', code: 'A-2', title: '美式', products: [{ code: 'p1', name: '美式' }] },
    { id: 'B', title: '奶铁', products: [] },
  ];
  assert.equal(findStoreCoupon(store, { id: 'A', code: 'A-2' })?.code, 'A-2');
  // 卡包里的券码在门店里查不到时，退回到同一种券
  assert.equal(findStoreCoupon(store, { id: 'A', code: 'A-9' })?.code, 'A-1');
  assert.equal(findStoreCoupon(store, { id: 'B' })?.title, '奶铁');
  assert.equal(findStoreCoupon(store, { id: 'C', code: 'C-1' }), undefined);
});

test('couponOrderItem passes coupon id and code with the product', () => {
  assert.deepEqual(couponOrderItem({ id: 'A', code: 'A-1', title: '美式', products: [] }, 'p1'), {
    productCode: 'p1',
    quantity: 1,
    couponId: 'A',
    couponCode: 'A-1',
  });
  assert.deepEqual(couponOrderItem({ id: 'B', title: '奶铁', products: [] }, 'p2'), {
    productCode: 'p2',
    quantity: 1,
    couponId: 'B',
  });
});

test('formatYuan', () => {
  assert.equal(formatYuan(1190), '¥11.9');
  assert.equal(formatYuan(1000), '¥10');
  assert.equal(formatYuan(10000), '¥100');
  assert.equal(formatYuan(1005), '¥10.05');
  assert.equal(formatYuan(0), '¥0');
});

test('normalizeFoodName and matchNutrition', () => {
  assert.equal(normalizeFoodName('麦咖啡™热美式中杯'), '热美式中杯');
  assert.equal(normalizeFoodName('纯牛奶(盒装)'), '纯牛奶');
  assert.equal(normalizeFoodName('纯牛奶（盒装）'), '纯牛奶');
  assert.equal(normalizeFoodName('100% 苹果汁(盒装)'), '苹果汁');
  assert.equal(matchNutrition({ name: '麦咖啡™热美式中杯' }, FOODS)?.name, '热美式中杯');
  // 多个规格取热量最高的
  assert.equal(matchNutrition({ name: '优品豆浆' }, FOODS)?.energyKcal, 202);
  assert.equal(matchNutrition({ name: '查无此物' }, FOODS), undefined);
});

test('parseMenu marks frequent items (object or array form)', () => {
  const one = parseMenu({ ...MENU_DATA, frequent: { code: '1002', tags: ['我的常点'] } });
  assert.deepEqual(
    one.filter((m) => m.frequent).map((m) => m.code),
    ['1002'],
  );
  const many = parseMenu({ ...MENU_DATA, frequent: [{ code: '1001' }, { code: '1003' }] });
  assert.deepEqual(
    many.filter((m) => m.frequent).map((m) => m.code),
    ['1001', '1003'],
  );
});

test('menuCandidates keeps menu items with nutrition and their codes', () => {
  const candidates = menuCandidates(parseMenu(MENU_DATA), FOODS);
  assert.deepEqual(
    candidates.map((c) => [c.code, c.name, c.nutrition.energyKcal]),
    [
      ['1001', '麦咖啡™热美式中杯', 13],
      ['1002', '纯牛奶(盒装)', 129],
      ['1003', '优品豆浆', 202],
      ['1004', '100% 苹果汁(盒装)', 88],
      ['1005', '中薯条', 289],
      ['1006', '圆筒冰淇淋', 93],
    ],
  );
  // 推荐时薯条、冰淇淋、组合套餐被排除；深夜不含咖啡因
  const night = pickMeals(candidates, { period: 'lateNight', seed: 'x', count: 10 });
  assert.deepEqual(night.map((p) => p.name).sort(), ['100% 苹果汁(盒装)', '优品豆浆', '纯牛奶(盒装)'].sort());
  assert.ok(night.every((p) => p.parts[0]?.code));
});

test('McdActions calls the expected tools with pickup parameters', async () => {
  const caller = new StubCaller({
    'query-meals': MENU_DATA,
    'calculate-price': QUOTE_DATA,
    'auto-bind-coupons': [1, 2, 3],
    'create-order': { orderId: 'X9' },
  });
  const actions = new McdActions(caller);
  const items = [{ productCode: '1001', quantity: 1 }];

  assert.equal((await actions.getMenu('1000000001')).length, 8);
  assert.equal((await actions.quote('1000000001', items)).price, 1190);
  assert.equal(await actions.claimAllCoupons(), '领取 3 张');
  assert.deepEqual(await actions.createPickupOrder('1000000001', items, 'take-out'), { orderId: 'X9', summary: '订单号 X9' });

  assert.deepEqual(caller.calls, [
    { name: 'query-meals', args: { storeCode: '1000000001', orderType: 1, beType: 1 } },
    { name: 'calculate-price', args: { storeCode: '1000000001', orderType: 1, beType: 1, items } },
    { name: 'auto-bind-coupons', args: undefined },
    {
      name: 'create-order',
      args: { storeCode: '1000000001', orderType: 1, beType: 1, items, takeWayCode: 'take-out' },
    },
  ]);
});

test('maskAddress and parseAddresses never expose name or phone', () => {
  assert.equal(maskAddress('上海市示例区示例路100号示例大厦8楼'), '上海市示例区…大厦8楼');
  assert.equal(maskAddress('示例路1号'), '示例路1号');
  const list = parseAddresses({
    addresses: [
      { addressId: 'A1', contactName: '张三', phone: '13800000000', fullAddress: '上海市示例区示例路100号示例大厦8楼' },
      { contactName: '缺 id 被跳过' },
    ],
  });
  assert.deepEqual(list, [{ addressId: 'A1', label: '上海市示例区…大厦8楼' }]);
  assert.doesNotMatch(JSON.stringify(list), /张三|13800000000/);
});

test('parseGroupStores and default meal assistance', () => {
  assert.deepEqual(
    parseGroupStores([
      { storeCode: '1', storeName: '示例团餐店', beCode: 'BE1', businessStatus: true, businessStartTime: '07:00', businessEndTime: '23:00' },
      { storeCode: '2', storeName: '缺 beCode' },
    ]),
    [{ storeCode: '1', storeName: '示例团餐店', beCode: 'BE1', open: true, hours: '07:00-23:00' }],
  );
  const items = parseMealAssistance({
    mealAssistanceItems: [
      { gmServiceCode: 'GMS001', gmServiceName: '保鲜速达', selected: 'true', enable: 'true' },
      { gmServiceCode: 'GMS002', gmServiceName: '专人分餐', enable: 'false', unusableReason: '需提前预约' },
    ],
  });
  assert.equal(defaultAssistance(items)?.code, 'GMS001');
  assert.equal(items[1]?.reason, '需提前预约');
  assert.equal(defaultAssistance([{ ...items[1]! }]), undefined);
});

test('planTeamMeal: one burger and one drink per person, shared snacks, no fries or desserts', () => {
  const candidates = [
    { code: 'm1', name: '麦辣鸡腿汉堡', price: 2550, kcal: 540 },
    { code: 'm2', name: '麦香鱼', price: 2400, kcal: 350 },
    { code: 'm3', name: '双层安格斯厚牛堡', kcal: 1003 },
    { code: 'd1', name: '无糖可口可乐', price: 1100, kcal: 0 },
    { code: 's1', name: '麦乐鸡5块', price: 1550, kcal: 213 },
    { code: 'x1', name: '中薯条', kcal: 289 },
    { code: 'x2', name: '麦旋风', kcal: 300 },
  ];
  const plan = planTeamMeal(candidates, 3);
  assert.deepEqual(plan, {
    people: 3,
    lines: [
      { code: 'm2', name: '麦香鱼', quantity: 2, kcal: 350, role: 'main' },
      { code: 'm1', name: '麦辣鸡腿汉堡', quantity: 1, kcal: 540, role: 'main' },
      { code: 'd1', name: '无糖可口可乐', quantity: 3, kcal: 0, role: 'drink' },
      { code: 's1', name: '麦乐鸡5块', quantity: 2, kcal: 213, role: 'snack' },
    ],
    kcalPerPerson: 555,
  });
  assert.equal(planTeamMeal(candidates, 1)?.people, 2, 'clamped to at least 2');
  assert.equal(planTeamMeal(candidates.filter((c) => !c.code.startsWith('d')), 3), undefined, 'needs a drink');
});

test('diffClaimed counts claimed coupons by name, including duplicates and removed entries', () => {
  const can = (name: string) => ({ name, status: 'CAN_GET', label: '可领取' });
  const got = (name: string) => ({ name, status: 'HAVING_RECEIVE', label: '已领取' });
  const before = [can('厚松饼套餐'), can('厚松饼套餐'), can('厚松饼套餐'), can('中薯条买一送一'), can('限量券'), got('早就领过')];
  // 厚松饼领到 2 张、还剩 1 张；薯条券从列表里消失也算领到；限量券没领到
  const after = [got('厚松饼套餐'), got('厚松饼套餐'), can('厚松饼套餐'), can('限量券'), got('早就领过')];
  assert.deepEqual(diffClaimed(before, after), {
    claimed: [
      { name: '厚松饼套餐', count: 2 },
      { name: '中薯条买一送一', count: 1 },
    ],
    remaining: [
      { name: '厚松饼套餐', count: 1 },
      { name: '限量券', count: 1 },
    ],
  });
  assert.deepEqual(diffClaimed([got('a')], [got('a')]), { claimed: [], remaining: [] });
});
