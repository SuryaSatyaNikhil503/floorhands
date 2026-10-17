import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parsePage } from '../src/util.js';

test('formatCents renders dollars and cents', () => {
  assert.equal(formatCents(1999), '$19.99');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(-250), '-$2.50');
});

test('parsePage falls back for bad input', () => {
  assert.equal(parsePage('3'), 3);
  assert.equal(parsePage('abc'), 1);
  assert.equal(parsePage('-2'), 1);
});
