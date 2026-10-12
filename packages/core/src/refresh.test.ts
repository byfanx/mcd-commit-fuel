import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CacheData, DataKey } from './cache.js';
import { readCache } from './cache.js';
import { McpError } from './errors.js';
import { tryLock } from './lock.js';
import {
  ERROR_BACKOFF_MS,
  TTL_MS,
  fetchData,
  keysToFetch,
  neededKeys,
  recordSignals,
  runRefresh,
  type FuelApi,
} from './refresh.js';
import { MINUTE } from './time.js';

const NOW = new Date(2026, 9, 10, 14, 0).getTime();

class StubApi implements FuelApi {
  calls: string[] = [];
  fail = new Map<string, Error>();
  storeCodes: string[] = [];

  async #call<T>(name: string, value: T): Promise<T> {
    this.calls.push(name);
    const err = this.fail.get(name);
    if (err) throw err;
    return value;
  }
  getAccount = () => this.#call('getAccount', { availablePoints: 100, expiringThisMonth: 0, expiringNextMonth: 0 });
  getMyCoupons = () => this.#call('getMyCoupons', { total: 2, coupons: [] });
  getClaimableCoupons = () => this.#call('getClaimableCoupons', [{ name: '示例', status: 'CAN_GET', label: '可领取' }]);
  getFavoriteStores = () => this.#call('getFavoriteStores', [{ storeCode: '1000000001', storeName: '示例门店' }]);
  getStoreCoupons = (code: string) => {
    this.storeCodes.push(code);
    return this.#call('getStoreCoupons', [{ id: 's1', title: '美式中杯', products: [] }]);
  };
  getStoreMenu = () => this.#call('getStoreMenu', [{ code: 'm1', name: '苹果片', price: 900 }]);
  getNutrition = () => this.#call('getNutrition', []);
  getCampaigns = () => this.#call('getCampaigns', []);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcd-fuel-refresh-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('neededKeys per state always include account and coupons', () => {
  assert.deepEqual(neededKeys('idle'), ['account', 'myCoupons']);
  assert.deepEqual(neededKeys('building'), ['account', 'myCoupons', 'stores', 'storeCoupons']);
  assert.deepEqual(neededKeys('stuck'), ['account', 'myCoupons', 'stores', 'menu', 'nutrition']);
  assert.deepEqual(neededKeys('shipped'), ['account', 'myCoupons', 'campaigns', 'claimableCoupons']);
});

test('keysToFetch: missing, expired, fresh, backoff, state change, force', () => {
  const keys: DataKey[] = ['account', 'nutrition'];
  assert.deepEqual(keysToFetch({}, keys, NOW), keys);

  const fresh: CacheData = { account: { fetchedAt: NOW - 10 * MINUTE }, nutrition: { fetchedAt: NOW - 10 * MINUTE } };
  assert.deepEqual(keysToFetch(fresh, keys, NOW), []);
  // 状态切换时偏旧的账户数据重拉，营养数据不受影响
  assert.deepEqual(keysToFetch(fresh, keys, NOW, { stateChanged: true }), ['account']);
  assert.deepEqual(keysToFetch(fresh, keys, NOW, { force: true }), keys);

  const expired: CacheData = { account: { fetchedAt: NOW - TTL_MS.account } };
  assert.deepEqual(keysToFetch(expired, ['account'], NOW), ['account']);

  const failing: CacheData = { account: { fetchedAt: NOW - TTL_MS.account, errorAt: NOW - 1 * MINUTE } };
  assert.deepEqual(keysToFetch(failing, ['account'], NOW), []);
  assert.deepEqual(keysToFetch(failing, ['account'], NOW + ERROR_BACKOFF_MS), ['account']);
});

