import { DAY } from './time.js';

export type TaskCategory = 'build' | 'test' | 'other';

/**
 * 本地开发信号。只记录类型、时间和退出码，不记录 commit message、仓库路径、作者。
 */
export type Signal =
  | { kind: 'commit'; ts: number; revert: boolean }
  | { kind: 'tag'; ts: number; release: boolean }
  | { kind: 'task-start'; ts: number; id: string; category: TaskCategory }
  | { kind: 'task-end'; ts: number; id: string; category: TaskCategory; exitCode?: number };

const TEST_RE =
  /\b(test|tests|jest|vitest|mocha|ava|pytest|unittest|go test|cargo test|mvn(?:w)? test|gradle(?:w)? test|ctest)\b/i;
const BUILD_RE =
  /\b(build|compile|tsc|webpack|rollup|esbuild|vite build|mvnw?|gradlew?|make|cmake|ninja|cargo build|go build|dotnet build|msbuild)\b/i;

/** 根据任务名或命令行判断类别，test 优先于 build（`mvn test` 算 test）。 */
export function classifyTask(nameOrCommand: string): TaskCategory {
  if (TEST_RE.test(nameOrCommand)) return 'test';
  if (BUILD_RE.test(nameOrCommand)) return 'build';
  return 'other';
}

/** `git revert` 生成的 message 以 `Revert "..."` 开头。只在本地判断，结果只存布尔值。 */
export function isRevertMessage(message: string): boolean {
  return /^revert\b/i.test(message.trimStart());
}

export const DEFAULT_RELEASE_TAG_PATTERN = '^v?\\d+\\.\\d+\\.\\d+';

export function isReleaseTag(tag: string, pattern: string = DEFAULT_RELEASE_TAG_PATTERN): boolean {
  try {
    return new RegExp(pattern).test(tag);
  } catch {
    return new RegExp(DEFAULT_RELEASE_TAG_PATTERN).test(tag);
  }
}

const CATEGORIES: ReadonlySet<unknown> = new Set(['build', 'test', 'other']);

/** 校验从缓存文件里读出来的信号。 */
export function isSignal(v: unknown): v is Signal {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.ts !== 'number' || !Number.isFinite(s.ts)) return false;
  switch (s.kind) {
    case 'commit':
      return typeof s.revert === 'boolean';
    case 'tag':
      return typeof s.release === 'boolean';
    case 'task-start':
      return typeof s.id === 'string' && CATEGORIES.has(s.category);
    case 'task-end':
      return (
        typeof s.id === 'string' &&
        CATEGORIES.has(s.category) &&
        (s.exitCode === undefined || (typeof s.exitCode === 'number' && Number.isFinite(s.exitCode)))
      );
    default:
      return false;
  }
}

function signalKey(s: Signal): string {
  return `${s.kind}|${s.ts}|${'id' in s ? s.id : ''}`;
}

/** 合并新旧信号并去重（同类型、同时间、同任务 id 视为同一条），再按 pruneSignals 裁剪。 */
export function mergeSignals(existing: readonly Signal[], incoming: readonly Signal[], now: number, options?: PruneOptions): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const s of [...existing, ...incoming]) byKey.set(signalKey(s), s);
  return pruneSignals([...byKey.values()], now, options);
}

export interface PruneOptions {
  maxAgeMs?: number;
  maxCount?: number;
}

/** 按时间排序，只保留最近 24 小时、最多 500 条。 */
export function pruneSignals(signals: readonly Signal[], now: number, options: PruneOptions = {}): Signal[] {
  const { maxAgeMs = DAY, maxCount = 500 } = options;
  return signals
    .filter((s) => Number.isFinite(s.ts) && s.ts > now - maxAgeMs)
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxCount);
}
