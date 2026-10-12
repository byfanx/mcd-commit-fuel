import type { Signal } from './signals.js';
import { HOUR, MINUTE, localDate } from './time.js';

export type DevState = 'idle' | 'focus' | 'building' | 'stuck' | 'shipped' | 'wrapup';

export interface StateConfig {
  /** 构建/测试任务运行多久算"构建等待" */
  buildMinutes: number;
  /** 超过这个时长还没结束的任务视为丢失 */
  staleTaskHours: number;
  stuckWindowMinutes: number;
  stuckFailCount: number;
  revertWindowMinutes: number;
  revertCount: number;
  shippedWindowMinutes: number;
  focusWindowMinutes: number;
  focusCommitCount: number;
  wrapupIdleMinutes: number;
  lateNightEnabled: boolean;
  lateNightStartHour: number;
  lateNightEndHour: number;
}

export const DEFAULT_STATE_CONFIG: Readonly<StateConfig> = Object.freeze({
  buildMinutes: 3,
  staleTaskHours: 2,
  stuckWindowMinutes: 20,
  stuckFailCount: 3,
  revertWindowMinutes: 60,
  revertCount: 2,
  shippedWindowMinutes: 30,
  focusWindowMinutes: 30,
  focusCommitCount: 2,
  wrapupIdleMinutes: 90,
  lateNightEnabled: true,
  lateNightStartHour: 22,
  lateNightEndHour: 6,
});

export interface Evaluation {
  state: DevState;
  lateNight: boolean;
}

/**
 * 根据信号判断开发者状态。纯函数，按优先级命中第一条：
 * building > stuck > shipped > focus > wrapup > idle。
 */
export function evaluate(signals: readonly Signal[], now: number, config: Partial<StateConfig> = {}): Evaluation {
  const cfg: StateConfig = { ...DEFAULT_STATE_CONFIG, ...config };
  const past = signals.filter((s) => s.ts <= now).sort((a, b) => a.ts - b.ts);
  return { state: detectState(past, now, cfg), lateNight: isLateNight(now, cfg) };
}

function detectState(signals: Signal[], now: number, cfg: StateConfig): DevState {
  if (isBuilding(signals, now, cfg)) return 'building';
  if (isStuck(signals, now, cfg)) return 'stuck';

  const within = (minutes: number) => (s: Signal) => now - s.ts <= minutes * MINUTE;

  if (signals.some((s) => s.kind === 'tag' && s.release && within(cfg.shippedWindowMinutes)(s))) return 'shipped';

  const recentCommits = signals.filter((s) => s.kind === 'commit' && within(cfg.focusWindowMinutes)(s));
  if (recentCommits.length >= cfg.focusCommitCount) return 'focus';

  const today = localDate(now);
  const last = signals.at(-1);
  if (
    last &&
    now - last.ts >= cfg.wrapupIdleMinutes * MINUTE &&
    signals.some((s) => s.kind === 'commit' && localDate(s.ts) === today)
  ) {
    return 'wrapup';
  }
  return 'idle';
}

function isBuilding(signals: Signal[], now: number, cfg: StateConfig): boolean {
  const open = new Map<string, Signal & { kind: 'task-start' }>();
  for (const s of signals) {
    if (s.kind === 'task-start') open.set(s.id, s);
    else if (s.kind === 'task-end') open.delete(s.id);
  }
  for (const task of open.values()) {
    const age = now - task.ts;
    if (task.category !== 'other' && age >= cfg.buildMinutes * MINUTE && age < cfg.staleTaskHours * HOUR) {
      return true;
    }
  }
  return false;
}

function isStuck(signals: Signal[], now: number, cfg: StateConfig): boolean {
  // 窗口内测试连续失败（中间一次成功就清零）
  let failsInARow = 0;
  for (const s of signals) {
    if (s.kind !== 'task-end' || s.category !== 'test' || s.exitCode === undefined) continue;
    if (now - s.ts > cfg.stuckWindowMinutes * MINUTE) continue;
    failsInARow = s.exitCode === 0 ? 0 : failsInARow + 1;
  }
  if (failsInARow >= cfg.stuckFailCount) return true;

  const reverts = signals.filter(
    (s) => s.kind === 'commit' && s.revert && now - s.ts <= cfg.revertWindowMinutes * MINUTE,
  );
  return reverts.length >= cfg.revertCount;
}

export function isLateNight(now: number, cfg: Partial<StateConfig> = {}): boolean {
  const { lateNightEnabled, lateNightStartHour: start, lateNightEndHour: end } = { ...DEFAULT_STATE_CONFIG, ...cfg };
  if (!lateNightEnabled) return false;
  const hour = new Date(now).getHours();
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
