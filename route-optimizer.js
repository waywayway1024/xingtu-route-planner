'use strict';
// Exact directed Hamiltonian path for small address lists (Held–Karp).
// A fixed destination is excluded from intermediate subsets. Infinity means unreachable.
function optimizeRoute(matrix, fixedEnd = true) {
  const n = matrix.length;
  if (n < 2 || n > 8 || matrix.some((row) => row.length !== n || row.some((value) => value < 0 || Number.isNaN(value)))) throw new Error('路线矩阵不合法');
  const targets = Array.from({ length: n - (fixedEnd ? 2 : 1) }, (_, i) => i + 1);
  const count = targets.length;
  if (!count) return Number.isFinite(matrix[0][n - 1]) ? { order: [0, n - 1], cost: matrix[0][n - 1] } : null;
  const size = 1 << count;
  const dp = Array.from({ length: size }, () => Array(count).fill(Infinity));
  const previous = Array.from({ length: size }, () => Array(count).fill(-1));
  targets.forEach((target, j) => { dp[1 << j][j] = matrix[0][target]; });
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < count; last++) {
      if (!(mask & (1 << last)) || !Number.isFinite(dp[mask][last])) continue;
      for (let next = 0; next < count; next++) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        const cost = dp[mask][last] + matrix[targets[last]][targets[next]];
        if (cost < dp[nextMask][next]) { dp[nextMask][next] = cost; previous[nextMask][next] = last; }
      }
    }
  }
  let best = Infinity, last = -1;
  for (let j = 0; j < count; j++) {
    const cost = dp[size - 1][j] + (fixedEnd ? matrix[targets[j]][n - 1] : 0);
    if (cost < best) { best = cost; last = j; }
  }
  if (last === -1) return null;
  const path = [];
  let mask = size - 1;
  while (last !== -1) { path.push(targets[last]); const next = previous[mask][last]; mask ^= 1 << last; last = next; }
  path.reverse();
  return { order: [0, ...path, ...(fixedEnd ? [n - 1] : [])], cost: best };
}
// Reuse the exact directed path solver for every possible starting place.
function optimizeTourRoute(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2 || matrix.length > 8 || matrix.some((row) => !Array.isArray(row) || row.length !== matrix.length || row.some((value) => typeof value !== 'number' || value < 0 || Number.isNaN(value)))) throw new Error('路线矩阵不合法');
  let best = null;
  for (let start = 0; start < matrix.length; start++) {
    const indices = [start, ...Array.from({ length: matrix.length }, (_, i) => i).filter((i) => i !== start)];
    const candidate = optimizeRoute(indices.map((i) => indices.map((j) => matrix[i][j])), false);
    if (candidate && (!best || candidate.cost < best.cost)) best = { order: candidate.order.map((i) => indices[i]), cost: candidate.cost };
  }
  return best;
}
if (typeof module !== 'undefined') module.exports = { optimizeRoute, optimizeTourRoute };
else window.RouteOptimizer = { optimizeRoute, optimizeTourRoute };
