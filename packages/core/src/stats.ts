import type { Signal } from './signals.js';
import { localDate } from './time.js';

/** 当天的开发统计，只有计数和时长，给 Commit 小票用。 */
export interface DailyStats {
  /** yyyy-MM-dd */
  date: string;
  commits: number;
  reverts: number;
  releases: number;
  testsPassed: number;
  testsFailed: number;
  /** 当天结束的构建/测试任务总耗时 */
  buildMs: number;
  firstTs?: number;
  lastTs?: number;
}

/** 从信号直接算出当天统计。信号保留 24 小时，足够覆盖当天。 */
export function dailyStats(signals: readonly Signal[], now: number): DailyStats {
  const date = localDate(now);
  const stats: DailyStats = { date, commits: 0, reverts: 0, releases: 0, testsPassed: 0, testsFailed: 0, buildMs: 0 };
  const starts = new Map<string, number>();

  for (const s of [...signals].sort((a, b) => a.ts - b.ts)) {
    if (s.ts > now) continue;
    if (s.kind === 'task-start') starts.set(s.id, s.ts);
    if (localDate(s.ts) !== date) continue;

    stats.firstTs ??= s.ts;
    stats.lastTs = s.ts;
    switch (s.kind) {
      case 'commit':
        stats.commits++;
        if (s.revert) stats.reverts++;
        break;
      case 'tag':
        if (s.release) stats.releases++;
        break;
      case 'task-end': {
        if (s.category === 'other') break;
        const started = starts.get(s.id);
        if (started !== undefined) stats.buildMs += Math.max(0, s.ts - started);
        starts.delete(s.id);
        if (s.category === 'test' && s.exitCode !== undefined) {
          if (s.exitCode === 0) stats.testsPassed++;
          else stats.testsFailed++;
        }
        break;
      }
    }
  }
  return stats;
}
