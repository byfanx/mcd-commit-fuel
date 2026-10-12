import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, isReleaseTag, isRevertMessage, pruneSignals, type Signal } from './signals.js';
import { HOUR } from './time.js';

test('classifyTask: test wins over build', () => {
  const cases: Array<[string, string]> = [
    ['npm test', 'test'],
    ['npm run test:unit', 'test'],
    ['npx vitest run', 'test'],
    ['pytest -q', 'test'],
    ['mvn test', 'test'],
    ['./gradlew test', 'test'],
    ['go test ./...', 'test'],
    ['make test', 'test'],
    ['npm run build', 'build'],
    ['tsc -b', 'build'],
    ['mvn package', 'build'],
    ['cargo build --release', 'build'],
    ['make', 'build'],
    ['ls -la', 'other'],
    ['npm install latest', 'other'],
    ['git push', 'other'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyTask(input), expected, input);
});

test('isRevertMessage', () => {
  assert.equal(isRevertMessage('Revert "feat: add x"'), true);
  assert.equal(isRevertMessage('  revert: undo y'), true);
  assert.equal(isRevertMessage('Reverted the cache'), false);
  assert.equal(isRevertMessage('fix: revert handling'), false);
});

test('isReleaseTag', () => {
  assert.equal(isReleaseTag('v1.2.3'), true);
  assert.equal(isReleaseTag('1.0.0-rc.1'), true);
  assert.equal(isReleaseTag('nightly'), false);
  assert.equal(isReleaseTag('release-2026', '^release-'), true);
  // 非法的自定义正则回退到默认规则
  assert.equal(isReleaseTag('v2.0.0', '['), true);
});

test('pruneSignals keeps last 24h sorted and caps count', () => {
  const now = 100 * HOUR;
  const signals: Signal[] = [
    { kind: 'commit', ts: now - 1 * HOUR, revert: false },
    { kind: 'commit', ts: now - 30 * HOUR, revert: false },
    { kind: 'tag', ts: now - 2 * HOUR, release: true },
    { kind: 'commit', ts: Number.NaN, revert: false },
  ];
  assert.deepEqual(
    pruneSignals(signals, now).map((s) => s.ts),
    [now - 2 * HOUR, now - 1 * HOUR],
  );
  assert.deepEqual(
    pruneSignals(signals, now, { maxCount: 1 }).map((s) => s.ts),
    [now - 1 * HOUR],
  );
});
