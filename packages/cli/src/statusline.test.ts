import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINUTE, emptyCache, writeCache, type CacheFile } from '@mcd-commit-fuel/core';
import { SIGNAL_REFRESH_MS, SPAWN_COOLDOWN_MS, parseStatuslineInput, statusline } from './statusline.js';

const NOW = new Date(2026, 9, 10, 14, 0).getTime();
let dir: string;
let spawned: Array<string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcd-fuel-sl-'));
  spawned = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (now: number, stdin = '', hasToken = true) =>
  statusline({ dir, hasToken, now, stdin, spawnRefresh: (cwd) => spawned.push(cwd) });

function freshCache(): CacheFile {
  const c = emptyCache();
  c.lastRefreshAt = NOW;
  c.data.account = { fetchedAt: NOW, value: { availablePoints: 1200.5, expiringThisMonth: 0, expiringNextMonth: 0 } };
  c.data.myCoupons = { fetchedAt: NOW, value: { total: 8, coupons: [] } };
  c.view = { state: 'idle', lateNight: false, quiet: false, text: '', items: [], computedAt: NOW };
  return c;
}

test('parseStatuslineInput reads workspace.current_dir', () => {
  assert.equal(parseStatuslineInput('{"workspace":{"current_dir":"/repo"},"cwd":"/other"}'), '/repo');
  assert.equal(parseStatuslineInput('{"cwd":"/other"}'), '/other');
  assert.equal(parseStatuslineInput('not json'), undefined);
  assert.equal(parseStatuslineInput(''), undefined);
});

test('empty cache: prompts for token and spawns a refresh once', async () => {
  assert.equal(await run(NOW, '{"workspace":{"current_dir":"/repo"}}', false), '🍟 设置 token');
  assert.deepEqual(spawned, ['/repo']);
  await run(NOW + 1000);
  assert.equal(spawned.length, 1, 'cooldown prevents a second spawn');
  await run(NOW + SPAWN_COOLDOWN_MS + 1000);
  assert.equal(spawned.length, 2);
});

test('fresh cache: shows the summary without spawning', async () => {
  await writeCache(dir, freshCache());
  assert.equal(await run(NOW + MINUTE), '🍟 1200分 · 8券');
  assert.deepEqual(spawned, []);
});

test('stale refresh time triggers a background refresh', async () => {
  await writeCache(dir, freshCache());
  await run(NOW + SIGNAL_REFRESH_MS);
  assert.equal(spawned.length, 1);
});

test('state change computed from cached signals triggers a refresh and shows the new state', async () => {
  const c = freshCache();
  c.signals = [{ kind: 'task-start', ts: NOW - 4 * MINUTE, id: 'b', category: 'build' }];
  await writeCache(dir, c);
  assert.match(await run(NOW + 1000), /^⏳ 构建中/);
  assert.equal(spawned.length, 1);
});
