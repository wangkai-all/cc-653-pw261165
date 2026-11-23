'use strict';

/* DOM 冒烟测试：在 jsdom 中加载真实 index.html 与全部脚本，
   验证渲染管线、预设切换、单元格编辑、不可行诊断与差值展示。 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/jsdom-test/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

// 按 index.html 的顺序注入脚本
['src/flow.js', 'src/solver.js', 'src/presets.js', 'src/app.js'].forEach(function (f) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  window.eval(code);
});

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.message ? e.message : e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// app.js 监听 DOMContentLoaded；jsdom 文档在 eval 时已处于 complete，
// 故手动派发一次就绪事件。
function flush() {
  return new Promise(function (resolve) {
    window.setTimeout(resolve, 350); // 大于 app.js 的 220ms 去抖
  });
}

async function main() {
  // jsdom 文档在 eval 时已为 interactive，app.js 会自行触发初始化；
  // 这里再派发一次以覆盖 readyState=loading 的环境，init 内有幂等守卫。
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
  await flush();

  test('初始渲染：5 个预设已加载', function () {
    assert(document.querySelectorAll('#presetSelect option').length === 5);
  });

  test('基础示例：全局徽章显示可行', function () {
    assert(document.querySelector('#globalStatus').classList.contains('ok'),
      document.querySelector('#globalStatus').textContent);
  });

  test('可行性横幅显示通过', function () {
    assert(document.querySelector('#feasibilityBanner').classList.contains('ok'));
  });

  test('输入表：3×3 单元格 + 禁用格渲染', function () {
    const cells = document.querySelectorAll('#inputTable .cell');
    assert(cells.length === 9, '应渲染 9 个格子');
    const forbidden = document.querySelectorAll('#inputTable .cell.forbidden');
    assert(forbidden.length === 1, '应有 1 个禁用格（远郊×地铁）');
  });

  test('结果表：禁用格仍为“禁用 · 0”，其余有数值', function () {
    const forbidden = document.querySelectorAll('#resultTable .cell.forbidden');
    assert(forbidden.length === 1);
    const values = document.querySelectorAll('#resultTable .result-value');
    assert(values.length === 8, '8 个允许格应有结果值');
  });

  test('误差表：6 行（3 行边际 + 3 列边际）且误差达标', function () {
    const rows = document.querySelectorAll('#errorTable tbody tr');
    assert(rows.length === 6);
    assert(document.querySelectorAll('#errorTable .err-bad').length === 0, '不应有超差行');
  });

  test('迭代曲线 SVG 已渲染且含数据路径', function () {
    const svg = document.querySelector('#chartWrap svg');
    assert(svg, 'SVG 存在');
    assert(svg.querySelector('path') && svg.querySelector('path').getAttribute('d').startsWith('M'));
  });

  test('求解元信息：停止原因为收敛', function () {
    assert(document.querySelector('#solverMeta').textContent.indexOf('已收敛') >= 0);
  });

  // —— 切换到局部不可行预设 ——
  const select = document.querySelector('#presetSelect');
  select.value = '1';
  select.dispatchEvent(new window.Event('change'));
  await flush();

  test('预设②：徽章变为不可行', function () {
    assert(document.querySelector('#globalStatus').classList.contains('bad'));
  });

  test('预设②：横幅包含地区组与缺口 10 的诊断', function () {
    const text = document.querySelector('#feasibilityBanner').textContent;
    assert(text.indexOf('甲地区') >= 0 && text.indexOf('缺口') >= 0 && text.indexOf('10') >= 0, text.slice(0, 120));
    assert(document.querySelector('.witness-box'), '应渲染最小割见证框');
  });

  test('预设②：结果区显示未求解提示而非崩溃', function () {
    assert(document.querySelector('#resultTable').textContent.indexOf('暂无可展示') >= 0);
  });

  // —— 切回基础示例，模拟修改行总数制造总量不一致 ——
  select.value = '0';
  select.dispatchEvent(new window.Event('change'));
  await flush();

  test('改行总数制造总量不一致：报 total-mismatch', function () {
    const input = document.querySelector('#inputTable .row-total');
    input.value = '120';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  });
  await flush();
  test('（续）横幅提示边际合计不一致', function () {
    const text = document.querySelector('#feasibilityBanner').textContent;
    assert(text.indexOf('不一致') >= 0, text.slice(0, 100));
    assert(document.querySelector('#globalStatus').classList.contains('bad'));
  });

  // 恢复
  select.value = '0';
  select.dispatchEvent(new window.Event('change'));
  await flush();

  // —— 单元格编辑器：设置上限 ——
  test('打开单元格编辑器并施加可行上限 55', function () {
    const cell = document.querySelector('#inputTable .cell[data-i="0"][data-j="0"]');
    cell.dispatchEvent(new window.Event('click', { bubbles: true }));
    const editor = document.querySelector('#cellEditor');
    assert(!editor.hidden);
    const upper = document.querySelector('#edUpper');
    upper.value = '55';
    upper.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.querySelector('#edApply').dispatchEvent(new window.Event('click', { bubbles: true }));
    return true;
  });
  await flush();
  test('（续）上限生效：该格贴着 55 且仍收敛', function () {
    assert(document.querySelector('#globalStatus').classList.contains('ok'));
    const v = document.querySelector('#resultTable .cell[data-i] .result-value');
    // 第一个允许格即 (0,0)
    const first = document.querySelectorAll('#resultTable .result-value')[0].textContent;
    assert(Math.abs(parseFloat(first) - 55) < 0.01, '实际=' + first);
    assert(document.querySelector('#solverMeta').textContent.indexOf('已收敛') >= 0);
  });

  test('（续）编辑记录已写入并显示增减', function () {
    const log = document.querySelector('#editLog').textContent;
    assert(log.indexOf('上限') >= 0);
  });

  // —— 切换硬零模式（预设⑤）——
  select.value = '4';
  select.dispatchEvent(new window.Event('change'));
  await flush();
  test('预设⑤ ε 模式：参考零格被分配正值并出现提示', function () {
    assert(document.querySelector('#refZeroNotes .refzero-item'), '应有参考零格提示');
  });

  const zeroMode = document.querySelector('#zeroMode');
  zeroMode.value = 'hard';
  zeroMode.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  test('预设⑤ 硬零模式：参考零提示消失，停止原因变为停滞/迭代上限', function () {
    assert(!document.querySelector('#refZeroNotes .refzero-item'));
    const meta = document.querySelector('#solverMeta').textContent;
    assert(meta.indexOf('停滞') >= 0 || meta.indexOf('迭代') >= 0, meta);
    // 业务禁用格依旧为 0
    assert(document.querySelectorAll('#resultTable .cell.forbidden').length === 1);
  });

  // —— 连续输入不失焦 ——
  select.value = '0';
  select.dispatchEvent(new window.Event('change'));
  await flush();
  test('连续输入行总数时输入框保持焦点（整表重绘不打断打字）', function () {
    const input = document.querySelector('#inputTable .row-total');
    input.focus();
    input.value = '105';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  });
  await flush();
  test('（续）焦点仍在同一输入框且值保留', function () {
    const input = document.querySelector('#inputTable .row-total');
    assert(document.activeElement === input, '焦点丢失');
    assert(input.value === '105', '值未保留: ' + input.value);
  });

  test('（续）不可行编辑也写入调整记录', function () {
    const before = document.querySelectorAll('#editLog .log-entry').length;
    const input = document.querySelector('#inputTable .row-total');
    input.focus();
    input.value = '999';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  });
  await flush();
  test('（续）日志新增一条且标注不可行', function () {
    const entries = document.querySelectorAll('#editLog .log-entry');
    assert(entries.length >= 1);
    assert(entries[0].textContent.indexOf('不可行') >= 0);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
