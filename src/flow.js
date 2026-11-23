'use strict';

/*
 * flow.js — 容量网络最大流与交叉表可行性判定
 *
 * 交叉表可行性等价于带容量的二分图流问题：
 *   source -> 地区 i  : 容量 = 行边际总数（减去已固定的下限流量）
 *   地区 i -> 方式 j  : 仅当该格未被业务禁用时存在，容量 = 上限 - 下限
 *   方式 j -> sink    : 容量 = 列边际总数（减去下限流量）
 * 最大流等于总需求 iff 可行。不可行时，用残余网络的最小割 reachable
 * 集合给出 Hall 型见证：哪一组地区的总量超过其可连接方式的容量。
 */

function Dinic(n) {
  this.n = n;
  this.g = Array.from({ length: n }, function () { return []; });
}

Dinic.prototype.addEdge = function (u, v, cap) {
  const forward = { to: v, rev: this.g[v].length, cap: cap, flow: 0, finite: cap !== Infinity };
  const backward = { to: u, rev: this.g[u].length, cap: 0, flow: 0, finite: true };
  this.g[u].push(forward);
  this.g[v].push(backward);
};

Dinic.prototype.bfs = function (s, t) {
  const level = new Array(this.n).fill(-1);
  level[s] = 0;
  const q = [s];
  for (let qi = 0; qi < q.length; qi++) {
    const v = q[qi];
    for (const e of this.g[v]) {
      if (e.cap > 1e-12 && level[e.to] < 0) {
        level[e.to] = level[v] + 1;
        q.push(e.to);
      }
    }
  }
  this.level = level;
  return level[t] >= 0;
};

Dinic.prototype.dfs = function (v, t, pushed) {
  if (v === t || pushed === 0) return pushed;
  for (let i = this.it[v]; i < this.g[v].length; i++) {
    this.it[v] = i;
    const e = this.g[v][i];
    if (e.cap <= 1e-12 || this.level[e.to] !== this.level[v] + 1) continue;
    const d = this.dfs(e.to, t, Math.min(pushed, e.cap));
    if (d > 1e-15) {
      e.cap -= d;
      e.flow += d;
      this.g[e.to][e.rev].cap += d;
      this.g[e.to][e.rev].flow -= d;
      return d;
    }
  }
  return 0;
};

Dinic.prototype.maxFlow = function (s, t) {
  let flow = 0;
  while (this.bfs(s, t)) {
    this.it = new Array(this.n).fill(0);
    while (true) {
      const f = this.dfs(s, t, Infinity);
      if (f <= 1e-15) break;
      flow += f;
    }
  }
  return flow;
};

Dinic.prototype.reachableFrom = function (s) {
  const seen = new Array(this.n).fill(false);
  seen[s] = true;
  const q = [s];
  for (let qi = 0; qi < q.length; qi++) {
    const v = q[qi];
    for (const e of this.g[v]) {
      if (e.cap > 1e-10 && !seen[e.to]) {
        seen[e.to] = true;
        q.push(e.to);
      }
    }
  }
  return seen;
};

function sum(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0);
}

/**
 * 判定交叉表可行性。
 *
 * model:
 * {
 *   rows: [{ id, name, total }],
 *   cols: [{ id, name, total }],
 *   forbidden: boolean[r][c],   // 业务禁用（结构零），绝不允许流量
 *   lower:     number[r][c],    // 单元格下限，默认 0
 *   upper:     number[r][c]     // 单元格上限，null/undefined/Infinity 表示无上限
 * }
 *
 * 返回:
 * {
 *   feasible, rowSum, colSum, totalGap,
 *   reasons: [ { type, message, ... }],
 *   witness: null | {
 *     rowIds, rowNames, need,
 *     colIds, colNames, capacity, deficit,
 *     blockedLinks: [{rowName, colName}],
 *     saturatedCells: [{rowName, colName, upper, flow}],
 *     flowDeficit, kind: 'structural' | 'bounds'
 *   }
 * }
 */
