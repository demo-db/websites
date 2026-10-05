import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDecimalText, compareDecimalValues } from '../public/embed/exact-decimal.js';

test('compares exact decimal strings beyond JavaScript number precision', () => {
  assert.equal(compareDecimalText('9007199254740993.0000', '9007199254740992.9999'), 1);
  assert.equal(compareDecimalText('12345678901234567890.1200', '12345678901234567890.1201'), -1);
});

test('compares signs, scale differences and zero without floating point', () => {
  assert.equal(compareDecimalText('-10.00', '-2.000'), -1);
  assert.equal(compareDecimalText('0.000', '-0.0'), 0);
  assert.equal(compareDecimalText('1.2', '1.2000'), 0);
  assert.equal(compareDecimalText('100000000000000000000', '99999999999999999999'), 1);
  assert.equal(compareDecimalText('+2', '2'), 0);
  assert.equal(compareDecimalText('.5', '0.50'), 0);
  assert.equal(compareDecimalText('1.', '1'), 0);
});

test('decimal column ordering is transitive across null, exact values and malformed text', () => {
  const values = [null, 'bad', '1e2', '-2', '0', '1.00', '+2', '.5', '1.'];
  const sorted = [...values].sort(compareDecimalValues);
  assert.deepEqual(sorted, [null, '-2', '0', '.5', '1.00', '1.', '+2', '1e2', 'bad']);
  for (let i = 1; i < sorted.length; i++) assert.ok(compareDecimalValues(sorted[i - 1], sorted[i]) <= 0);
});
