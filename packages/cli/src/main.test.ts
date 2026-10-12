import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, readCache, type Signal } from '@mcd-commit-fuel/core';
import { run, type Deps, type Io } from './main.js';

const NOW = new Date(2026, 9, 10, 14, 0).getTime();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcd-fuel-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

function deps(overrides: Partial<Deps> = {}): Partial<Deps> {
  return {
    env: { MCD_FUEL_CACHE_DIR: dir },
    cwd: dir,
    now: () => NOW,
    readStdin: async () => '',
    spawnRefresh: () => {},
    collectSignals: async () => [],
    runCommand: async () => 0,
    ...overrides,
  };
}

test('--version prints core version', async () => {
  const io = capture();
  assert.equal(await run(['--version'], io), 0);
  assert.deepEqual(io.out, [VERSION]);
});

test('help lists commands', async () => {
  const io = capture();
  assert.equal(await run([], io), 0);
  const text = io.out.join('\n');
  for (const cmd of ['statusline', 'refresh', 'receipt', 'run']) assert.match(text, new RegExp(`mcd-fuel ${cmd}`));
});

test('unknown command exits 2', async () => {
  const io = capture();
  assert.equal(await run(['nope'], io), 2);
  assert.match(io.err.join('\n'), /未知命令：nope/);
});

test('statusline prints one line and never fails', async () => {
  const io = capture();
  assert.equal(await run(['statusline'], io, deps()), 0);
  assert.deepEqual(io.out, ['🍟 设置 token']);

  const broken = capture();
  assert.equal(await run(['statusline'], broken, deps({ readStdin: async () => Promise.reject(new Error('x')) })), 0);
  assert.deepEqual(broken.out, ['🍟']);
});

test('refresh without token records git signals and recomputes the view', async () => {
  const commit: Signal = { kind: 'commit', ts: NOW - 60_000, revert: false };
  const io = capture();
  const seen: string[] = [];
  assert.equal(
    await run(['refresh', '--cwd', '/repo'], io, deps({ collectSignals: async (cwd) => (seen.push(cwd), [commit]) })),
    0,
  );
  assert.deepEqual(seen, ['/repo']);
  assert.deepEqual(io.out, ['🍟 设置 token', '状态 idle；已更新 无（数据未过期）']);
  const cache = await readCache(dir);
  assert.deepEqual(cache.signals, [commit]);
  assert.equal(cache.view?.text, '🍟 设置 token');
});

test('refresh --quiet prints nothing', async () => {
  const io = capture();
  assert.equal(await run(['refresh', '--quiet'], io, deps()), 0);
  assert.deepEqual(io.out, []);
});

test('run records task start/end with category and exit code, and passes the exit code through', async () => {
  let t = NOW;
  const io = capture();
  const ran: string[][] = [];
  const code = await run(
    ['run', '--', 'npm', 'test'],
    io,
    deps({
      now: () => t,
      runCommand: async (cmd) => {
        ran.push(cmd);
        t += 5 * 60_000;
        return 3;
      },
    }),
  );
  assert.equal(code, 3);
  assert.deepEqual(ran, [['npm', 'test']]);
  const signals = (await readCache(dir)).signals;
  assert.deepEqual(
    signals.map((s) => [s.kind, 'category' in s ? s.category : '', s.kind === 'task-end' ? s.exitCode : null]),
    [
      ['task-start', 'test', null],
      ['task-end', 'test', 3],
    ],
  );
  assert.equal(signals[1]!.ts - signals[0]!.ts, 5 * 60_000);
});

test('run without a command exits 2', async () => {
  const io = capture();
  assert.equal(await run(['run', '--'], io, deps()), 2);
});

test('receipt prints a receipt without network when there is no token', async () => {
  const io = capture();
  assert.equal(
    await run(['receipt'], io, deps({ collectSignals: async () => [{ kind: 'commit', ts: NOW - 60_000, revert: false }] })),
    0,
  );
  const text = io.out.join('\n');
  assert.match(text, /今日小票/);
  assert.match(text, /提交 +x 1/);
});