function checkFeasibility(model) {
  const rows = model.rows;
  const cols = model.cols;
  const r = rows.length;
  const c = cols.length;
  const forbidden = model.forbidden;
  const lower = model.lower || Array.from({ length: r }, function () { return new Array(c).fill(0); });
  const upper = model.upper || Array.from({ length: r }, function () { return new Array(c).fill(null); });

  const rowSum = sum(rows.map(function (d) { return d.total; }));
  const colSum = sum(cols.map(function (d) { return d.total; }));
  const scale = Math.max(1, rowSum, colSum);
  const tol = 1e-9 * scale;
  const reasons = [];

  const result = {
    feasible: false,
    rowSum: rowSum,
    colSum: colSum,
    totalGap: colSum - rowSum,
    reasons: reasons,
    witness: null
  };

  // 1) 边际总量必须一致
  if (Math.abs(rowSum - colSum) > tol) {
    reasons.push({
      type: 'total-mismatch',
      message: '行边际合计 ' + fmt(rowSum) + ' 与列边际合计 ' + fmt(colSum) +
        ' 不一致（差 ' + fmt(Math.abs(rowSum - colSum)) + '），任何交叉表都无法同时满足两组总数。'
    });
    return result;
  }
  const total = rowSum;
  if (total <= tol) {
    // 全零表：只有全部下限为 0 时可行
    const bad = [];
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < c; j++) {
        if (!forbidden[i][j] && lower[i][j] > tol) bad.push([i, j]);
      }
    }
    if (bad.length === 0) {
      result.feasible = true;
    } else {
      reasons.push({ type: 'zero-total-with-lower', message: '总人数为 0，但存在正的单元格下限。' });
    }
    return result;
  }

  // 2) 下限/上限/禁用之间的静态冲突
  const rowLower = new Array(r).fill(0);
  const colLower = new Array(c).fill(0);
  let totalLower = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const lo = lower[i][j] || 0;
      const hi = upper[i][j];
      if (forbidden[i][j] && lo > tol) {
        reasons.push({
          type: 'lower-on-forbidden',
          message: '「' + rows[i].name + ' × ' + cols[j].name + '」是业务禁用格，不能同时设置正下限 ' + fmt(lo) + '。'
        });
      }
      if (lo < -tol) {
        reasons.push({ type: 'negative-lower', message: '「' + rows[i].name + ' × ' + cols[j].name + '」下限为负。' });
      }
      if (hi != null && hi !== Infinity && lo - hi > tol) {
        reasons.push({
          type: 'lower-above-upper',
          message: '「' + rows[i].name + ' × ' + cols[j].name + '」下限 ' + fmt(lo) + ' 超过上限 ' + fmt(hi) + '。'
        });
      }
      if (!forbidden[i][j]) {
        rowLower[i] += lo;
        colLower[j] += lo;
        totalLower += lo;
      }
    }
  }
  for (let i = 0; i < r; i++) {
    if (rowLower[i] - rows[i].total > tol) {
      reasons.push({
        type: 'row-lower-exceeded',
        message: '「' + rows[i].name + '」各格下限合计 ' + fmt(rowLower[i]) +
          ' 超过该行总人数 ' + fmt(rows[i].total) + '。'
      });
    }
  }
  for (let j = 0; j < c; j++) {
    if (colLower[j] - cols[j].total > tol) {
      reasons.push({
        type: 'col-lower-exceeded',
        message: '「' + cols[j].name + '」各格下限合计 ' + fmt(colLower[j]) +
          ' 超过该列总人数 ' + fmt(cols[j].total) + '。'
      });
    }
  }
  if (reasons.length > 0) return result;

  // 3) 残余网络最大流（下限作为已固定流量预先扣除）
  const BIG = total * 2 + 1; // 无上限格的容量：任何格子都不可能超过总需求
  const S = 0;
  const rowBase = 1;
  const colBase = 1 + r;
  const T = 1 + r + c;
  const dinic = new Dinic(T + 1);

  const cellEdges = []; // {i, j, edge, cap}
  for (let i = 0; i < r; i++) {
    dinic.addEdge(S, rowBase + i, rows[i].total - rowLower[i]);
  }
  for (let j = 0; j < c; j++) {
    dinic.addEdge(colBase + j, T, cols[j].total - colLower[j]);
  }
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      if (forbidden[i][j]) continue;
      const lo = lower[i][j] || 0;
      const hiRaw = upper[i][j];
      const hi = (hiRaw == null || hiRaw === Infinity) ? Infinity : hiRaw;
      const cap = hi === Infinity ? BIG : Math.max(0, hi - lo);
      const edgeIdx = dinic.g[rowBase + i].length;
      dinic.addEdge(rowBase + i, colBase + j, cap);
      cellEdges.push({ i: i, j: j, edgeIdx: edgeIdx, cap: cap, finite: hi !== Infinity, upper: hi });
    }
  }

  const required = total - totalLower;
  const flow = dinic.maxFlow(S, T);
  const flowDeficit = required - flow;

  if (flowDeficit <= 1e-7 * scale) {
    result.feasible = true;
    return result;
  }

  // 4) 最小割见证：残余网络中从 source 可达的行/列
  const reach = dinic.reachableFrom(S);
  const reachRows = [];
  for (let i = 0; i < r; i++) if (reach[rowBase + i]) reachRows.push(i);
  const reachCols = [];
  for (let j = 0; j < c; j++) if (reach[colBase + j]) reachCols.push(j);

  if (reachRows.length === 0) {
    reasons.push({ type: 'flow-failed', message: '最大流未能满足总需求，且未找到割见证（数值异常，请检查输入）。' });
    return result;
  }

  const reachSet = new Set(reachRows);
  const neighborCols = new Set();
  const blockedLinks = [];
  for (const i of reachRows) {
    for (let j = 0; j < c; j++) {
      if (!forbidden[i][j]) neighborCols.add(j);
    }
  }
  // 解释隔离：可达行去不了的列，逐条列出禁用关系
  for (const i of reachRows) {
    for (let j = 0; j < c; j++) {
      if (forbidden[i][j] && !neighborCols.has(j)) {
        blockedLinks.push({ rowName: rows[i].name, colName: cols[j].name });
      }
    }
  }

  const need = sum(reachRows.map(function (i) { return rows[i].total; }));
  const neighborList = Array.from(neighborCols);
  const capacity = sum(neighborList.map(function (j) { return cols[j].total; }));
  const deficit = need - capacity;

  // 饱和的有限容量格边：上限挤占的直接证据
  const saturatedCells = [];
  for (const ce of cellEdges) {
    if (!reachSet.has(ce.i)) continue;
    if (reach[colBase + ce.j]) continue; // 割的另一侧才算被切断的边
    const edge = dinic.g[rowBase + ce.i][ce.edgeIdx];
    if (ce.finite && edge.cap <= 1e-8 * Math.max(1, ce.cap)) {
      saturatedCells.push({
        rowName: rows[ce.i].name,
        colName: cols[ce.j].name,
        upper: ce.upper,
        flow: (lower[ce.i][ce.j] || 0) + edge.flow
      });
    }
  }

  const kind = deficit > tol ? 'structural' : 'bounds';
  const rowNames = reachRows.map(function (i) { return rows[i].name; });
  const colNames = neighborList.map(function (j) { return cols[j].name; });

  if (kind === 'structural') {
    reasons.push({
      type: 'hall-violation',
      message: '地区组【' + rowNames.join('、') + '】合计 ' + fmt(need) +
        ' 人，但它们能连接的方式【' + (colNames.length ? colNames.join('、') : '（无）') +
        '】总容量只有 ' + fmt(capacity) + ' 人，缺口 ' + fmt(deficit) + ' 人。'
    });
    if (blockedLinks.length > 0) {
      reasons.push({
        type: 'blocked-links',
        message: '被业务禁用切断的连接：' +
          blockedLinks.map(function (b) { return b.rowName + ' ✕ ' + b.colName; }).join('；') + '。'
      });
    }
  } else {
    reasons.push({
      type: 'capacity-squeeze',
      message: '结构性连接充足，但单元格上下限使最大流仍差 ' + fmt(flowDeficit) +
        ' 人无法安排。被上限卡死的格子：' +
        (saturatedCells.length
          ? saturatedCells.map(function (s) { return s.rowName + ' × ' + s.colName + '（上限 ' + fmt(s.upper) + '）'; }).join('；')
          : '（见下限设置）') + '。'
    });
  }

  result.witness = {
    kind: kind,
    rowIds: reachRows.map(function (i) { return rows[i].id; }),
    rowNames: rowNames,
    need: need,
    colIds: neighborList.map(function (j) { return cols[j].id; }),
    colNames: colNames,
    capacity: capacity,
    deficit: Math.max(0, deficit),
    blockedLinks: blockedLinks,
    saturatedCells: saturatedCells,
    flowDeficit: flowDeficit
  };
  return result;
}

function fmt(v) {
  if (!isFinite(v)) return String(v);
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return String(Math.round(v * 1e6) / 1e6);
}

const api = { Dinic: Dinic, checkFeasibility: checkFeasibility };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XTabFlow = Object.assign(window.XTabFlow || {}, api);
