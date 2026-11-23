'use strict';

const assert = require('assert');
const { Dinic, checkFeasibility } = require('../src/flow.js');
const { solve, scaleLine } = require('../src/solver.js');
const { PRESETS, clonePreset, zeros } = require('../src/presets.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e));
  }
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= (tol || 1e-6);
}

function sumRow(x, i) { return x[i].reduce(function (a, b) { return a + b; }, 0); }
function sumCol(x, j) { return x.reduce(function (a, row) { return a + row[j]; }, 0); }

function buildOverrides(preset, patch) {
  const m = clonePreset(preset);
  if (patch) Object.assign(m, patch);
  return m;
}

// ---------- 工具：Dinic 基本正确性 ----------
test('Dinic 简单网络最大流', function () {
  const d = new Dinic(4);
  d.addEdge(0, 1, 3);
  d.addEdge(0, 2, 2);
  d.addEdge(1, 3, 2);
  d.addEdge(2, 3, 3);
  assert.strictEqual(d.maxFlow(0, 3), 4);
});

// ---------- 1. 基础示例可行且边际满足 ----------
const basic = clonePreset(PRESETS[0]);

test('① 基础示例：可行性通过', function () {
  const f = checkFeasibility(basic);
  assert.strictEqual(f.feasible, true, JSON.stringify(f.reasons));
});

test('① 基础示例：求解收敛且行/列边际全部满足', function () {
  const s = solve(basic);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.stopReason, 'converged', s.stopReasonText);
  const r = basic.rows.length;
  const c = basic.cols.length;
  for (let i = 0; i < r; i++) assert.ok(approx(sumRow(s.table, i), basic.rows[i].total, 1e-6));
  for (let j = 0; j < c; j++) assert.ok(approx(sumCol(s.table, j), basic.cols[j].total, 1e-6));
});

test('① 基础示例：禁用格 (远郊×地铁) 恒为 0，绝不被平滑', function () {
  const s = solve(basic);
  assert.strictEqual(s.table[2][0], 0);
  for (const row of s.table) for (const v of row) assert.ok(v >= -1e-12);
});

test('① 基础示例：所有格子非负且在上限内', function () {
  const m = buildOverrides(basic);
  m.upper[0][0] = 55; // 必须 >= 50，否则地铁列总量无法满足
  const f = checkFeasibility(m);
  assert.strictEqual(f.feasible, true, JSON.stringify(f.reasons));
  const s = solve(m);
  assert.strictEqual(s.stopReason, 'converged');
  assert.ok(s.table[0][0] <= 55 + 1e-7);
});

test('① 基础示例：总量合计 200', function () {
  const f = checkFeasibility(basic);
  assert.strictEqual(f.rowSum, 200);
  assert.strictEqual(f.colSum, 200);
});

// ---------- 2. 局部不可行：最小割见证 ----------
const localInf = clonePreset(PRESETS[1]);

test('② 局部不可行：判定不可行', function () {
  const f = checkFeasibility(localInf);
  assert.strictEqual(f.feasible, false);
});

test('② 局部不可行：见证指出甲地区、需求100、容量90、缺口10', function () {
  const f = checkFeasibility(localInf);
  assert.ok(f.witness, '应返回最小割见证');
  assert.strictEqual(f.witness.kind, 'structural');
  assert.deepStrictEqual(f.witness.rowNames, ['甲地区']);
  assert.strictEqual(f.witness.need, 100);
  assert.strictEqual(f.witness.capacity, 90);
  assert.strictEqual(f.witness.deficit, 10);
});

test('② 局部不可行：列出被禁用切断的连接', function () {
  const f = checkFeasibility(localInf);
  const links = f.witness.blockedLinks.map(function (b) { return b.rowName + '✕' + b.colName; });
  assert.ok(links.includes('甲地区✕方式B'));
  assert.ok(links.includes('甲地区✕方式C'));
});

