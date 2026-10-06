const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optimizeRoute } = require('../route-optimizer.js');
function permutations(items) { if (!items.length) return [[]]; return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest])); }
function brute(matrix, fixed) {
  const n = matrix.length;
  const targets = Array.from({ length: n - (fixed ? 2 : 1) }, (_, i) => i + 1);
  return Math.min(...permutations(targets).map((path) => { const order = [0, ...path, ...(fixed ? [n - 1] : [])]; return order.slice(1).reduce((sum, to, i) => sum + matrix[order[i]][to], 0); }));
}
test('fixed destination and directed road costs', () => {
  const matrix = [[0, 20, 2, 1], [3, 0, 20, 2], [4, 2, 0, 20], [1, 1, 1, 0]];
  assert.deepEqual(optimizeRoute(matrix), { order: [0, 2, 1, 3], cost: 6 });
});
test('free destination can change the last stop', () => {
  const matrix = [[0, 20, 2, 1], [3, 0, 20, 2], [4, 2, 0, 20], [1, 1, 1, 0]];
  assert.deepEqual(optimizeRoute(matrix, false), { order: [0, 3, 2, 1], cost: 4 });
});
test('unreachable and duplicate locations', () => {
  assert.equal(optimizeRoute([[0, Infinity, 1], [1, 0, 1], [1, 1, 0]]), null);
  assert.deepEqual(optimizeRoute([[0, 0, 5], [0, 0, 5], [5, 5, 0]]), { order: [0, 1, 2], cost: 5 });
});
test('matches exhaustive search for asymmetric matrices, fixed and free endpoints', () => {
  let seed = 41;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed % 100 + 1; };
  for (let n = 2; n <= 7; n++) for (let round = 0; round < 8; round++) {
    const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : random()));
    for (const fixed of [true, false]) {
      const result = optimizeRoute(matrix, fixed);
      assert.equal(result.cost, brute(matrix, fixed));
      assert.equal(new Set(result.order).size, n);
      assert.equal(result.order[0], 0);
      if (fixed) assert.equal(result.order.at(-1), n - 1);
    }
  }
});
