'use strict';

/*
 * solver.js — 最贴近参考权重的非负交叉表求解
 *
 * 问题（带箱型约束的 KL 投影，即有界 IPF 的不动点）：
 *   minimize  Σ x_ij · log(x_ij / p_ij)   （仅对允许格；禁用格恒为 0）
 *   s.t.      Σ_j x_ij = 行边际 a_i
 *             Σ_i x_ij = 列边际 b_j
 *             l_ij ≤ x_ij ≤ u_ij
 *
 * 迭代：交替执行「行缩放」与「列缩放」，每一步在箱型约束下解一维 KL
 * 最小化。由于每行/列都是“缩放 + 截断到 [l,u]”的单调函数，缩放因子
 * 用二分法求根。无上下限时退化为经典 IPF（乘性迭代）。
 *
 * 参考零与业务禁用严格分开：
 *   - 业务禁用：不出现在变量集合中，迭代中恒为 0，绝不被任何平滑填入；
 *   - 参考权重为 0 的允许格：按用户选择，要么保持精确为 0（硬零），
 *     要么用显式小正数 epsilon 代替后参与迭代（平滑）。
 */

function sum(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0);
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (hi != null && hi !== Infinity && v > hi) return hi;
  return v;
}

/**
 * 在箱型约束下求缩放因子 f，使 Σ_j clamp(f·w_j, l_j, u_j) = target。
 * 目标关于 f 单调连续；f=0 时和为 Σl，f→∞ 时和为 Σu（含 Infinity 边则→∞）。
 * 返回 { f, values }。
 */
function scaleLine(weights, lower, upper, target, scale) {
  const n = weights.length;
  const tol = 1e-13;
  let low = 0;
  let high = 1;

  function valueAt(f) {
    let s = 0;
    for (let k = 0; k < n; k++) {
      let v = f * weights[k];
      const lo = lower[k];
      const hi = upper[k];
      if (v < lo) v = lo;
      else if (hi != null && hi !== Infinity && v > hi) v = hi;
      s += v;
    }
    return s;
  }

  const sumLo = sum(lower);
  if (target <= sumLo + 1e-12 * scale) {
    // 目标已不超过下限和：全部压到下限即可（可行性保证两者相等或数值误差）
    return { f: 0, values: lower.slice() };
  }
  let hasInfinity = upper.some(function (u) { return u == null || u === Infinity; });
  let sumHi = Infinity;
  if (!hasInfinity) {
    sumHi = sum(upper);
    if (target >= sumHi - 1e-12 * scale) {
      return { f: Infinity, values: upper.slice() };
    }
  }

  // 扩展上界直到 f=high 时的截断和 >= target
  let guard = 0;
  while (valueAt(high) < target && guard < 200) {
    high *= 2;
    guard++;
  }

  for (let k = 0; k < 80; k++) {
    const mid = (low + high) / 2;
    if (valueAt(mid) < target) low = mid;
    else high = mid;
    if ((high - low) / Math.max(1, high) < tol) break;
  }
  const f = (low + high) / 2;
  const values = new Array(n);
  for (let k = 0; k < n; k++) {
    values[k] = clamp(f * weights[k], lower[k], upper[k]);
  }
  return { f: f, values: values };
}

/**
 * 主求解入口。
 * model:
 * {
 *   rows, cols, forbidden[r][c], lower[r][c], upper[r][c],
 *   reference[r][c],
 *   zeroMode: 'epsilon' | 'hard',
 *   epsilon: number,                 // zeroMode='epsilon' 时替换参考零的小正数
 *   maxIter, tolRel, tolAbs,
 *   previousTable: number[r][c]|null // 可选：用于展示本次调整的差值
 * }
 */
