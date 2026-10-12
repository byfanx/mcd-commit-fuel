import { join } from 'node:path';
import type { McdApi } from './api.js';
import { readCache, updateCache, type CacheData, type CacheFile, type DataEntry, type DataKey } from './cache.js';
import { McpError } from './errors.js';
import { tryLock } from './lock.js';
import type { FuelData } from './recommend.js';
import { renderReceipt } from './receipt.js';
import { mergeSignals, type Signal } from './signals.js';
import { currentPeriod, mealPeriod } from './mealtime.js';
import { evaluate, isLateNight, type DevState, type StateConfig } from './state.js';
import { dailyStats } from './stats.js';
import { DAY, HOUR, MINUTE } from './time.js';
import { computeView, toFuelData } from './view.js';

export type FuelApi = Pick<
  McdApi,
  | 'getAccount'
  | 'getMyCoupons'
  | 'getClaimableCoupons'
  | 'getFavoriteStores'
  | 'getStoreCoupons'
  | 'getStoreMenu'
  | 'getNutrition'
  | 'getCampaigns'
>;

export const TTL_MS: Readonly<Record<DataKey, number>> = Object.freeze({
  account: 30 * MINUTE,
  myCoupons: 30 * MINUTE,
  claimableCoupons: 2 * HOUR,
  stores: DAY,
  storeCoupons: 30 * MINUTE,
  menu: 2 * HOUR,
  nutrition: 7 * DAY,
  campaigns: 6 * HOUR,
});

/** 失败后多久内不再重试 */
export const ERROR_BACKOFF_MS = 5 * MINUTE;
/** 状态切换时，这些数据只要超过这个年龄就重新拉取 */
export const STATE_CHANGE_MIN_AGE_MS = 5 * MINUTE;
const STATE_SENSITIVE: ReadonlySet<DataKey> = new Set([
  'account',
  'myCoupons',
  'claimableCoupons',
  'storeCoupons',
  'campaigns',
]);

const REFRESH_LOCK = 'refresh.lock';
const REFRESH_LOCK_STALE_MS = 60_000;

/** 每个状态需要哪些数据。积分和我的券始终需要。 */
export function neededKeys(state: DevState): DataKey[] {
  const base: DataKey[] = ['account', 'myCoupons'];
  switch (state) {
    case 'building':
      return [...base, 'stores', 'storeCoupons'];
    case 'stuck':
      return [...base, 'stores', 'menu', 'nutrition'];
    case 'shipped':
      return [...base, 'campaigns', 'claimableCoupons'];
    case 'wrapup':
      return [...base, 'stores', 'menu', 'nutrition'];
    default:
      return base;
  }
}

export interface FetchPolicy {
  force?: boolean | undefined;
  stateChanged?: boolean | undefined;
}

/** 从 needed 里挑出需要调用 MCP 的：缺失、过期、状态切换时偏旧；最近失败过的先退避。 */
export function keysToFetch(data: CacheData, needed: readonly DataKey[], now: number, policy: FetchPolicy = {}): DataKey[] {
  return needed.filter((key) => {
    if (policy.force) return true;
    const e = data[key];
    const failing = e?.errorAt !== undefined && e.errorAt > (e.fetchedAt ?? -Infinity);
    if (failing && now - e.errorAt! < ERROR_BACKOFF_MS) return false;
    if (e?.fetchedAt === undefined) return true;
    const age = now - e.fetchedAt;
    if (age >= TTL_MS[key]) return true;
    // 门店菜单随餐段变化（早餐 / 正餐），跨餐段就重新拉
    if (key === 'menu' && mealPeriod(e.fetchedAt) !== mealPeriod(now)) return true;
    return Boolean(policy.stateChanged) && STATE_SENSITIVE.has(key) && age >= STATE_CHANGE_MIN_AGE_MS;
  });
}

/** 依赖收藏门店的数据，等门店拉到之后再拉 */
type StoreDependent = 'storeCoupons' | 'menu';

type Fetchers = { [K in Exclude<DataKey, StoreDependent>]: (api: FuelApi) => Promise<NonNullable<FuelData[K]>> };

const FETCHERS: Fetchers = {
  account: (api) => api.getAccount(),
  myCoupons: (api) => api.getMyCoupons(),
  claimableCoupons: (api) => api.getClaimableCoupons(),
  stores: (api) => api.getFavoriteStores(),
  nutrition: (api) => api.getNutrition(),
  campaigns: (api) => api.getCampaigns(),
};

/**
 * 并发拉取 keys 对应的数据，返回需要合并进缓存的条目。
 * 失败的条目保留旧值，只更新错误信息；storeCoupons 依赖收藏门店，最后单独拉。
 */
