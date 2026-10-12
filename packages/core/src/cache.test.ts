import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_FILE, emptyCache, readCache, resolveCacheDir, updateCache, writeCache } from './cache.js';
import { tryLock } from './lock.js';
import { recordSignals } from './refresh.js';
import { mergeSignals, type Signal } from './signals.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcd-fuel-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('resolveCacheDir priority', () => {
  assert.equal(resolveCacheDir({ MCD_FUEL_CACHE_DIR: '/x', XDG_CACHE_HOME: '/y' }, 'linux', '/h'), '/x');
  assert.equal(resolveCacheDir({ XDG_CACHE_HOME: '/y' }, 'linux', '/h'), join('/y', 'mcd-commit-fuel'));
  assert.equal(resolveCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h'), join('C:\\L', 'mcd-commit-fuel'));
  assert.equal(resolveCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'linux', '/h'), join('/h', '.cache', 'mcd-commit-fuel'));
  assert.equal(resolveCacheDir({}, 'darwin', '/h'), join('/h', '.cache', 'mcd-commit-fuel'));
});

test('readCache returns an empty cache when missing, corrupt or a different version', async () => {
  assert.deepEqual(await readCache(join(dir, 'nope')), emptyCache());
  await writeFile(join(dir, CACHE_FILE), '{not json');
  assert.deepEqual(await readCache(dir), emptyCache());
  await writeFile(join(dir, CACHE_FILE), JSON.stringify({ version: 99, signals: [] }));
  assert.deepEqual(await readCache(dir), emptyCache());
});

test('write/read round trip drops invalid signals and data keys', async () => {
  const cache = emptyCache();
  cache.signals = [{ kind: 'commit', ts: 1, revert: false }];
  cache.data.account = { fetchedAt: 5, value: { availablePoints: 1, expiringThisMonth: 0, expiringNextMonth: 0 } };
  cache.lastRefreshAt = 7;
  await writeCache(dir, cache);
  assert.deepEqual(await readCache(dir), cache);

  const raw = JSON.parse(await readFile(join(dir, CACHE_FILE), 'utf8'));
  raw.signals.push({ kind: 'commit', ts: 'x' }, { kind: 'push', ts: 1 }, null);
  raw.data.bogus = { value: 1 };
  await writeFile(join(dir, CACHE_FILE), JSON.stringify(raw));
  const back = await readCache(dir);
  assert.equal(back.signals.length, 1);
  assert.deepEqual(Object.keys(back.data), ['account']);
});

test('writeCache leaves no temp files and uses 0600 on POSIX', async () => {
  await writeCache(join(dir, 'nested'), emptyCache());
  assert.deepEqual(await readdir(join(dir, 'nested')), [CACHE_FILE]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'nested', CACHE_FILE))).mode & 0o777, 0o600);
  }
});

test('tryLock: exclusive, reclaims stale locks, release only removes own lock', async () => {
  const path = join(dir, 'x.lock');
  let now = 1_000;
  const clock = () => now;

  const first = await tryLock(path, 60_000, clock);
  assert.ok(first);
  assert.equal(await tryLock(path, 60_000, clock), undefined);

  now += 61_000;
  const second = await tryLock(path, 60_000, clock);
  assert.ok(second, 'stale lock should be reclaimed');

  await first(); // 旧持有者释放时不能删掉新锁
  assert.equal(await tryLock(path, 60_000, clock), undefined);
  await second();
  assert.ok(await tryLock(path, 60_000, clock));
});

test('concurrent updates do not lose signals', async () => {
  const now = Date.now();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => recordSignals(dir, [{ kind: 'commit', ts: now - i * 1000, revert: false }], now)),
  );
  assert.equal((await readCache(dir)).signals.length, 20);
});

test('updateCache accepts a returned object', async () => {
  await updateCache(dir, () => ({ ...emptyCache(), lastRefreshAt: 42 }));
  assert.equal((await readCache(dir)).lastRefreshAt, 42);
});

test('mergeSignals deduplicates by kind, time and task id', () => {
  const now = Date.now();
  const a: Signal = { kind: 'commit', ts: now - 10, revert: false };
  const s1: Signal = { kind: 'task-start', ts: now - 5, id: 't1', category: 'build' };
  const s2: Signal = { kind: 'task-start', ts: now - 5, id: 't2', category: 'build' };
  const merged = mergeSignals([a, s1], [a, s1, s2], now);
  assert.equal(merged.length, 3);
});
