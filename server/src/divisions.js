/**
 * 专业（室）相关常量与工具
 *
 * 维度命名：原"专业室"（如 建筑室）统一改为"专业"（如 建筑）。
 * 部分科室（综管室 / 综能室 / 节能室）人员暂不出现在程序中，其专业从
 *   筛选 / 收件人候选等用户可见列表中排除。
 *
 * ⚠️ 院级差异外置：专业/科室的「值」随院不同（科室划分不同），但字段名统一。
 *   下列常量统一从 institute.config.js（见 institute.js 加载器）读取，缺失时回退默认。
 */

const institute = require('./institute');

// 不出现在程序中的专业（规范化后的名称：去"室"）
const HIDDEN_DIVISIONS = (institute.divisions && institute.divisions.hidden) || ['综管', '综能', '节能'];

// 仅在「前端展示 / 筛选条 / 选专业下拉」中隐藏的专业名称（不影响人员实际纳入
//   应阅池、PDCA 问题池、提醒等成员逻辑）。2026-10-13 用户裁定：咨询为跨专业
//   聚合维度、非单一面向专业，从所有专业筛选条与选专业下拉中移除，但咨询人员
//   仍须保留在应阅 / PDCA / 提醒等真实成员口径内（故单列，不并入 HIDDEN_DIVISIONS）。
const DISPLAY_HIDDEN_DIVISIONS = (institute.divisions && institute.divisions.displayHidden) || ['咨询'];

// 二级专业映射：一级专业 → 其下设的二级分类
// 用户约定（2026-07-23 起）：暖通→空调/通风/采暖/环保；水工→给排水/化水水工；
//   通信→系统通信/网络信息；建筑→民用建筑/变电站建筑。
const DIVISION_SUBS = (institute.divisions && institute.divisions.subs) || {
  '暖通': ['空调', '通风', '采暖', '环保'],
  '水工': ['给排水', '化水水工'],
  '通信': ['系统通信', '网络信息'],
  '建筑': ['民用建筑', '变电站建筑'],
};

// 专业室 → 专业：去掉末尾的"室"
function normalizeDivision(div) {
  if (!div) return div;
  return String(div).replace(/室$/, '');
}

// 取用户可见的专业列表（去"室" + 排除 HIDDEN + 排除仅展示隐藏项）
function visibleDivisions(list) {
  const out = [];
  for (const d of list || []) {
    const n = normalizeDivision(d);
    if (n && !HIDDEN_DIVISIONS.includes(n) && !DISPLAY_HIDDEN_DIVISIONS.includes(n)) out.push(n);
  }
  return [...new Set(out)];
}

// 某一级专业下的二级分类列表（无则返回空数组）
function subsOf(major) {
  return DIVISION_SUBS[major] || [];
}

// 由 一级 + 二级 拼成复合键（"暖通/空调"）；缺二级则退化为一级名
function subKey(major, sub) {
  return sub ? `${major}/${sub}` : (major || '');
}

// 拆分复合键 "暖通/空调" → { major:'暖通', sub:'空调' }
function splitSubKey(key) {
  if (!key) return { major: '', sub: '' };
  const i = String(key).indexOf('/');
  if (i === -1) return { major: key, sub: '' };
  return { major: key.slice(0, i), sub: key.slice(i + 1) };
}

// 展示排序（2026-09-25 调整）：
//   - 头部优先专业：建筑 置于第一位；
//   - 其余（含通用、各拼音升序专业）居中按拼音升序；
//   - 尾部沉底专业（按此顺序）：电气 → 建筑电气 → 绿建低碳（绿建低碳排在建筑电气之后）。
//   保持各筛选框 / 选择框顺序一致。
const HEAD_DIVISIONS = (institute.divisions && institute.divisions.head) || ['建筑'];
const TAIL_DIVISIONS = (institute.divisions && institute.divisions.tail) || ['电气', '建筑电气', '绿建低碳'];
function orderDivisions(list) {
  const arr = visibleDivisions(list);
  const head = HEAD_DIVISIONS.filter(d => arr.includes(d));
  const mid = arr.filter(d => !HEAD_DIVISIONS.includes(d) && !TAIL_DIVISIONS.includes(d)).sort();
  const tail = TAIL_DIVISIONS.filter(d => arr.includes(d));
  return head.concat(mid, tail);
}

module.exports = { HIDDEN_DIVISIONS, DISPLAY_HIDDEN_DIVISIONS, DIVISION_SUBS, normalizeDivision, visibleDivisions, subsOf, subKey, splitSubKey, orderDivisions };
