import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCLAIMER, VERSION } from './index.js';

test('exports version and disclaimer', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(DISCLAIMER, '非麦当劳官方产品');
});
