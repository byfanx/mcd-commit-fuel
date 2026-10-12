import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McdApi, isClaimable } from './api.js';
import { McpError } from './errors.js';
import type { ToolCaller } from './mcp-client.js';

// 字段结构来自 2026-10-10 实测，取值均为虚构
const FIXTURES: Record<string, unknown> = {
  'query-my-account': {
    accountId: '00000000000000000000',
    availablePoint: '1200.5',
    currentMouthExpirePoint: '20',
    nextMouthExpirePoint: '0',
  },
  'query-my-coupons': {
    totalCount: 3,
    currentPage: 1,
    coupons: [
      { id: 'C1', code: 'MCD-FAKE-1', title: '示例汉堡券', tradeEndDate: '2026-12-31', orderTypes: [1, 2] },
      { id: 'C2', title: '示例咖啡券', tradeEndDate: '', orderTypes: [] },
      { id: '', title: '缺 id 被跳过' },
    ],
  },
  'available-coupons': [
    { couponName: '示例套餐', couponImage: 'https://example.invalid/a.png', couponStatus: 'CAN_GET', label: '可领取' },
    { couponName: '' },
  ],
  'query-nearby-stores': [
    { storeCode: '1000000001', storeName: '示例门店', beCode: null, distance: 0 },
    { storeCode: '1000000002', storeName: '示例得来速', beCode: 'BE01' },
  ],
  'query-store-coupons': [
    {
      couponId: 'S1',
      couponCode: 'MCD-FAKE-2',
      title: '示例美式中杯',
      tradeDateTime: '2026-09-24 00:00:00-2026-12-31 23:59:59',
      products: [{ productCode: '9900000001', productName: '示例美式' }, { productName: '缺编码被跳过' }],
    },
    { couponId: 'S2', title: '无日期' },
  ],
  'list-nutrition-foods':
    '[1]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  苹果片,null,133,32,0,0,7,0,18',
  'campaign-calendar': {
    currentTime: '2026-10-10 11:40:07',
    dailyList: [
      {
        date: '2026-10-10',
        events: [
          { activityTitle: '', activityStage: 3, articleDto: { title: '示例新品上市' } },
          { activityTitle: '示例派对', activityStage: 2, articleDto: { title: '被 activityTitle 覆盖' } },
          { activityTitle: '', articleDto: null },
        ],
      },
      { date: '2026-10-11', events: [] },
    ],
  },
};

class StubCaller implements ToolCaller {
  calls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  constructor(private readonly fixtures: Record<string, unknown>) {}
  async callTool(name: string, args?: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (!(name in this.fixtures)) throw new Error(`no fixture for ${name}`);
    return this.fixtures[name];
  }
}

const stub = () => new StubCaller(FIXTURES);

test('getAccount converts string points to numbers', async () => {
  assert.deepEqual(await new McdApi(stub()).getAccount(), {
    availablePoints: 1200.5,
    expiringThisMonth: 20,
    expiringNextMonth: 0,
  });
});

test('getMyCoupons keeps total and skips invalid entries', async () => {
  const caller = stub();
  const result = await new McdApi(caller).getMyCoupons();
  assert.equal(result.total, 3);
  assert.deepEqual(result.coupons, [
    { id: 'C1', code: 'MCD-FAKE-1', title: '示例汉堡券', endDate: '2026-12-31', orderTypes: [1, 2] },
    { id: 'C2', title: '示例咖啡券', orderTypes: [] },
  ]);
  assert.deepEqual(caller.calls[0]?.args, { page: '1', pageSize: '200' });
});

test('isClaimable only counts CAN_GET', () => {
  assert.equal(isClaimable({ name: 'a', status: 'CAN_GET', label: '可领取' }), true);
  assert.equal(isClaimable({ name: 'b', status: 'HAVING_RECEIVE', label: '已领取' }), false);
});

test('getClaimableCoupons', async () => {
  assert.deepEqual(await new McdApi(stub()).getClaimableCoupons(), [
    { name: '示例套餐', status: 'CAN_GET', label: '可领取' },
  ]);
});

test('getFavoriteStores queries favorites for pickup and keeps beCode when present', async () => {
  const caller = stub();
  assert.deepEqual(await new McdApi(caller).getFavoriteStores(), [
    { storeCode: '1000000001', storeName: '示例门店' },
    { storeCode: '1000000002', storeName: '示例得来速', beCode: 'BE01' },
  ]);
  assert.deepEqual(caller.calls[0]?.args, { beType: 1, searchType: 1 });
});

test('getStoreCoupons extracts end date from tradeDateTime', async () => {
  const caller = stub();
  assert.deepEqual(await new McdApi(caller).getStoreCoupons('1000000001'), [
    {
      id: 'S1',
      code: 'MCD-FAKE-2',
      title: '示例美式中杯',
      endDate: '2026-12-31',
      products: [{ code: '9900000001', name: '示例美式' }],
    },
    { id: 'S2', title: '无日期', products: [] },
  ]);
  assert.deepEqual(caller.calls[0]?.args, { storeCode: '1000000001', orderType: 1, beType: 1 });
});

test('searchStores searches by city and keyword, keeps address and distance', async () => {
  const caller = new StubCaller({
    'query-nearby-stores': [
      { storeCode: '1000000003', storeName: '示例搜索门店', address: '示例路 1 号', distance: 500, beCode: null },
      { storeCode: '1000000004', storeName: '无距离门店', distance: 0 },
    ],
  });
  const api = new McdApi(caller);
  assert.deepEqual(await api.searchStores('上海', ' 示例路 '), [
    { storeCode: '1000000003', storeName: '示例搜索门店', address: '示例路 1 号', distance: 500 },
    { storeCode: '1000000004', storeName: '无距离门店' },
  ]);
  await api.searchStores('上海', '  ');
  assert.deepEqual(
    caller.calls.map((c) => c.args),
    [
      { beType: 1, searchType: 2, city: '上海', keyword: '示例路' },
      { beType: 1, searchType: 2, city: '上海' },
    ],
  );
});

test('getNutrition parses the table', async () => {
  const foods = await new McdApi(stub()).getNutrition();
  assert.equal(foods.length, 1);
  assert.equal(foods[0]?.name, '苹果片');
});

test('getCampaigns reads articleDto.title when activityTitle is empty', async () => {
  assert.deepEqual(await new McdApi(stub()).getCampaigns(), [
    { date: '2026-10-10', title: '示例新品上市', stage: 3 },
    { date: '2026-10-10', title: '示例派对', stage: 2 },
  ]);
});

test('unexpected shapes throw PROTOCOL', async () => {
  const api = new McdApi(
    new StubCaller({
      'query-my-account': { availablePoint: 'n/a' },
      'available-coupons': { not: 'an array' },
      'list-nutrition-foods': 42,
      'campaign-calendar': null,
    }),
  );
  const isProtocol = (err: unknown) => err instanceof McpError && err.kind === 'PROTOCOL';
  await assert.rejects(api.getAccount(), isProtocol);
  await assert.rejects(api.getClaimableCoupons(), isProtocol);
  await assert.rejects(api.getNutrition(), isProtocol);
  await assert.rejects(api.getCampaigns(), isProtocol);
});