function solve(model) {
  const rows = model.rows;
  const cols = model.cols;
  const r = rows.length;
  const c = cols.length;
  const forbidden = model.forbidden;
  const lower = model.lower || Array.from({ length: r }, function () { return new Array(c).fill(0); });
  const upper = model.upper || Array.from({ length: r }, function () { return new Array(c).fill(null); });
  const reference = model.reference;
  const zeroMode = model.zeroMode || 'epsilon';
  const eps = model.epsilon != null ? model.epsilon : 1e-6;
  const maxIter = model.maxIter || 5000;
  const tolRel = model.tolRel != null ? model.tolRel : 1e-9;
  const tolAbs = model.tolAbs != null ? model.tolAbs : 1e-8;

  const scale = Math.max(1, sum(rows.map(function (d) { return d.total; })));

  // 有效权重 p：禁用格为 0；允许格参考为零时按模式处理
  const p = Array.from({ length: r }, function () { return new Array(c).fill(0); });
  const refZeroCells = [];
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      if (forbidden[i][j]) continue;
      if (reference[i][j] > 0) {
        p[i][j] = reference[i][j];
      } else {
        refZeroCells.push([i, j]);
        p[i][j] = zeroMode === 'epsilon' ? eps : 0;
      }
    }
  }

  // 退化检查：某行/列在允许格上的有效权重全为零，迭代无法启动
  for (let i = 0; i < r; i++) {
    if (rows[i].total > tolAbs && p[i].every(function (v) { return v <= 0; })) {
      return {
        ok: false,
        stopReason: 'degenerate',
        message: '「' + rows[i].name + '」所有允许格的参考权重均为 0 且未启用小正数平滑，无法为 ' +
          rows[i].total + ' 人的行总量分配流量。请在设置中启用 ε 平滑，或调整参考权重。'
      };
    }
  }
  for (let j = 0; j < c; j++) {
    if (cols[j].total > tolAbs) {
      let any = false;
      for (let i = 0; i < r; i++) if (!forbidden[i][j] && p[i][j] > 0) { any = true; break; }
      if (!any) {
        return {
          ok: false,
          stopReason: 'degenerate',
          message: '「' + cols[j].name + '」所有允许格的参考权重均为 0 且未启用小正数平滑，无法满足列总量。'
        };
      }
    }
  }

  // 初始化 x
  const x = Array.from({ length: r }, function () { return new Array(c).fill(0); });
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      if (forbidden[i][j]) continue;
      const lo = lower[i][j] || 0;
      const hi = upper[i][j];
      x[i][j] = rows[i].total <= tolAbs ? 0 : clamp(p[i][j], lo, hi);
    }
  }

  // 每行/列的允许格索引（迭代只在这些格子上进行，禁用格永不触碰）
  const rowCells = Array.from({ length: r }, function (_, i) {
    const idx = [];
    for (let j = 0; j < c; j++) if (!forbidden[i][j]) idx.push(j);
    return idx;
  });
  const colCells = Array.from({ length: c }, function (_, j) {
    const idx = [];
    for (let i = 0; i < r; i++) if (!forbidden[i][j]) idx.push(i);
    return idx;
  });

  function klDivergence() {
    let kl = 0;
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) {
        if (forbidden[i][j] || p[i][j] <= 0) continue;
        if (x[i][j] > 0) kl += x[i][j] * Math.log(x[i][j] / p[i][j]);
      }
    }
    return kl;
  }

  function errors() {
    const rowErrors = [];
    let maxAbs = 0;
    for (let i = 0; i < r; i++) {
      const got = sum(x[i]);
      const abs = Math.abs(got - rows[i].total);
      const rel = rows[i].total > 0 ? abs / rows[i].total : abs;
      rowErrors.push({ abs: abs, rel: rel, got: got, target: rows[i].total });
      if (abs > maxAbs) maxAbs = abs;
    }
    const colErrors = [];
    for (let j = 0; j < c; j++) {
      let got = 0;
      for (let i = 0; i < r; i++) got += x[i][j];
      const abs = Math.abs(got - cols[j].total);
      const rel = cols[j].total > 0 ? abs / cols[j].total : abs;
      colErrors.push({ abs: abs, rel: rel, got: got, target: cols[j].total });
      if (abs > maxAbs) maxAbs = abs;
    }
    return { rowErrors: rowErrors, colErrors: colErrors, maxAbs: maxAbs };
  }

  const history = [];
  const HISTORY_CAP = 400;
  let stopReason = null;
  let prevMaxAbs = Infinity;
  let stallCount = 0;
  let iter = 0;

  for (iter = 1; iter <= maxIter; iter++) {
    // —— 行缩放 ——
    for (let i = 0; i < r; i++) {
      const idx = rowCells[i];
      if (idx.length === 0 || rows[i].total <= tolAbs) {
        for (const j of idx) x[i][j] = 0;
        continue;
      }
      // 半投影步必须缩放“当前表”：x' = clamp(f·x, l, u)，
      // 用参考权重 p 会丢掉上一轮的行/列修正而导致振荡。
      const w = idx.map(function (j) { return x[i][j]; });
      const lo = idx.map(function (j) { return lower[i][j] || 0; });
      const hi = idx.map(function (j) { return upper[i][j]; });
      const out = scaleLine(w, lo, hi, rows[i].total, scale);
      for (let k = 0; k < idx.length; k++) x[i][idx[k]] = out.values[k];
    }

    // —— 列缩放 ——
    for (let j = 0; j < c; j++) {
      const idx = colCells[j];
      if (idx.length === 0 || cols[j].total <= tolAbs) {
        for (const i of idx) x[i][j] = 0;
        continue;
      }
      const w = idx.map(function (i) { return x[i][j]; });
      const lo = idx.map(function (i) { return lower[i][j] || 0; });
      const hi = idx.map(function (i) { return upper[i][j]; });
      const out = scaleLine(w, lo, hi, cols[j].total, scale);
      for (let k = 0; k < idx.length; k++) x[idx[k]][j] = out.values[k];
    }

    const e = errors();
    const maxRel = Math.max(
      ...e.rowErrors.map(function (d) { return d.rel; }),
      ...e.colErrors.map(function (d) { return d.rel; })
    );
    const kl = klDivergence();

    // 历史最多保留 HISTORY_CAP 个点：前 20 轮永久保留（观察起步），
    // 之后按动态步长等距抽样；超出容量时只淘汰第 20 个之后的旧点，
    // 并保证最后一轮（含收敛/停滞轮）被记录。
    const stride = Math.max(1, Math.floor(iter / 200));
    const sample = history.length < 20 || iter <= 20 || iter % stride === 0;
    if (sample) {
      if (history.length >= HISTORY_CAP) history.splice(20, 1);
      history.push({ iter: iter, maxAbs: e.maxAbs, maxRel: maxRel, kl: kl });
    }

    if (e.maxAbs <= tolAbs || maxRel <= tolRel) {
      stopReason = 'converged';
      break;
    }
    const improvement = prevMaxAbs - e.maxAbs;
    if (improvement <= 1e-14 * scale) {
      stallCount++;
      if (stallCount >= 50) {
        stopReason = 'stalled';
        break;
      }
    } else {
      stallCount = 0;
    }
    prevMaxAbs = e.maxAbs;
  }

  if (!stopReason) stopReason = 'max-iter';

  const finalErrors = errors();

  // 参考零格最终被填入正值的诊断
  const refZeroFilled = [];
  for (const zc of refZeroCells) {
    const i = zc[0];
    const j = zc[1];
    if (x[i][j] > 1e-10 * scale) {
      refZeroFilled.push({
        rowName: rows[i].name,
        colName: cols[j].name,
        value: x[i][j],
        mode: zeroMode
      });
    }
  }

  // 与上一次解的差值，展示每次调整如何挤占其他格子
  let diff = null;
  if (model.previousTable) {
    diff = Array.from({ length: r }, function (_, i) {
      return Array.from({ length: c }, function (_, j) {
        return x[i][j] - (model.previousTable[i][j] || 0);
      });
    });
  }

  return {
    ok: true,
    table: x,
    diff: diff,
    iterations: iter,
    stopReason: stopReason,
    stopReasonText: stopReasonText(stopReason),
    rowErrors: finalErrors.rowErrors,
    colErrors: finalErrors.colErrors,
    maxAbsError: finalErrors.maxAbs,
    klDivergence: klDivergence(),
    history: history,
    refZeroFilled: refZeroFilled,
    zeroMode: zeroMode,
    epsilon: eps
  };
}

function stopReasonText(reason) {
  switch (reason) {
    case 'converged':
      return '已收敛：所有行/列边际误差同时低于容差（相对 1e-9 或绝对 1e-8）。';
    case 'max-iter':
      return '达到最大迭代次数后停止：边际误差仍未低于容差，可在设置中提高迭代上限。';
    case 'stalled':
      return '迭代停滞：连续多轮误差不再下降，通常由紧的上下界与参考权重冲突造成，当前解为可达到的最佳折中。';
    case 'degenerate':
      return '退化：有效参考权重无法支撑迭代（见具体提示）。';
    default:
      return reason;
  }
}

const api = { solve: solve, scaleLine: scaleLine, stopReasonText: stopReasonText };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XTabSolver = Object.assign(window.XTabSolver || {}, api);
