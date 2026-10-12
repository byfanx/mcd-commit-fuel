import { DATA_KEYS, type CacheData, type CacheFile, type CachedView, type Throttle } from './cache.js';
import { recommend, type FuelData } from './recommend.js';
import { evaluate, type DevState, type StateConfig } from './state.js';
import { localDate } from './time.js';

export const DEFAULT_DAILY_NUDGE_LIMIT = 2;

/** 会改变状态栏文案的状态，计入每日提醒次数。idle/focus 只显示积分和券数，不算提醒。 */
const NUDGE_STATES: ReadonlySet<DevState> = new Set(['building', 'stuck', 'shipped', 'wrapup']);

export function toFuelData(data: CacheData): FuelData {
  const out: FuelData = {};
  for (const key of DATA_KEYS) {
    const value = data[key]?.value;
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

/** 有任何一项最近一次调用返回 AUTH 错误，就认为 token 失效。 */
export function isAuthFailed(data: CacheData): boolean {
  return DATA_KEYS.some((key) => {
    const e = data[key];
    return e?.errorKind === 'AUTH' && e.errorAt !== undefined && e.errorAt >= (e.fetchedAt ?? 0);
  });
}

export interface ViewOptions {
  hasToken: boolean;
  config?: Partial<StateConfig> | undefined;
  dailyNudgeLimit?: number | undefined;
}

/**
 * 根据缓存算出展示结果和新的限次计数。纯函数，调用方决定要不要写回缓存。
 * 进入一个提醒状态时计数加一；一直停留在同一状态不重复计数。
 */
export function computeView(
  cache: Pick<CacheFile, 'signals' | 'data' | 'view' | 'throttle'>,
  now: number,
  options: ViewOptions,
): { view: CachedView; throttle: Throttle } {
  const { state, lateNight } = evaluate(cache.signals, now, options.config);
  const today = localDate(now);
  const counts = cache.throttle.date === today ? { ...cache.throttle.counts } : {};
  const limit = options.dailyNudgeLimit ?? DEFAULT_DAILY_NUDGE_LIMIT;

  let quiet = false;
  if (NUDGE_STATES.has(state)) {
    const prev = cache.view;
    if (prev && prev.state === state && localDate(prev.computedAt) === today) {
      quiet = prev.quiet;
    } else {
      const n = (counts[state] ?? 0) + 1;
      counts[state] = n;
      quiet = n > limit;
    }
  }

  const authFailed = isAuthFailed(cache.data);
  const rec = recommend({
    state,
    lateNight,
    now,
    data: toFuelData(cache.data),
    hasToken: options.hasToken && !authFailed,
    quiet,
  });

  return {
    view: {
      state,
      lateNight,
      quiet,
      text: authFailed && options.hasToken ? '🍟 token 无效' : rec.text,
      items: rec.items,
      computedAt: now,
    },
    throttle: { date: today, counts },
  };
}
