'use strict';

/*
 * presets.js — 内置示例数据
 * 每个 preset 是一份完整模型；网页里可在其基础上任意编辑。
 * 参考权重只表示相对倾向，无需与边际同量纲。
 */

function zeros(r, c, val) {
  // 注意：显式传入 null 时保留 null（表示无上限），仅缺省参数时填 0
  const fill = arguments.length < 3 ? 0 : val;
  return Array.from({ length: r }, function () {
    return new Array(c).fill(fill);
  });
}

const PRESETS = [
  {
    id: 'basic',
    name: '① 基础示例（3×3，可手工核对）',
    description: '城区/近郊/远郊 × 地铁/公交/私家车，共 200 人。远郊没有地铁（业务禁用，恒为 0）。参考权重为整数比，可用纸笔算出行缩放后的比例。',
    rows: [
      { id: 'r1', name: '城区', total: 100 },
      { id: 'r2', name: '近郊', total: 60 },
      { id: 'r3', name: '远郊', total: 40 }
    ],
    cols: [
      { id: 'c1', name: '地铁', total: 110 },
      { id: 'c2', name: '公交', total: 60 },
      { id: 'c3', name: '私家车', total: 30 }
    ],
    forbidden: [
      [false, false, false],
      [false, false, false],
      [true, false, false]
    ],
    reference: [
      [5, 3, 2],
      [3, 4, 1],
      [0, 2, 3]
    ],
    lower: zeros(3, 3, 0),
    upper: zeros(3, 3, null),
    zeroMode: 'epsilon',
    epsilon: 0.001
  },
  {
    id: 'local-infeasible',
    name: '② 总量一致但局部不可行',
    description: '行、列合计都是 200，但甲地区被禁用了 B、C 两种方式，只能进入 A（容量 90），而甲有 100 人——缺口 10 人。可行性诊断应指出这一组地区及其容量缺口，而不是等迭代失败。',
    rows: [
      { id: 'r1', name: '甲地区', total: 100 },
      { id: 'r2', name: '乙地区', total: 60 },
      { id: 'r3', name: '丙地区', total: 40 }
    ],
    cols: [
      { id: 'c1', name: '方式A', total: 90 },
      { id: 'c2', name: '方式B', total: 70 },
      { id: 'c3', name: '方式C', total: 40 }
    ],
    forbidden: [
      [false, true, true],
      [false, false, false],
      [false, false, false]
    ],
    reference: [
      [5, 1, 1],
      [3, 4, 2],
      [2, 2, 3]
    ],
    lower: zeros(3, 3, 0),
    upper: zeros(3, 3, null),
    zeroMode: 'epsilon',
    epsilon: 0.001
  },
  {
    id: 'upper-squeeze',
    name: '③ 单元格上限挤占（在①上施加）',
    description: '在基础示例上把「城区×地铁」限制为最多 55 人（无约束解约 73.65 人，故上限生效；注意该上限若低于 50 则整体不可行——地铁列 110 人只能由另外两行供给 60 人）。方案仍可行，但原本流向该格的人数被迫挤进同行其他格与其他行，可观察每个格子的增减差值与边际误差变化。',
    rows: [
      { id: 'r1', name: '城区', total: 100 },
      { id: 'r2', name: '近郊', total: 60 },
      { id: 'r3', name: '远郊', total: 40 }
    ],
    cols: [
      { id: 'c1', name: '地铁', total: 110 },
      { id: 'c2', name: '公交', total: 60 },
      { id: 'c3', name: '私家车', total: 30 }
    ],
    forbidden: [
      [false, false, false],
      [false, false, false],
      [true, false, false]
    ],
    reference: [
      [5, 3, 2],
      [3, 4, 1],
      [0, 2, 3]
    ],
    lower: zeros(3, 3, 0),
    upper: [
      [55, null, null],
      [null, null, null],
      [null, null, null]
    ],
    zeroMode: 'epsilon',
    epsilon: 0.001
  },
  {
    id: 'lower-conflict',
    name: '④ 下限冲突（不可行）',
    description: '在基础示例上要求「远郊×公交」至少 45 人，但远郊总共只有 40 人。静态检查即可发现行下限合计超过行总量；把它改回 ≤40 后可恢复可行。',
    rows: [
      { id: 'r1', name: '城区', total: 100 },
      { id: 'r2', name: '近郊', total: 60 },
      { id: 'r3', name: '远郊', total: 40 }
    ],
    cols: [
      { id: 'c1', name: '地铁', total: 110 },
      { id: 'c2', name: '公交', total: 60 },
      { id: 'c3', name: '私家车', total: 30 }
    ],
    forbidden: [
      [false, false, false],
      [false, false, false],
      [true, false, false]
    ],
    reference: [
      [5, 3, 2],
      [3, 4, 1],
      [0, 2, 3]
    ],
    lower: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 45, 0]
    ],
    upper: zeros(3, 3, null),
    zeroMode: 'epsilon',
    epsilon: 0.001
  },
  {
    id: 'ref-zero',
    name: '⑤ 参考零 ≠ 业务禁用',
    description: '3×2 结构：南区没有轨交（业务禁用，永远为 0）；东地区×步行在参考分布里权重为 0，但该格允许存在。选择 ε 平滑时，步行列的富余会按 ε 的大小分给它一点；选择硬零时它精确保持 0，东地区 70 人全部压向轨交，与轨交列 60 的总量冲突，迭代停滞——可对比两种策略的停止原因。',
    rows: [
      { id: 'r1', name: '东地区', total: 70 },
      { id: 'r2', name: '西地区', total: 30 },
      { id: 'r3', name: '南区', total: 20 }
    ],
    cols: [
      { id: 'c1', name: '轨交', total: 60 },
      { id: 'c2', name: '步行', total: 60 }
    ],
    forbidden: [
      [false, false],
      [false, false],
      [true, false]
    ],
    reference: [
      [4, 0],
      [2, 3],
      [0, 1]
    ],
    lower: zeros(3, 2, 0),
    upper: zeros(3, 2, null),
    zeroMode: 'epsilon',
    epsilon: 0.05
  }
];

// 深拷贝，避免编辑示例时污染原始定义
function clonePreset(p) {
  return JSON.parse(JSON.stringify(p));
}

const api = { PRESETS: PRESETS, clonePreset: clonePreset, zeros: zeros };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.XTabPresets = Object.assign(window.XTabPresets || {}, api);