test('② 局部不可行：原因信息是可读文字而非“迭代失败”', function () {
  const f = checkFeasibility(localInf);
  const joined = f.reasons.map(function (x) { return x.message; }).join(' ');
  assert.ok(joined.indexOf('缺口 10') >= 0);
  assert.ok(joined.indexOf('迭代') < 0);
});

// ---------- 总量不一致 ----------
test('总量不一致：直接报边际合计差', function () {
  const m = clonePreset(basic);
  m.rows[0].total = 110;
  const f = checkFeasibility(m);
  assert.strictEqual(f.feasible, false);
  assert.strictEqual(f.reasons[0].type, 'total-mismatch');
});

// ---------- 3. 上限挤占 ----------
const squeeze = clonePreset(PRESETS[2]);

test('③ 上限挤占：仍然可行', function () {
  assert.strictEqual(checkFeasibility(squeeze).feasible, true);
});

test('③ 上限挤占：城区×地铁被压到 ≤55，其他格承接流量', function () {
  const base = solve(basic);
  const s = solve(buildOverrides(squeeze, { previousTable: base.table }));
  assert.strictEqual(s.stopReason, 'converged');
  assert.ok(s.table[0][0] <= 55 + 1e-7);
  assert.ok(approx(s.table[0][0], 55, 1e-5), '受限格应贴着上限');
  // 差值表：该格减少，同行其他格增加
  assert.ok(s.diff[0][0] < 0);
  assert.ok(s.diff[0][1] + s.diff[0][2] > 0);
});

test('③ 上限过紧导致不可行时给出饱和格证据', function () {
  const m = clonePreset(squeeze);
  m.upper[0][0] = 20; // 地铁列需110，城区最多给20，其余两行最多供给60 -> 缺30
  const f = checkFeasibility(m);
  assert.strictEqual(f.feasible, false);
  assert.ok(f.witness);
  assert.ok(f.witness.saturatedCells.some(function (s) {
    return s.rowName === '城区' && s.colName === '地铁';
  }));
});

// ---------- 4. 下限冲突 ----------
const lowerConflict = clonePreset(PRESETS[3]);

test('④ 下限冲突：静态检查拦截，无需迭代', function () {
  const f = checkFeasibility(lowerConflict);
  assert.strictEqual(f.feasible, false);
  assert.ok(f.reasons.some(function (x) { return x.type === 'row-lower-exceeded'; }));
});

test('④ 下限恢复后可行且该格被强制在 ≥ 下限', function () {
  const m = clonePreset(lowerConflict);
  m.lower[2][1] = 30;
  assert.strictEqual(checkFeasibility(m).feasible, true);
  const s = solve(m);
  assert.strictEqual(s.stopReason, 'converged');
  assert.ok(s.table[2][1] >= 30 - 1e-7);
});

test('禁用格上设置正下限：报错', function () {
  const m = clonePreset(basic);
  m.lower[2][0] = 5; // 远郊×地铁是禁用格
  const f = checkFeasibility(m);
  assert.strictEqual(f.feasible, false);
  assert.ok(f.reasons.some(function (x) { return x.type === 'lower-on-forbidden'; }));
});

test('下限>上限：报错', function () {
  const m = clonePreset(basic);
  m.lower[0][0] = 40;
  m.upper[0][0] = 20;
  const f = checkFeasibility(m);
  assert.strictEqual(f.feasible, false);
  assert.ok(f.reasons.some(function (x) { return x.type === 'lower-above-upper'; }));
});

// ---------- 5. 参考零 vs 业务禁用 ----------
const refZero = clonePreset(PRESETS[4]);

test('⑤ 业务禁用格 (南区×轨交) 始终为零', function () {
  const s = solve(refZero);
  assert.strictEqual(s.table[2][0], 0);
});

test('⑤ ε 平滑：参考零格 (东地区×步行) 被填入小正数', function () {
  const s = solve(refZero);
  assert.strictEqual(s.stopReason, 'converged');
  assert.ok(s.table[0][1] > 0);
  assert.strictEqual(s.refZeroFilled.length, 1);
  assert.strictEqual(s.refZeroFilled[0].mode, 'epsilon');
});