test('fetchData keeps the old value on failure and records the error kind', async () => {
  const api = new StubApi();
  api.fail.set('getAccount', new McpError('NETWORK', 'timeout'));
  const previous: CacheData = {
    account: { fetchedAt: NOW - 60 * MINUTE, value: { availablePoints: 1, expiringThisMonth: 0, expiringNextMonth: 0 } },
  };
  const out = await fetchData(api, ['account', 'myCoupons'], previous, NOW);
  assert.deepEqual(out.account, {
    fetchedAt: NOW - 60 * MINUTE,
    value: previous.account!.value,
    errorAt: NOW,
    errorKind: 'NETWORK',
    error: 'timeout',
  });
  assert.deepEqual(out.myCoupons, { fetchedAt: NOW, value: { total: 2, coupons: [] } });
});

test('fetchData: store coupons use the store fetched in the same run, or [] without a store', async () => {
  const api = new StubApi();
  const out = await fetchData(api, ['stores', 'storeCoupons'], {}, NOW);
  assert.deepEqual(api.storeCodes, ['1000000001']);
  assert.equal(out.storeCoupons?.value?.length, 1);

  const none = new StubApi();
  none.getFavoriteStores = async () => [];
  const empty = await fetchData(none, ['stores', 'storeCoupons'], {}, NOW);
  assert.deepEqual(empty.storeCoupons?.value, []);
  assert.deepEqual(none.storeCodes, []);
});

test('runRefresh fetches what the state needs, then nothing while fresh', async () => {
  const api = new StubApi();
  let now = NOW;
  const clock = () => now;

  const first = await runRefresh({ dir, api, clock });
  assert.equal(first.skipped, false);
  assert.deepEqual(first.fetched.sort(), ['account', 'myCoupons']);
  assert.equal(first.cache?.view?.state, 'idle');
  assert.equal(first.cache?.view?.text, '🍟 100分 · 2券');

  now += 5 * MINUTE;
  const second = await runRefresh({ dir, api, clock });
  assert.deepEqual(second.fetched, []);
  assert.equal(api.calls.length, 2);
});

test('runRefresh: entering building fetches stores and store coupons', async () => {
  const api = new StubApi();
  await runRefresh({ dir, api, clock: () => NOW });
  await recordSignals(dir, [{ kind: 'task-start', ts: NOW - 4 * MINUTE + MINUTE, id: 'b', category: 'build' }], NOW);

  const result = await runRefresh({ dir, api, clock: () => NOW + MINUTE });
  assert.equal(result.cache?.view?.state, 'building');
  assert.deepEqual(result.fetched.sort(), ['storeCoupons', 'stores']);
  assert.equal(result.cache?.view?.text, '⏳ 构建中 · 收藏门店 1 张券可用');
});

test('runRefresh is skipped while another refresher holds the lock', async () => {
  const release = await tryLock(join(dir, 'refresh.lock'), 60_000);
  assert.ok(release);
  const result = await runRefresh({ dir, api: new StubApi(), clock: () => Date.now() });
  assert.equal(result.skipped, true);
  await release();
});

test('runRefresh without a token only recomputes the view', async () => {
  const result = await runRefresh({ dir, clock: () => NOW });
  assert.deepEqual(result.fetched, []);
  assert.equal(result.cache?.view?.text, '🍟 设置 token');
});

test('runRefresh reports token problems', async () => {
  const api = new StubApi();
  api.fail.set('getAccount', new McpError('AUTH', 'token 无效'));
  const result = await runRefresh({ dir, api, clock: () => NOW });
  assert.deepEqual(result.failed, ['account']);
  assert.equal(result.cache?.view?.text, '🍟 token 无效');
  assert.equal((await readCache(dir)).data.account?.errorKind, 'AUTH');
});

test('keysToFetch refetches the store menu when the meal period changes', () => {
  const breakfast = new Date(2026, 9, 10, 9, 0).getTime();
  const lunch = new Date(2026, 9, 10, 11, 5).getTime();
  const data: CacheData = { menu: { fetchedAt: breakfast } };
  assert.deepEqual(keysToFetch(data, ['menu'], breakfast + 10 * MINUTE), []);
  assert.deepEqual(keysToFetch(data, ['menu'], lunch), ['menu']);
});
