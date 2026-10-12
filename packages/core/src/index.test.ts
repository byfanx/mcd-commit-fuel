import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from './index.js';

test('exports version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