test('⑤ 硬零模式：参考零格精确为 0，解停滞且给出停止原因', function () {
  const m = clonePreset(refZero);
  m.zeroMode = 'hard';
  const s = solve(m);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.table[0][1], 0);
  assert.ok(['stalled', 'max-iter'].includes(s.stopReason));
  assert.strictEqual(s.table[2][0], 0); // 禁用格依旧为零
});

test('⑤ 硬零且行完全无有效权重：返回退化诊断而非崩溃', function () {
  const m = clonePreset(refZero);
  m.zeroMode = 'hard';
  m.reference[0][0] = 0; // 东地区两格参考全零
  const s = solve(m);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.stopReason, 'degenerate');
  // 同时验证业务禁用与参考零分开：南区禁用格仍然为 0
  assert.ok(m.forbidden[2][0] === true);
});

test('⑤ 改大 ε：参考零格分配量随之增大（其余格被挤占）', function () {
  const small = solve(clonePreset(refZero));
  const big = solve(buildOverrides(refZero, { epsilon: 0.5 }));
  assert.ok(big.table[0][1] > small.table[0][1]);
  assert.strictEqual(big.table[2][0], 0); // 业务禁用格不受平滑影响
});

// ---------- 误差与停止信息 ----------
test('求解结果包含逐行/逐列误差、迭代历史与停止原因文字', function () {
  const s = solve(basic);
  assert.strictEqual(s.rowErrors.length, 3);
  assert.strictEqual(s.colErrors.length, 3);
  assert.ok(s.history.length >= 2);
  assert.ok(typeof s.stopReasonText === 'string' && s.stopReasonText.length > 10);
  assert.ok(s.maxAbsError < 1e-6);
  for (const e of s.rowErrors.concat(s.colErrors)) {
    assert.ok('abs' in e && 'rel' in e && 'got' in e && 'target' in e);
  }
});

test('达到 maxIter 时停止原因为 max-iter', function () {
  const m = clonePreset(refZero);
  m.zeroMode = 'hard';
  const s = solve(Object.assign(m, { maxIter: 3 }));
  assert.strictEqual(s.stopReason, 'max-iter');
});

// ---------- scaleLine 单元测试 ----------
test('scaleLine 无界时退化为精确比例缩放', function () {
  const out = scaleLine([2, 3, 5], [0, 0, 0], [null, null, null], 40, 40);
  assert.ok(approx(out.values[0], 8, 1e-9));
  assert.ok(approx(out.values[1], 12, 1e-9));
  assert.ok(approx(out.values[2], 20, 1e-9));
});

test('scaleLine 有上下限时截断且总和达标', function () {
  const out = scaleLine([2, 3, 5], [0, 0, 0], [5, Infinity, Infinity], 40, 40);
  assert.ok(approx(out.values[0], 5, 1e-9));
  assert.ok(approx(out.values[0] + out.values[1] + out.values[2], 40, 1e-9));
});

test('scaleLine 正下限被尊重', function () {
  const out = scaleLine([0, 10], [3, 0], [Infinity, Infinity], 13, 13);
  assert.ok(out.values[0] >= 3 - 1e-12);
  assert.ok(approx(out.values[0] + out.values[1], 13, 1e-9));
});

// ---------- 全零总量退化 ----------
test('总量为 0 且无正下限：可行，解为全零', function () {
  const m = clonePreset(basic);
  m.rows.forEach(function (d) { d.total = 0; });
  m.cols.forEach(function (d) { d.total = 0; });
  assert.strictEqual(checkFeasibility(m).feasible, true);
  const s = solve(m);
  assert.strictEqual(s.stopReason, 'converged');
  s.table.forEach(function (row) { row.forEach(function (v) { assert.strictEqual(v, 0); }); });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
