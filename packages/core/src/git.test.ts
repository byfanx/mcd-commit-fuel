import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGitSignals, parseCommitLog, parseTagRefs } from './git.js';

test('parseCommitLog keeps only time and revert flag', () => {
  const signals = parseCommitLog('1791610663\tfeat: add x\n1791600227\tRevert "feat: add x"\n\nbad line\nabc\tnope\n');
  assert.deepEqual(signals, [
    { kind: 'commit', ts: 1791610663000, revert: false },
    { kind: 'commit', ts: 1791600227000, revert: true },
  ]);
  assert.ok(!JSON.stringify(signals).includes('feat'), 'subjects must not be kept');
});

test('parseTagRefs filters by time and release pattern', () => {
  const text = '2000\tv1.2.3\n1500\tnightly\n500\tv0.0.1\n';
  assert.deepEqual(parseTagRefs(text, 1_000_000), [
    { kind: 'tag', ts: 2_000_000, release: true },
    { kind: 'tag', ts: 1_500_000, release: false },
  ]);
  assert.deepEqual(
    parseTagRefs('2000\trelease-1\n', 0, '^release-').map((s) => s.kind === 'tag' && s.release),
    [true],
  );
});

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'mcd-fuel-git-'));
  git('init', '-q');
  await writeFile(join(repo, 'a.txt'), '1');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'feat: first');
  await writeFile(join(repo, 'a.txt'), '2');
  git('commit', '-q', '-am', 'Revert "feat: first"');
  git('tag', '-a', 'v1.0.0', '-m', 'release');
  git('tag', 'scratch');
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

test('collectGitSignals reads recent commits and tags from a real repo', async () => {
  const signals = await collectGitSignals(repo, Date.now() + 1000);
  const commits = signals.filter((s) => s.kind === 'commit');
  const tags = signals.filter((s) => s.kind === 'tag');
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map((s) => s.kind === 'commit' && s.revert).sort(), [false, true]);
  assert.deepEqual(tags.map((s) => s.kind === 'tag' && s.release).sort(), [false, true]);
});

test('collectGitSignals returns [] outside a repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcd-fuel-nogit-'));
  try {
    assert.deepEqual(await collectGitSignals(dir, Date.now()), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