export async function fetchData(api: FuelApi, keys: readonly DataKey[], previous: CacheData, now: number): Promise<CacheData> {
  const out: CacheData = {};

  async function run<K extends DataKey>(key: K, fetch: () => Promise<NonNullable<FuelData[K]>>): Promise<void> {
    let entry: DataEntry<K>;
    try {
      entry = { fetchedAt: now, value: await fetch() };
    } catch (err) {
      const prev = previous[key] as DataEntry<K> | undefined;
      entry = {
        ...(prev?.fetchedAt !== undefined ? { fetchedAt: prev.fetchedAt } : {}),
        ...(prev?.value !== undefined ? { value: prev.value } : {}),
        errorAt: now,
        errorKind: err instanceof McpError ? err.kind : 'UNKNOWN',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    }
    Object.assign(out, { [key]: entry });
  }

  await Promise.all(
    keys
      .filter((k): k is Exclude<DataKey, StoreDependent> => k !== 'storeCoupons' && k !== 'menu')
      .map((key) => run(key, () => FETCHERS[key](api) as Promise<never>)),
  );

  const store = (out.stores?.value ?? previous.stores?.value)?.[0];
  await Promise.all([
    keys.includes('storeCoupons')
      ? run('storeCoupons', async () => (store ? api.getStoreCoupons(store.storeCode) : []))
      : undefined,
    keys.includes('menu') ? run('menu', async () => (store ? api.getStoreMenu(store.storeCode) : [])) : undefined,
  ]);
  return out;
}

export interface RefreshOptions {
  dir: string;
  /** 没有 token 时不传，只重新计算展示结果 */
  api?: FuelApi | undefined;
  force?: boolean | undefined;
  config?: Partial<StateConfig> | undefined;
  dailyNudgeLimit?: number | undefined;
  clock?: (() => number) | undefined;
}

export interface RefreshResult {
  /** 另一个进程正在刷新 */
  skipped: boolean;
  fetched: DataKey[];
  failed: DataKey[];
  cache?: CacheFile;
}

/**
 * 刷新器：判断当前状态 → 拉取需要的数据 → 重新计算展示结果 → 写回缓存。
 * 用 refresh.lock 保证同一时间只有一个刷新器在调用 MCP；网络请求在写锁之外进行。
 */
export async function runRefresh(options: RefreshOptions): Promise<RefreshResult> {
  const clock = options.clock ?? Date.now;
  const release = await tryLock(join(options.dir, REFRESH_LOCK), REFRESH_LOCK_STALE_MS, clock);
  if (!release) return { skipped: true, fetched: [], failed: [] };

  try {
    const before = await readCache(options.dir);
    const now = clock();
    const { state } = evaluate(before.signals, now, options.config);
    const keys = options.api
      ? keysToFetch(before.data, neededKeys(state), now, {
          force: options.force,
          stateChanged: before.view?.state !== state,
        })
      : [];
    const updates = options.api && keys.length ? await fetchData(options.api, keys, before.data, now) : {};
    const failed = keys.filter((k) => updates[k]?.errorAt === now);

    const cache = await updateCache(options.dir, (latest) => {
      Object.assign(latest.data, updates);
      const { view, throttle } = computeView(latest, clock(), {
        hasToken: options.api !== undefined,
        config: options.config,
        dailyNudgeLimit: options.dailyNudgeLimit,
      });
      latest.view = view;
      latest.throttle = throttle;
      latest.lastRefreshAt = now;
    });
    return { skipped: false, fetched: keys.filter((k) => !failed.includes(k)), failed, cache };
  } finally {
    await release();
  }
}

export interface ReceiptOptions {
  dir: string;
  api?: FuelApi | undefined;
  now?: number | undefined;
  config?: Partial<StateConfig> | undefined;
}

/** 生成今日小票。缺营养数据且有 token 时先补拉一次（只读接口）。 */
export async function prepareReceipt(options: ReceiptOptions): Promise<string> {
  const now = options.now ?? Date.now();
  let cache = await readCache(options.dir);
  if (!cache.data.nutrition?.value && options.api) {
    const updates = await fetchData(options.api, ['nutrition'], cache.data, now);
    cache = await updateCache(options.dir, (c) => {
      Object.assign(c.data, updates);
    });
  }
  const lateNight = isLateNight(now, options.config);
  return renderReceipt({
    stats: dailyStats(cache.signals, now),
    data: toFuelData(cache.data),
    lateNight,
    period: currentPeriod(now, lateNight),
  });
}

/** 把新信号合并进缓存（去重、只保留 24 小时）。 */
export async function recordSignals(dir: string, signals: readonly Signal[], now: number = Date.now()): Promise<CacheFile> {
  return updateCache(dir, (cache) => {
    cache.signals = mergeSignals(cache.signals, signals, now);
  });
}
