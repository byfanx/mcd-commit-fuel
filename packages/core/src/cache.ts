import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpErrorKind } from './errors.js';
import { isObject, parseJson } from './json.js';
import { acquireLock } from './lock.js';
import type { DetailItem, FuelData } from './recommend.js';
import { isSignal, type Signal } from './signals.js';
import type { DevState } from './state.js';

export const CACHE_VERSION = 1;
export const CACHE_FILE = 'state.json';
const WRITE_LOCK = 'write.lock';

export type DataKey = keyof FuelData;

export const DATA_KEYS = [
  'account',
  'myCoupons',
  'claimableCoupons',
  'stores',
  'storeCoupons',
  'menu',
  'nutrition',
  'campaigns',
] as const satisfies readonly DataKey[];

export interface DataEntry<K extends DataKey = DataKey> {
  /** 最近一次成功的时间 */
  fetchedAt?: number;
  /** 最近一次成功拿到的值；之后失败也保留，用于降级展示 */
  value?: NonNullable<FuelData[K]>;
  /** 最近一次失败的时间，晚于 fetchedAt 才表示当前处于失败状态 */
  errorAt?: number;
  errorKind?: McpErrorKind | 'UNKNOWN';
  error?: string;
}

export type CacheData = { [K in DataKey]?: DataEntry<K> };

/** 计算好的展示结果，出口层可以直接用。 */
export interface CachedView {
  state: DevState;
  lateNight: boolean;
  /** 当天提醒次数已用完 */
  quiet: boolean;
  text: string;
  items: DetailItem[];
  computedAt: number;
}

export interface Throttle {
  /** yyyy-MM-dd，跨天后计数清零 */
  date: string;
  counts: Partial<Record<DevState, number>>;
}

export interface CacheFile {
  version: typeof CACHE_VERSION;
  signals: Signal[];
  data: CacheData;
  view?: CachedView;
  throttle: Throttle;
  lastRefreshAt?: number;
}

export function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, signals: [], data: {}, throttle: { date: '', counts: {} } };
}

/** `$MCD_FUEL_CACHE_DIR` > `$XDG_CACHE_HOME` > Windows `%LOCALAPPDATA%` > `~/.cache`。 */
export function resolveCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.MCD_FUEL_CACHE_DIR) return env.MCD_FUEL_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'mcd-commit-fuel');
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'mcd-commit-fuel');
  return join(home, '.cache', 'mcd-commit-fuel');
}

/** 读缓存。文件不存在、损坏或版本不符时返回空缓存，从不抛错。 */
export async function readCache(dir: string): Promise<CacheFile> {
  let text: string;
  try {
    text = await readFile(join(dir, CACHE_FILE), 'utf8');
  } catch {
    return emptyCache();
  }
  return sanitizeCache(parseJson(text));
}

export function sanitizeCache(v: unknown): CacheFile {
  const cache = emptyCache();
  if (!isObject(v) || v.version !== CACHE_VERSION) return cache;

  if (Array.isArray(v.signals)) cache.signals = v.signals.filter(isSignal);
  if (isObject(v.data)) {
    for (const key of DATA_KEYS) {
      const entry = v.data[key];
      if (isObject(entry)) Object.assign(cache.data, { [key]: entry });
    }
  }
  const t = v.throttle;
  if (isObject(t) && typeof t.date === 'string' && isObject(t.counts)) {
    cache.throttle = { date: t.date, counts: t.counts as Throttle['counts'] };
  }
  const view = v.view;
  if (
    isObject(view) &&
    typeof view.state === 'string' &&
    typeof view.text === 'string' &&
    Array.isArray(view.items) &&
    typeof view.computedAt === 'number'
  ) {
    cache.view = view as unknown as CachedView;
  }
  if (typeof v.lastRefreshAt === 'number') cache.lastRefreshAt = v.lastRefreshAt;
  return cache;
}

/** 先写临时文件再 rename，读的一方不会看到写了一半的文件。文件权限 0600。 */
export async function writeCache(dir: string, cache: CacheFile): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, CACHE_FILE);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * 加写锁后"读 → 修改 → 写"，VS Code 插件和 CLI 同时写信号时不会互相覆盖。
 * mutate 可以直接改传入的对象，也可以返回一个新对象。
 */
export async function updateCache(
  dir: string,
  mutate: (cache: CacheFile) => CacheFile | void,
  options: { timeoutMs?: number } = {},
): Promise<CacheFile> {
  const release = await acquireLock(join(dir, WRITE_LOCK), { staleMs: 10_000, timeoutMs: options.timeoutMs ?? 2_000 });
  if (!release) throw new Error('缓存文件正被其他进程占用');
  try {
    const current = await readCache(dir);
    const next = mutate(current) ?? current;
    await writeCache(dir, next);
    return next;
  } finally {
    await release();
  }
}
