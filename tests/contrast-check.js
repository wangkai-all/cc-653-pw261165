'use strict';

/* 热力单元格文字对比度自检（WCAG 对比度近似）。
   app.js 依据相对亮度自动切换深/浅文字，这里验证每个色阶下的选择都达标。 */

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function luminance(hex) {
  const rgb = hexToRgb(hex).map(function (c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ramps = {
  light: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'],
  dark: ['#103055', '#15406f', '#1c5cab', '#2a78d6', '#3987e5', '#86b6ef']
};
const ink = { light: { dark: '#0b0b0b', light: '#ffffff' }, dark: { dark: '#0b0b0b', light: '#ffffff' } };
// 与 app.js heatTextColor 相同的规则：亮模式 L<0.27 用白字；暗模式 L>0.4 用深字
function pickInk(mode, lum) {
  if (mode === 'dark') return lum > 0.4 ? ink.dark.dark : ink.dark.light;
  return lum < 0.27 ? ink.light.light : ink.light.dark;
}

let failures = 0;
for (const mode of ['light', 'dark']) {
  console.log('== ' + mode + ' 模式色阶 ==');
  ramps[mode].forEach(function (hex) {
    const lum = luminance(hex);
    const chosen = pickInk(mode, lum);
    const ratio = contrast(hex, chosen);
    const ok = ratio >= 3; // 大号/加粗数字的 WCAG AA 阈值
    if (!ok) failures++;
    console.log('  ' + hex + ' L=' + lum.toFixed(3) + ' 文字=' + chosen + ' 对比度=' + ratio.toFixed(2) + ' ' + (ok ? '✓' : '✗'));
  });
}

// 状态色在对应表面上的对比度（图标+文字配对，仅记录不设硬失败）
const surfaces = { light: '#fcfcfb', dark: '#1a1a19' };
const status = { good: '#0ca30c', critical: '#d03b3b' };
console.log('== 状态色 / 表面对比度（参考）==');
for (const mode of ['light', 'dark']) {
  for (const name of Object.keys(status)) {
    console.log('  ' + mode + ' ' + name + ' ' + contrast(status[name], surfaces[mode]).toFixed(2));
  }
}

if (failures) {
  console.error('\n' + failures + ' 个热力色阶文字对比度不足 3:1');
  process.exit(1);
}
console.log('\n热力文字对比度全部达标。');
