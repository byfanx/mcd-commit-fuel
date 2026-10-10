import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '@mcd-commit-fuel/core';
import { run, type Io } from './main.js';

function capture(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

test('--version prints core version', async () => {
  const io = capture();
  assert.equal(await run(['--version'], io), 0);
  assert.deepEqual(io.out, [VERSION]);
});

test('help includes disclaimer', async () => {
  const io = capture();
  assert.equal(await run([], io), 0);
  assert.match(io.out.join('\n'), /非麦当劳官方产品/);
});

test('unknown command exits 2', async () => {
  const io = capture();
  assert.equal(await run(['nope'], io), 2);
  assert.match(io.err.join('\n'), /未知命令：nope/);
});
