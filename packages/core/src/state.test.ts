import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, isLateNight, type DevState } from './state.js';
import type { Signal } from './signals.js';
import { HOUR, MINUTE } from './time.js';

// 用本地时间构造，结果不受运行机器时区影响
const NOW = new Date(2026, 9, 10, 14, 0, 0).getTime();
const ago = (minutes: number) => NOW - minutes * MINUTE;

const commit = (minutesAgo: number, revert = false): Signal => ({ kind: 'commit', ts: ago(minutesAgo), revert });
const tag = (minutesAgo: number, release = true): Signal => ({ kind: 'tag', ts: ago(minutesAgo), release });
const start = (id: string, minutesAgo: number, category: 'build' | 'test' | 'other' = 'build'): Signal => ({
  kind: 'task-start',
  ts: ago(minutesAgo),
  id,
  category,
});
const end = (id: string, minutesAgo: number, exitCode: number, category: 'build' | 'test' | 'other' = 'test'): Signal => ({
  kind: 'task-end',
  ts: ago(minutesAgo),
  id,
  category,
  exitCode,
});

const stateOf = (signals: Signal[]): DevState => evaluate(signals, NOW).state;

test('idle without signals', () => {
  assert.equal(stateOf([]), 'idle');
});

test('focus: 2 commits within 30 minutes', () => {
  assert.equal(stateOf([commit(25), commit(5)]), 'focus');
  assert.equal(stateOf([commit(5)]), 'idle');
  assert.equal(stateOf([commit(40), commit(5)]), 'idle');
});

test('building: unfinished build/test task running ≥ 3 minutes', () => {
  assert.equal(stateOf([start('a', 4)]), 'building');
  assert.equal(stateOf([start('a', 4, 'test')]), 'building');
  assert.equal(stateOf([start('a', 2)]), 'idle');
  assert.equal(stateOf([start('a', 4), end('a', 1, 0, 'build')]), 'idle');
  assert.equal(stateOf([start('a', 4, 'other')]), 'idle');
  // 超过 2 小时没结束视为丢失
  assert.equal(stateOf([start('a', 3 * 60)]), 'idle');
});

test('stuck: 3 consecutive test failures within 20 minutes', () => {
  assert.equal(stateOf([end('1', 15, 1), end('2', 10, 1), end('3', 5, 2)]), 'stuck');
  assert.equal(stateOf([end('1', 15, 1), end('2', 10, 1), end('3', 8, 0), end('4', 5, 1)]), 'idle');
  assert.equal(stateOf([end('1', 30, 1), end('2', 10, 1), end('3', 5, 1)]), 'idle');
  // build 失败不算
  assert.equal(stateOf([end('1', 15, 1, 'build'), end('2', 10, 1, 'build'), end('3', 5, 1, 'build')]), 'idle');
});

test('stuck: 2 reverts within an hour', () => {
  assert.equal(stateOf([commit(50, true), commit(10, true)]), 'stuck');
  assert.equal(stateOf([commit(70, true), commit(10, true)]), 'idle');
});

test('shipped: release tag within 30 minutes', () => {
  assert.equal(stateOf([tag(10)]), 'shipped');
  assert.equal(stateOf([tag(10, false)]), 'idle');
  assert.equal(stateOf([tag(40)]), 'idle');
});

test('wrapup: committed today and idle ≥ 90 minutes', () => {
  assert.equal(stateOf([commit(180)]), 'wrapup');
  assert.equal(stateOf([commit(180), end('t', 60, 0)]), 'idle');
  // 只有昨天的提交（14:00 往前 20 小时是前一天 18:00）
  assert.equal(stateOf([commit(20 * 60)]), 'idle');
});

test('priority: building > stuck > shipped > focus', () => {
  const stuck = [end('1', 15, 1), end('2', 10, 1), end('3', 5, 1)];
  assert.equal(stateOf([...stuck, start('b', 4)]), 'building');
  assert.equal(stateOf([...stuck, tag(5)]), 'stuck');
  assert.equal(stateOf([tag(5), commit(20), commit(3)]), 'shipped');
});

test('ignores signals from the future and unsorted input', () => {
  assert.equal(stateOf([commit(-10), commit(-5)]), 'idle');
  assert.equal(stateOf([commit(3), commit(25)]), 'focus');
});

test('config overrides defaults', () => {
  assert.equal(evaluate([start('a', 2)], NOW, { buildMinutes: 1 }).state, 'building');
  assert.equal(evaluate([commit(5)], NOW, { focusCommitCount: 1 }).state, 'focus');
});

test('lateNight between 22:00 and 06:00', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m).getTime();
  assert.equal(isLateNight(at(23)), true);
  assert.equal(isLateNight(at(5, 59)), true);
  assert.equal(isLateNight(at(6)), false);
  assert.equal(isLateNight(at(21, 59)), false);
  assert.equal(isLateNight(at(23), { lateNightEnabled: false }), false);
  assert.equal(isLateNight(at(3), { lateNightStartHour: 1, lateNightEndHour: 5 }), true);
  assert.equal(isLateNight(at(23), { lateNightStartHour: 1, lateNightEndHour: 5 }), false);
  assert.equal(evaluate([], at(23)).lateNight, true);
  assert.equal(evaluate([], NOW + HOUR).lateNight, false);
});
