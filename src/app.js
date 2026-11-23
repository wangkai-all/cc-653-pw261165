'use strict';

/*
 * app.js — 网页交互层
 * 状态：当前模型 model（边际/参考/禁用/上下界/零策略），每次编辑后重新
 * 执行「可行性检查 →（可行时）有界 IPF 求解」，并与上一版可行解对比差值。
 */

(function () {
  const { PRESETS, clonePreset } = window.XTabPresets;
  const { checkFeasibility } = window.XTabFlow;
  const { solve } = window.XTabSolver;

  // ---------- 状态 ----------
  let model = null;          // 当前工作模型
  let presetIndex = 0;
  let previousTable = null;  // 上一版可行解（用于差值）
  let solution = null;       // 最近一次求解结果
  let feasibility = null;    // 最近一次可行性结果
  let editLogs = [];
  let activeCell = null;     // {i, j}
  let pendingTimer = null;

  const $ = function (sel) { return document.querySelector(sel); };

  // ---------- 数值工具 ----------
  function parseNum(v, fallback) {
    const n = parseFloat(v);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }
  function fmt(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    if (Math.abs(v) < 1e-10) return '0';
    const d = digits == null ? (Math.abs(v) >= 100 ? 1 : 2) : digits;
    return v.toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function fmtSigned(v) {
    if (Math.abs(v) < 5e-4) return '±0';
    return (v > 0 ? '+' : '−') + fmt(Math.abs(v));
  }
  function fmtRel(v) {
    if (v < 1e-12) return '0';
    if (v < 1e-6) return v.toExponential(1);
    return (v * 100).toFixed(3).replace(/\.?0+$/, '') + '%';
  }

  // 顺序蓝色阶插值（heat: 0..1）
  const HEAT_STOPS_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
  const HEAT_STOPS_DARK = ['#103055', '#15406f', '#1c5cab', '#2a78d6', '#3987e5', '#86b6ef'];
  function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) { return Math.round(x).toString(16).padStart(2, '0'); }).join('');
  }
  function isDarkTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches &&
      document.documentElement.getAttribute('data-theme') !== 'light';
  }
  function heatColor(t) {
    const stops = isDarkTheme() ? HEAT_STOPS_DARK : HEAT_STOPS_LIGHT;
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const k = Math.floor(x);
    const frac = x - k;
    const a = hexToRgb(stops[Math.min(k, stops.length - 1)]);
    const b = hexToRgb(stops[Math.min(k + 1, stops.length - 1)]);
    return rgbToHex(a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac);
  }
  // 热力格文字色：亮模式仅最暗两阶（L<0.27）用白字；暗模式仅最亮一阶（L>0.4）用深字，
  // 保证加粗数字对比度 ≥ 3:1（见 tests/contrast-check.js）。
  function heatTextColor(bgHex) {
    const lum = relativeLuminance(bgHex);
    if (isDarkTheme()) return lum > 0.4 ? '#0b0b0b' : '#ffffff';
    return lum < 0.27 ? '#ffffff' : '#0b0b0b';
  }
  function relativeLuminance(hex) {
    const rgb = hexToRgb(hex).map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  // ---------- 初始化 ----------
  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    const sel = $('#presetSelect');
    PRESETS.forEach(function (p, idx) {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      loadPreset(parseInt(sel.value, 10));
    });
    $('#zeroMode').addEventListener('change', scheduleRun);
    $('#epsilon').addEventListener('input', scheduleRun);
    $('#maxIter').addEventListener('input', scheduleRun);
    $('#resetBtn').addEventListener('click', function () { loadPreset(presetIndex); });

    loadPreset(0);
  }

  function loadPreset(idx) {
    presetIndex = idx;
    model = clonePreset(PRESETS[idx]);
    previousTable = null;
    editLogs = [];
    activeCell = null;
    $('#presetSelect').value = String(idx);
    $('#presetDesc').textContent = model.description || '';
    $('#zeroMode').value = model.zeroMode || 'epsilon';
    $('#epsilon').value = model.epsilon != null ? model.epsilon : 0.05;
    $('#maxIter').value = model.maxIter || 5000;
    runPipeline('载入示例「' + PRESETS[idx].name + '」');
  }

  // ---------- 运行管线 ----------
  function scheduleRun() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      runPipeline(null);
    }, 220);
  }

  function syncSettingsFromControls() {
    model.zeroMode = $('#zeroMode').value;
    model.epsilon = parseNum($('#epsilon').value, 0.05);
    model.maxIter = Math.max(10, Math.round(parseNum($('#maxIter').value, 5000)));
  }

  function runPipeline(editLabel) {
    const label = editLabel || pendingLabel || '编辑输入';
    pendingLabel = null;
    syncSettingsFromControls();
    feasibility = checkFeasibility(model);

    if (!feasibility.feasible) {
      solution = null;
      renderFeasibility();
      renderSolverMeta(null);
      renderResultTable(null);
      renderErrorTable(null);
      renderChart(null);
      renderRefZeroNotes(null);
      setGlobalStatus(false);
      addLog(label, null);
      rerenderInputTable();
      return;
    }

    const solverInput = {
      rows: model.rows,
      cols: model.cols,
      forbidden: model.forbidden,
      lower: model.lower,
      upper: model.upper,
      reference: model.reference,
      zeroMode: model.zeroMode,
      epsilon: model.epsilon,
      maxIter: model.maxIter,
      previousTable: previousTable
    };
    solution = solve(solverInput);

    renderFeasibility();
    renderSolverMeta(solution);
    renderResultTable(solution);
    renderErrorTable(solution);
    renderChart(solution);
    renderRefZeroNotes(solution);
    setGlobalStatus(solution.ok);

    if (editLabel) addLog(editLabel, solution);
    if (solution.ok) previousTable = solution.table.map(function (row) { return row.slice(); });
    rerenderInputTable();
  }

  // 重绘输入表时保留正在编辑的输入框焦点与光标/选区，避免每输一个字符就失焦
  function rerenderInputTable() {
    const active = document.activeElement;
    let focusKey = null;
    let selection = null;
    if (active && active.classList && active.classList.contains('cell-input')) {
      focusKey = active.className + '|' + (active.dataset.i || '') + '|' + (active.dataset.j || '');
      selection = { start: active.selectionStart, end: active.selectionEnd };
    }
    renderInputTable();
    if (focusKey) {
      const candidates = document.querySelectorAll('#inputTable .cell-input');
      for (const inp of candidates) {
        const key = inp.className + '|' + (inp.dataset.i || '') + '|' + (inp.dataset.j || '');
        if (key === focusKey) {
          inp.focus();
          if (selection && inp.setSelectionRange) {
            try { inp.setSelectionRange(selection.start, selection.end); } catch (e) { /* number input */ }
          }
          break;
        }
      }
    }
  }

  function setGlobalStatus(ok) {
    const el = $('#globalStatus');
    if (!feasibility.feasible) {
      el.className = 'header-badge bad';
      el.textContent = '✕ 不可行';
    } else if (!ok) {
      el.className = 'header-badge bad';
      el.textContent = '⚠ 求解退化';
    } else {
      el.className = 'header-badge ok';
      el.textContent = '✓ 可行 · ' + (solution.stopReason === 'converged' ? '已收敛' : '注意');
    }
  }

  // ---------- 可行性横幅 ----------
  function renderFeasibility() {
    const banner = $('#feasibilityBanner');
    banner.className = 'banner show ' + (feasibility.feasible ? 'ok' : 'bad');
    let html;
    if (feasibility.feasible) {
      html = '<div class="banner-title">✓ 可行性检查通过</div>' +
        '<div>行边际合计 <b>' + fmt(feasibility.rowSum) + '</b> ＝ 列边际合计 <b>' + fmt(feasibility.colSum) +
        '</b>，且所有禁用关系与上下限均可同时满足，已进入参考权重拟合。</div>';
    } else {
      html = '<div class="banner-title">✕ 当前设置不可行 — 没有任何交叉表能同时满足这些条件</div><ul>';
      feasibility.reasons.forEach(function (r) { html += '<li>' + escapeHtml(r.message) + '</li>'; });
      html += '</ul>';
      const w = feasibility.witness;
      if (w) {
        html += '<div class="witness-box">';
        html += '<div class="kv"><b>类型</b><span>' + (w.kind === 'structural' ? '结构性容量缺口（禁用关系导致）' : '上下限容量挤占') + '</span></div>';
        html += '<div class="kv"><b>地区组</b><span>' + w.rowNames.map(escapeHtml).join('、') + '</span></div>';
        html += '<div class="kv"><b>组内需求</b><span>' + fmt(w.need) + ' 人</span></div>';
        html += '<div class="kv"><b>可连接方式</b><span>' + (w.colNames.length ? w.colNames.map(escapeHtml).join('、') : '（无）') + '</span></div>';
        if (w.kind === 'structural') {
          html += '<div class="kv"><b>方式总容量</b><span>' + fmt(w.capacity) + ' 人</span></div>';
          html += '<div class="kv"><b>缺口</b><span>' + fmt(w.deficit) + ' 人</span></div>';
        } else {
          html += '<div class="kv"><b>流量缺口</b><span>' + fmt(w.flowDeficit) + ' 人</span></div>';
        }
        if (w.saturatedCells && w.saturatedCells.length) {
          html += '<div class="kv"><b>饱和上限格</b><span>' +
            w.saturatedCells.map(function (s) { return escapeHtml(s.rowName) + ' × ' + escapeHtml(s.colName) + '（上限 ' + fmt(s.upper) + '）'; }).join('；') +
            '</span></div>';
        }
        html += '</div>';
      }
    }
    banner.innerHTML = html;
  }

  // ---------- 输入表 ----------
  function renderInputTable() {
    const table = $('#inputTable');
    const r = model.rows.length;
    const c = model.cols.length;
    let html = '<thead><tr><th>地区 ＼ 方式</th>';
    model.cols.forEach(function (col, j) {
      html += '<th>' + escapeHtml(col.name) +
        '<div><input class="cell-input col-total" data-j="' + j + '" value="' + col.total + '" aria-label="列总数 ' + escapeHtml(col.name) + '"></div>' +
        '<div class="cell-meta"><span class="mini-tag">列总数</span></div></th>';
    });
    html += '<th>行合计校验</th></tr></thead><tbody>';

    for (let i = 0; i < r; i++) {
      html += '<tr><th class="row-head">' + escapeHtml(model.rows[i].name) +
        '<div><input class="cell-input row-total" data-i="' + i + '" value="' + model.rows[i].total + '" aria-label="行总数 ' + escapeHtml(model.rows[i].name) + '"></div>' +
        '<div class="cell-meta"><span class="mini-tag">行总数</span></div></th>';
      for (let j = 0; j < c; j++) {
        const forbidden = model.forbidden[i][j];
        const isRefZero = !forbidden && model.reference[i][j] <= 0;
        const hasBound = !forbidden && (
          (model.lower[i][j] || 0) > 0 ||
          (model.upper[i][j] != null && model.upper[i][j] !== Infinity)
        );
        const cls = ['cell'];
        if (forbidden) cls.push('forbidden');
        if (isRefZero) cls.push('refzero');
        if (hasBound) cls.push('bounded');
        if (activeCell && activeCell.i === i && activeCell.j === j) cls.push('active');
        html += '<td><div class="cell ' + cls.join(' ') + '" data-i="' + i + '" data-j="' + j + '">';
        if (forbidden) {
          html += '<span class="forbidden-mark">禁用 · 0</span>';
          html += '<span class="cell-meta"><span class="mini-tag ref">w=' + model.reference[i][j] + '</span></span>';
        } else {
          html += '<input class="cell-input ref-input" data-i="' + i + '" data-j="' + j + '" value="' + model.reference[i][j] + '" aria-label="参考权重 ' + escapeHtml(model.rows[i].name) + ' × ' + escapeHtml(model.cols[j].name) + '">';
          let meta = '<span class="mini-tag ref">w</span>';
          if (hasBound) {
            const lo = model.lower[i][j] || 0;
            const hi = model.upper[i][j];
            meta = '<span class="mini-tag bnd">[' + fmt(lo) + (hi == null || hi === Infinity ? ', ∞)' : ', ' + fmt(hi) + ']') + '</span>';
          }
          html += '<span class="cell-meta">' + meta + '</span>';
        }
        html += '</div></td>';
      }
      // 行合计：参考权重只作相对比例，校验用的是边际总量（在误差表显示），这里放行总数回显
      html += '<td class="marginal">' + fmt(model.rows[i].total) + '</td></tr>';
    }

    // 末行：列合计
    html += '<tr><th class="row-head">列合计</th>';
    for (let j = 0; j < c; j++) {
      html += '<td class="marginal">' + fmt(model.cols[j].total) + '</td>';
    }
    const totalGap = feasibility ? feasibility.rowSum - feasibility.colSum : 0;
    html += '<td class="marginal ' + (Math.abs(totalGap) > 1e-9 ? 'err-bad' : 'err-good') + '">' +
      (Math.abs(totalGap) > 1e-9 ? '差 ' + fmt(Math.abs(totalGap)) : '总量一致') + '</td></tr>';
    html += '</tbody>';
    table.innerHTML = html;

    table.querySelectorAll('.row-total').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const i = parseInt(inp.dataset.i, 10);
        const old = model.rows[i].total;
        model.rows[i].total = parseNum(inp.value, 0);
        scheduleRunWithLabel('修改「' + model.rows[i].name + '」行总数：' + fmt(old) + ' → ' + fmt(model.rows[i].total));
      });
    });
    table.querySelectorAll('.col-total').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const j = parseInt(inp.dataset.j, 10);
        const old = model.cols[j].total;
        model.cols[j].total = parseNum(inp.value, 0);
        scheduleRunWithLabel('修改「' + model.cols[j].name + '」列总数：' + fmt(old) + ' → ' + fmt(model.cols[j].total));
      });
    });
    table.querySelectorAll('.ref-input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const i = parseInt(inp.dataset.i, 10);
        const j = parseInt(inp.dataset.j, 10);
        model.reference[i][j] = Math.max(0, parseNum(inp.value, 0));
        scheduleRunWithLabel('调整参考权重 ' + model.rows[i].name + ' × ' + model.cols[j].name);
      });
    });
    table.querySelectorAll('.cell').forEach(function (cell) {
      cell.addEventListener('click', function (e) {
        if (e.target.classList.contains('cell-input')) return;
        openEditor(parseInt(cell.dataset.i, 10), parseInt(cell.dataset.j, 10));
      });
    });
  }

  // 输入事件高频触发，标签只记录一次（去抖窗口内）
  let pendingLabel = null;
  function scheduleRunWithLabel(label) {
    pendingLabel = label;
    scheduleRun();
  }
  // ---------- 单元格编辑弹层 ----------
  function openEditor(i, j) {
    activeCell = { i: i, j: j };
    const box = $('#cellEditor');
    box.hidden = false;
    const forbidden = model.forbidden[i][j];
    const lo = model.lower[i][j] || 0;
    const hiRaw = model.upper[i][j];
    const hi = (hiRaw == null || hiRaw === Infinity) ? '' : hiRaw;
    box.innerHTML =
      '<h4>编辑单元格：' + escapeHtml(model.rows[i].name) + ' × ' + escapeHtml(model.cols[j].name) + '</h4>' +
      '<div class="editor-note">业务禁用表示该组合在现实中不存在（结构零），求解变量中不包含此格，任何 ε 平滑都不会向它填入数值；' +
      '参考权重为 0 只是“先验上不倾向”，格子仍可被分配人数。</div>' +
      '<div class="editor-row">' +
        '<label>业务禁用（结构零）<select id="edForbidden"><option value="0">否（允许该格）</option><option value="1"' + (forbidden ? ' selected' : '') + '>是（恒为 0）</option></select></label>' +
        '<label>下限（含）<input type="number" id="edLower" value="' + lo + '" min="0" ' + (forbidden ? 'disabled' : '') + '></label>' +
        '<label>上限（留空 = 无上限）<input type="number" id="edUpper" value="' + hi + '" min="0" ' + (forbidden ? 'disabled' : '') + '></label>' +
      '</div>' +
      '<div class="editor-actions">' +
        '<button class="btn btn-primary btn-small" id="edApply" type="button">应用并重新检查</button>' +
        '<button class="btn btn-small" id="edClearBound" type="button">清除上下限</button>' +
        '<button class="btn btn-small" id="edClose" type="button">关闭</button>' +
      '</div>';

    $('#edApply').addEventListener('click', function () {
      const newForbidden = $('#edForbidden').value === '1';
      const newLo = Math.max(0, parseNum($('#edLower').value, 0));
      const hiVal = $('#edUpper').value.trim() === '' ? null : Math.max(0, parseNum($('#edUpper').value, 0));
      const parts = [];
      if (newForbidden !== forbidden) parts.push(newForbidden ? '设为业务禁用' : '取消业务禁用');
      model.forbidden[i][j] = newForbidden;
      if (!newForbidden) {
        model.lower[i][j] = newLo;
        model.upper[i][j] = hiVal;
        if (newLo !== lo) parts.push('下限→' + fmt(newLo));
        if ((hiVal == null) !== (hiRaw == null || hiRaw === Infinity) || (hiVal != null && Math.abs(hiVal - hiRaw) > 1e-10)) {
          parts.push('上限→' + (hiVal == null ? '∞' : fmt(hiVal)));
        }
      } else {
        model.lower[i][j] = 0;
        model.upper[i][j] = null;
      }
      activeCell = null;
      box.hidden = true;
      runPipeline('编辑 ' + model.rows[i].name + ' × ' + model.cols[j].name + '（' + (parts.length ? parts.join('，') : '无变化') + '）');
    });
    $('#edClearBound').addEventListener('click', function () {
      model.lower[i][j] = 0;
      model.upper[i][j] = null;
      activeCell = null;
      box.hidden = true;
      runPipeline('清除 ' + model.rows[i].name + ' × ' + model.cols[j].name + ' 的上下限');
    });
    $('#edClose').addEventListener('click', function () {
      activeCell = null;
      box.hidden = true;
      renderInputTable();
    });
    renderInputTable();
  }

  // ---------- 求解元信息 ----------
  function renderSolverMeta(s) {
    const el = $('#solverMeta');
    if (!s) {
      el.innerHTML = '<div class="stat"><div class="stat-label">状态</div><div class="stat-value err-bad">未求解（不可行）</div></div>';
      return;
    }
    if (!s.ok) {
      el.innerHTML = '<div class="stat"><div class="stat-label">状态</div><div class="stat-value err-bad">退化</div></div>' +
        '<div class="stat" style="grid-column:1/-1"><div class="stat-label">原因</div><div class="stat-value" style="font-size:13px">' + escapeHtml(s.message) + '</div></div>';
      return;
    }
    const stopCls = s.stopReason === 'converged' ? 'err-good' : 'err-bad';
    el.innerHTML =
      '<div class="stat"><div class="stat-label">迭代轮数</div><div class="stat-value">' + s.iterations + '</div></div>' +
      '<div class="stat"><div class="stat-label">最大绝对误差</div><div class="stat-value">' + s.maxAbsError.toExponential(2) + '</div></div>' +
      '<div class="stat"><div class="stat-label">KL 散度（对参考权重）</div><div class="stat-value">' + fmt(s.klDivergence, 2) + '</div></div>' +
      '<div class="stat"><div class="stat-label">零参考策略</div><div class="stat-value" style="font-size:13px">' +
        (s.zeroMode === 'epsilon' ? 'ε 平滑 (ε=' + s.epsilon + ')' : '硬零') + '</div></div>' +
      '<div class="stat" style="grid-column:1/-1"><div class="stat-label">停止原因</div>' +
        '<div class="stat-value ' + stopCls + '" style="font-size:12.5px">' + escapeHtml(s.stopReasonText) + '</div></div>';
  }

  // ---------- 结果表 ----------
  function renderResultTable(s) {
    const table = $('#resultTable');
    if (!s || !s.ok) {
      table.innerHTML = '<tbody><tr><td class="chart-empty">可行性检查未通过，暂无可展示的分配结果。请先处理上方诊断。</td></tr></tbody>';
      return;
    }
    const r = model.rows.length;
    const c = model.cols.length;
    let maxV = 1e-12;
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) maxV = Math.max(maxV, s.table[i][j]);

    const witnessRows = new Set(feasibility.witness ? feasibility.witness.rowIds : []);

    let html = '<thead><tr><th>地区 ＼ 方式</th>';
    model.cols.forEach(function (col) { html += '<th>' + escapeHtml(col.name) + '</th>'; });
    html += '<th>行边际（实际 / 目标）</th></tr></thead><tbody>';

    for (let i = 0; i < r; i++) {
      html += '<tr><th class="row-head">' + escapeHtml(model.rows[i].name) + (witnessRows.has(model.rows[i].id) ? ' <span class="tag tag-refzero">见证</span>' : '') + '</th>';
      for (let j = 0; j < c; j++) {
        const v = s.table[i][j];
        if (model.forbidden[i][j]) {
          html += '<td><div class="cell forbidden"><span class="forbidden-mark">禁用 · 0</span></div></td>';
          continue;
        }
        const t = v / maxV;
        const bg = heatColor(t);
        const textColor = heatTextColor(bg);
        let diffHtml = '';
        if (s.diff) {
          const d = s.diff[i][j];
          if (Math.abs(d) >= 5e-4) {
            diffHtml = '<div class="result-diff ' + (d > 0 ? 'up' : 'down') + '">' + fmtSigned(d) + '</div>';
          } else {
            diffHtml = '<div class="result-diff zero">±0</div>';
          }
        }
        const lo = model.lower[i][j] || 0;
        const hi = model.upper[i][j];
        const boundTag = (lo > 0 || (hi != null && hi !== Infinity))
          ? '<div class="cell-meta"><span class="mini-tag bnd">[' + fmt(lo) + (hi == null || hi === Infinity ? ',∞)' : ',' + fmt(hi) + ']') + '</span></div>'
          : '';
        html += '<td><div class="cell" style="background:' + bg + ';color:' + textColor + '">' +
          '<div class="result-value">' + fmt(v) + '</div>' +
          diffHtml + boundTag + '</div></td>';
      }
      const re = s.rowErrors[i];
      html += '<td class="marginal">' + fmt(re.got) + ' / ' + fmt(re.target) +
        '<div class="marginal-sub ' + (re.abs > 1e-6 ? 'err-bad' : 'err-good') + '">误差 ' + re.abs.toExponential(1) + '</div></td></tr>';
    }

    html += '<tr><th class="row-head">列边际（实际/目标）</th>';
    for (let j = 0; j < c; j++) {
      const ce = s.colErrors[j];
      html += '<td class="marginal">' + fmt(ce.got) + '<div class="marginal-sub">目标 ' + fmt(ce.target) +
        '</div><div class="marginal-sub ' + (ce.abs > 1e-6 ? 'err-bad' : 'err-good') + '">误差 ' + ce.abs.toExponential(1) + '</div></td>';
    }
    html += '<td class="marginal">合计 ' + fmt(feasibility.rowSum) + '</td></tr>';
    html += '</tbody>';
    table.innerHTML = html;
  }

  // ---------- 误差表 ----------
  function renderErrorTable(s) {
    const table = $('#errorTable');
    if (!s || !s.ok) {
      table.innerHTML = '<tbody><tr><td class="chart-empty">无结果。</td></tr></tbody>';
      return;
    }
    let html = '<thead><tr><th>边际</th><th>名称</th><th>目标</th><th>实际</th><th>绝对误差</th><th>相对误差</th></tr></thead><tbody>';
    s.rowErrors.forEach(function (e, i) {
      const cls = e.abs <= 1e-6 ? 'err-good' : 'err-bad';
      html += '<tr><td>行</td><th class="row-head" style="position:static">' + escapeHtml(model.rows[i].name) + '</th>' +
        '<td>' + fmt(e.target) + '</td><td>' + fmt(e.got) + '</td>' +
        '<td class="' + cls + '">' + e.abs.toExponential(2) + '</td>' +
        '<td class="' + cls + '">' + fmtRel(e.rel) + '</td></tr>';
    });
    s.colErrors.forEach(function (e, j) {
      const cls = e.abs <= 1e-6 ? 'err-good' : 'err-bad';
      html += '<tr><td>列</td><th class="row-head" style="position:static">' + escapeHtml(model.cols[j].name) + '</th>' +
        '<td>' + fmt(e.target) + '</td><td>' + fmt(e.got) + '</td>' +
        '<td class="' + cls + '">' + e.abs.toExponential(2) + '</td>' +
        '<td class="' + cls + '">' + fmtRel(e.rel) + '</td></tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  // ---------- 误差曲线（内联 SVG） ----------
  function renderChart(s) {
    const wrap = $('#chartWrap');
    if (!s || !s.ok || !s.history || s.history.length < 2) {
      wrap.innerHTML = '<div class="chart-empty">无迭代历史。</div>';
      return;
    }
    const W = 640;
    const H = 240;
    const pad = { l: 56, r: 16, t: 14, b: 34 };
    const h = s.history;
    const xs = h.map(function (d) { return d.iter; });
    const ys = h.map(function (d) { return Math.max(d.maxAbs, 1e-16); });
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const yMin = Math.min.apply(null, ys);
    const yMax = Math.max.apply(null, ys);
    const lyMin = Math.log10(yMin);
    const lyMax = Math.log10(yMax);
    const X = function (x) { return pad.l + (x - xMin) / Math.max(1, xMax - xMin) * (W - pad.l - pad.r); };
    const Y = function (y) {
      const ly = Math.log10(Math.max(y, 1e-16));
      return pad.t + (1 - (ly - lyMin) / Math.max(1e-9, lyMax - lyMin)) * (H - pad.t - pad.b);
    };
    const path = h.map(function (d, k) { return (k === 0 ? 'M' : 'L') + X(d.iter).toFixed(1) + ' ' + Y(d.maxAbs).toFixed(1); }).join(' ');

    // y 轴刻度（取整齐的 10 的幂）
    let ticks = [];
    const low = Math.floor(lyMin);
    const high = Math.ceil(lyMax);
    for (let p = low; p <= high; p++) ticks.push(Math.pow(10, p));
    ticks = ticks.filter(function (v) { return v >= yMin && v <= yMax; }).slice(0, 6);

    let gridHtml = '';
    ticks.forEach(function (v) {
      const y = Y(v);
      gridHtml += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) + '" y2="' + y + '" stroke="var(--gridline)" stroke-width="1"/>' +
        '<text x="' + (pad.l - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10.5" fill="var(--text-muted)">' + v.toExponential(0) + '</text>';
    });
    const xTickCount = Math.min(5, h.length);
    for (let k = 0; k < xTickCount; k++) {
      const idx = Math.round(k * (h.length - 1) / Math.max(1, xTickCount - 1));
      const x = X(h[idx].iter);
      gridHtml += '<text x="' + x + '" y="' + (H - 12) + '" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">' + h[idx].iter + '</text>';
    }

    wrap.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="迭代最大绝对误差曲线（对数刻度）">' +
      gridHtml +
      '<line x1="' + pad.l + '" y1="' + (H - pad.b) + '" x2="' + (W - pad.r) + '" y2="' + (H - pad.b) + '" stroke="var(--gridline)" stroke-width="1.5"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
      '<text x="' + (W / 2) + '" y="' + (H - 0) + '" text-anchor="middle" font-size="11" fill="var(--text-secondary)">迭代轮数</text>' +
      '<text transform="translate(14,' + (H / 2) + ') rotate(-90)" text-anchor="middle" font-size="11" fill="var(--text-secondary)">最大绝对误差（对数）</text>' +
      '<rect id="chartHover" x="' + pad.l + '" y="' + pad.t + '" width="' + (W - pad.l - pad.r) + '" height="' + (H - pad.t - pad.b) + '" fill="transparent"/>' +
      '</svg><div class="chart-tooltip" id="chartTooltip"></div>';

    const svg = wrap.querySelector('svg');
    const tip = wrap.querySelector('#chartTooltip');
    svg.addEventListener('mousemove', function (e) {
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width * W;
      const frac = (mx - pad.l) / (W - pad.l - pad.r);
      const idx = Math.max(0, Math.min(h.length - 1, Math.round(frac * (h.length - 1))));
      const d = h[idx];
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top = (e.clientY + 12) + 'px';
      tip.innerHTML = '第 ' + d.iter + ' 轮<br>最大绝对误差: ' + d.maxAbs.toExponential(3) +
        '<br>最大相对误差: ' + fmtRel(d.maxRel) + '<br>KL: ' + fmt(d.kl, 2);
    });
    svg.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }

  // ---------- 参考零格诊断 ----------
  function renderRefZeroNotes(s) {
    const el = $('#refZeroNotes');
    if (!s || !s.ok) { el.innerHTML = ''; return; }
    if (!s.refZeroFilled.length) {
      el.innerHTML = '<p class="muted" style="font-size:12.5px;margin:6px 0 0">所有正分配都落在参考权重为正的格子上；业务禁用格保持为 0。</p>';
      return;
    }
    el.innerHTML = s.refZeroFilled.map(function (z) {
      return '<div class="refzero-item">参考零格 <b>' + escapeHtml(z.rowName) + ' × ' + escapeHtml(z.colName) +
        '</b> 在 ε 平滑（ε=' + s.epsilon + '）下被分配 <b>' + fmt(z.value) + '</b> 人。' +
        '它不是业务禁用格；若要求其精确为 0，请把零参考策略切换为“硬零”。</div>';
    }).join('');
  }

  // ---------- 编辑记录 ----------
  function addLog(label, s) {
    let topChanges = [];
    if (s && s.diff) {
      const changes = [];
      for (let i = 0; i < model.rows.length; i++) {
        for (let j = 0; j < model.cols.length; j++) {
          if (Math.abs(s.diff[i][j]) >= 5e-4) {
            changes.push({ name: model.rows[i].name + '×' + model.cols[j].name, d: s.diff[i][j] });
          }
        }
      }
      changes.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
      topChanges = changes.slice(0, 4);
    }
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    editLogs.unshift({ time: time, label: label, feasible: feasibility.feasible, changes: topChanges });
    renderLogs();
  }

  function renderLogs() {
    const el = $('#editLog');
    if (!editLogs.length) return;
    el.innerHTML = editLogs.map(function (log) {
      let body;
      if (!log.feasible) {
        body = '<span class="err-bad">设置不可行，未产生新分配</span>';
      } else if (!log.changes.length) {
        body = '<span class="muted">分配结果无显著变化</span>';
      } else {
        body = log.changes.map(function (c) {
          return escapeHtml(c.name) + ' <span class="' + (c.d > 0 ? 'log-diff-up' : 'log-diff-down') + '">' + fmtSigned(c.d) + '</span>';
        }).join('；');
      }
      return '<div class="log-entry"><div class="log-time">' + log.time + '</div><div><b>' + escapeHtml(log.label) + '</b><div style="margin-top:2px">' + body + '</div></div></div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
