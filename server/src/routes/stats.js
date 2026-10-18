/**
 * 统计接口
 *
 *   GET /api/stats/home           首页公告 / 质量宣贯 的「本月 / 共」计数
 *   GET /api/stats/monthly        按月质量工作汇总（JSON）：平台公告 / 质量宣贯 / 质量人人讲
 *                                 三类内容分类型给出条项、数量、分专业统计
 *   GET /api/stats/monthly-export 同上数据的 Word 兼容 .doc 简报下载（零依赖）
 */
const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

// ── 工具 ──────────────────────────────────────────
function safeJson(v, def = []) {
  if (v == null) return def;
  if (Array.isArray(v)) return v;
  try { const j = JSON.parse(v); return Array.isArray(j) ? j : def; } catch (e) { return def; }
}
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function stripHtml(s) {
  if (s == null) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function truncate(s, n = 200) {
  const t = stripHtml(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
// 取当前月 YYYY-MM（服务器本地=中国时区）
function curMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}
function normMonth(m) {
  if (/^\d{4}-\d{2}$/.test(m || '')) return m;
  return curMonth();
}
function parseMonthParam(v) {
  return (/^\d{4}-\d{2}$/.test((v || '').trim())) ? v.trim() : null;
}
// 统计分布：把多条记录的「专业标签数组」聚合成 [{name,count}] 降序
function breakdown(rows, pickTags) {
  const map = new Map();
  for (const r of rows) {
    const tags = pickTags(r);
    const list = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    for (const t of list) {
      const name = (t && String(t).trim()) || '未指定专业';
      map.set(name, (map.get(name) || 0) + 1);
    }
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
// 人人讲（PDCA）专业取数：优先用多专业数组 divisions，旧数据无数组时回退单值 division
function pickDivs(r) {
  const arr = safeJson(r.divisions);
  if (arr.length) return arr;
  const d = (r.division && String(r.division).trim()) || '';
  return d ? [d] : [];
}
function pickSubs(r) {
  const arr = safeJson(r.sub_divisions);
  if (arr.length) return arr;
  const s = (r.sub_division && String(r.sub_division).trim()) || '';
  return s ? [s] : [];
}

// ── 本月 / 总计数（首页用）────────────────────────
// where：各表「有效内容」的过滤条件。
//   公告 announcements：软删（#542.3，status='deleted'）+ 排除软删。
//                       ⚠️ 2026-09-15 修正（超级管理员）：原 SQL 还排除了 archived，导致首页「共 N」比
//                       质量库里的公告条数少 —— 而「质量宣贯」的「共 N」= 质量库宣贯条数（23=23）。
//                       口径已统一为「排除软删、含到期归档（归档公告仍沉淀在质量库）」，
//                       与 /api/quality-dissem/library?source=announcement 完全一致。
//   宣贯 quality_dissem：软删，排除 软删(deleted) / 驳回(rejected) / 待审(pending) 的行，
//                        放出(active)与到期归档(archived，沉淀质量库)的内容均计入 —— 删除条目同步减去数量。
// timeExpr：判定「本月」所依据的时间列。默认 created_at；
//   宣贯须传 COALESCE(reviewed_at, created_at) —— 与质量库 / 简报统一为「最后一环批准时刻」（2026-09-23）。
//   ⚠️ 该参数只接受本文件内的字面量，绝不拼接外部输入。
function countRow(table, where = '', timeExpr = 'created_at') {
  return db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN strftime('%Y-%m', ${timeExpr}, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN 1 ELSE 0 END) month
    FROM ${table}
    ${where}
  `).get();
}
router.get('/home', (req, res) => {
  // 公告：排除软删即计（含 archived）——与质量库公告口径一致（2026-09-15 修正）
  const ann = countRow('announcements', "WHERE COALESCE(status,'active') != 'deleted'");
  // 宣贯：软删/驳回/待审不计；「本月」按「最后一环批准时刻」计（2026-09-23 与质量库/简报统一）——
  //   设计师发的取 reviewed_at（审核通过），专总/室主任/院长直发的本列为 NULL → 兜底 created_at（发布即生效）。
  const dissem = countRow('quality_dissem', "WHERE status NOT IN ('deleted','rejected','pending')", 'COALESCE(reviewed_at, created_at)');
  // 质量人人讲（院选）：已闭环且被专总/院长精选；「本月」按闭环月(closed_at)计，与月度简报口径一致
  const rrj = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN strftime('%Y-%m', closed_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN 1 ELSE 0 END) month
    FROM pdca_problems
    WHERE status = 'closed' AND rrj_selected = 1
  `).get();
  res.json({
    announcements: { total: ann.total || 0, month: ann.month || 0 },
    dissem: { total: dissem.total || 0, month: dissem.month || 0 },
    rrj: { total: rrj.total || 0, month: rrj.month || 0 },
  });
});

// ── 按月 / 区间累加 / 全年 汇总（JSON）────────────
// 统计区间优先级：year（全年）> from+to（区间累加）> month（单月）> 当前月
function resolveRange(query = {}) {
  const year = (query.year != null) ? String(query.year).trim() : '';
  const fromP = parseMonthParam(query.from);
  const toP = parseMonthParam(query.to);
  const monthP = parseMonthParam(query.month);

  if (/^\d{4}$/.test(year)) {
    return { from: year + '-01', to: year + '-12', mode: 'year', label: year + ' 年全年' };
  }
  if (fromP && toP) {
    let a = fromP, b = toP;
    if (a > b) { const t = a; a = b; b = t; } // 自动校正方向
    const [fy, fm] = a.split('-'); const [ty, tm] = b.split('-');
    const label = (fy === ty)
      ? `${fy} 年 ${parseInt(fm, 10)}–${parseInt(tm, 10)} 月（累计）`
      : `${a} – ${b}（累计）`;
    return { from: a, to: b, mode: 'range', label };
  }
  const m = monthP || curMonth();
  const [yy, mm] = m.split('-');
  return { from: m, to: m, mode: 'month', label: `${yy} 年 ${parseInt(mm, 10)} 月` };
}

function buildMonthly(query = {}) {
  const range = resolveRange(query);
  const { from, to } = range;

  // 1) 平台公告（按创建月在区间内）
  // ⚠️ 2026-09-13 修订：简报数量 = 所选期间「已发布过」的全部条数，不受公示期影响。
  //    公示期到期的内容在库中置为 status='archived'（主页消失、沉淀质量库），但简报须照常计入，
  //    故此处只排除软删(deleted)，包含 active 与 archived 两种状态。
  const annRows = db.prepare(`
    SELECT id, title, content, publisher, created_at
    FROM announcements
    WHERE strftime('%Y-%m', created_at, '+8 hours') >= ? AND strftime('%Y-%m', created_at, '+8 hours') <= ?
      AND COALESCE(status,'active') NOT IN ('deleted')
    ORDER BY created_at DESC
  `).all(from, to);
  const announcements = {
    total: annRows.length,
    divisionBreakdown: breakdown(annRows, r => (r.division && String(r.division).trim()) || '全院（未指定专业）'),
    items: annRows.map(r => ({
      id: r.id,
      title: r.title,
      publisher: r.publisher || '',
      date: (r.created_at || '').slice(0, 10),
      content: truncate(r.content, 240),
    })),
  };

  // 2) 质量宣贯（按「最后一环批准月」在区间内）
  //    2026-09-23 用户裁定：全站时间口径统一为「最后一环批准时刻」。
  //      设计师发布 → reviewed_at（审核通过/放出时刻）；专总/室主任/院长直发（免审）→ 本列为 NULL，兜底 created_at（发布即生效）。
  //    期间边界与展示日期同源，否则会出现「按 9 月出的简报里含一条显示 8 月的条目」。
  const dissemRows = db.prepare(`
    SELECT id, title, publisher, category, divisions, sub_divisions, publish_date, created_at, reviewed_at
    FROM quality_dissem
    WHERE strftime('%Y-%m', COALESCE(reviewed_at, created_at), '+8 hours') >= ? AND strftime('%Y-%m', COALESCE(reviewed_at, created_at), '+8 hours') <= ?
      AND status NOT IN ('deleted','rejected','pending')
    ORDER BY COALESCE(reviewed_at, created_at) DESC
  `).all(from, to);
  const dissem = {
    total: dissemRows.length,
    divisionBreakdown: breakdown(dissemRows, r => safeJson(r.divisions)),
    subDivisionBreakdown: breakdown(dissemRows, r => safeJson(r.sub_divisions)),
    items: dissemRows.map(r => ({
      id: r.id,
      title: r.title,
      publisher: r.publisher || '',
      category: r.category || '通用',
      divisions: safeJson(r.divisions).join('、') || '全院',
      subDivisions: safeJson(r.sub_divisions).join('、') || '—',
      // 展示日期 = 排序日期 = 期间归月依据，三者同源（2026-09-23）。
      //   原取 publish_date（公示起算日，作者手填、可能晚于实际放出日），现取批准时刻。
      publishDate: (r.reviewed_at || r.created_at || '').slice(0, 10),
    })),
  };

  // 3) 质量人人讲（院选：已闭环 + 被专总/院长精选，按闭环月在区间内）
  const rrjRows = db.prepare(`
    SELECT id, title, reporter, division, divisions, sub_division, sub_divisions, rrj_selected_by, closed_at, created_at
    FROM pdca_problems
    WHERE status = 'closed' AND rrj_selected = 1 AND strftime('%Y-%m', closed_at, '+8 hours') >= ? AND strftime('%Y-%m', closed_at, '+8 hours') <= ?
    ORDER BY closed_at DESC
  `).all(from, to);
  const renrenjiang = {
    total: rrjRows.length,
    divisionBreakdown: breakdown(rrjRows, r => pickDivs(r).length ? pickDivs(r) : ['未指定专业']),
    items: rrjRows.map(r => ({
      id: r.id,
      title: r.title,
      reporter: r.reporter || '',
      division: pickDivs(r).join('、') || '未指定',
      subDivision: pickSubs(r).join('、') || '—',
      selectedBy: r.rrj_selected_by || '',
      closedAt: (r.closed_at || '').slice(0, 10),
    })),
  };

  // 4) 质量人人讲（普通：已闭环但未院选，按闭环月在区间内）
  const regularRows = db.prepare(`
    SELECT id, title, reporter, division, divisions, sub_division, sub_divisions, closed_at, created_at
    FROM pdca_problems
    WHERE status = 'closed' AND (rrj_selected IS NULL OR rrj_selected = 0) AND strftime('%Y-%m', closed_at, '+8 hours') >= ? AND strftime('%Y-%m', closed_at, '+8 hours') <= ?
    ORDER BY closed_at DESC
  `).all(from, to);
  const renrenjiangRegular = {
    total: regularRows.length,
    divisionBreakdown: breakdown(regularRows, r => pickDivs(r).length ? pickDivs(r) : ['未指定专业']),
    items: regularRows.map(r => ({
      id: r.id,
      title: r.title,
      reporter: r.reporter || '',
      division: pickDivs(r).join('、') || '未指定',
      subDivision: pickSubs(r).join('、') || '—',
      closedAt: (r.closed_at || '').slice(0, 10),
    })),
  };

  // 5) 检验池（出题考试）：区间内「发起」的考试场次、参与人数、及全场最高分人员（第一名）
  //    场次按 exam_rounds.created_at（发起月）在区间内计；参与人数 = 区间内这些场次中
  //    「已完成作答」(status='done') 的【去重】人数（2026-09-15 用户裁定：仅算已交卷，
  //    不把「进入卷子但未交卷」的 in_progress 算作参与）；第一名取区间内所有已完成作答中
  //    分数最高者（同分用时短者优先、再取最先提交者）。
  const examRoundRows = db.prepare(`
    SELECT id, title, created_at
    FROM exam_rounds
    WHERE strftime('%Y-%m', created_at, '+8 hours') >= ? AND strftime('%Y-%m', created_at, '+8 hours') <= ?
    ORDER BY created_at DESC
  `).all(from, to);
  let examTop = null;
  let examParticipants = 0;
  if (examRoundRows.length) {
    const ph = examRoundRows.map(() => '?').join(',');
    // 参与人数：已完成作答（已交卷）的去重人数
    const pRow = db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(user_id, user_name)) AS p
      FROM exam_attempts
      WHERE round_id IN (${ph}) AND status = 'done'
    `).get(...examRoundRows.map(r => r.id));
    examParticipants = (pRow && pRow.p) || 0;
    const topAttempt = db.prepare(`
      SELECT a.user_name, a.score, a.correct_count, a.duration_ms, r.title AS round_title
      FROM exam_attempts a JOIN exam_rounds r ON a.round_id = r.id
      WHERE a.round_id IN (${ph}) AND a.status = 'done'
      ORDER BY a.score DESC, a.duration_ms ASC, a.submitted_at ASC
      LIMIT 1
    `).get(...examRoundRows.map(r => r.id));
    if (topAttempt) {
      examTop = {
        name: topAttempt.user_name || '',
        score: topAttempt.score || 0,
        correctCount: topAttempt.correct_count || 0,
        roundTitle: topAttempt.round_title || '',
      };
    }
  }
  const exam = {
    total: examRoundRows.length,
    participants: examParticipants,
    top: examTop,
  };

  return { range, announcements, dissem, renrenjiang, renrenjiangRegular, exam };
}

// 2026-07-26 修复 P0②：月度质量工作简报（JSON）仅院长/专总可见，防其他角色越权拉取
router.get('/monthly', (req, res) => {
  if (!rbac.canPublishAll(req.user)) return res.status(403).json({ error: '仅院长/专总可查看质量工作简报' });
  try {
    res.json(buildMonthly(req.query));
  } catch (e) {
    console.error('[stats/monthly]', e);
    res.status(500).json({ error: '统计失败' });
  }
});

// ── Word 兼容 .doc 简报导出 ──────────────────────
function breakdownLine(list) {
  if (!list.length) return '无';
  return list.map(x => `${x.name} ${x.count}`).join('、');
}
function itemsHtml(items, render) {
  if (!items.length) return '<p class="empty-tip">本周期暂无内容</p>';
  return '<ol>' + items.map(render).join('') + '</ol>';
}

function buildDoc(rep) {
  const label = rep.range.label;
  const gen = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const annItems = itemsHtml(rep.announcements.items, it => `
    <li class="brief-item">
      <div class="item-title">${escHtml(it.title)}</div>
      <div class="item-meta">${escHtml(it.publisher)}（${escHtml(it.date)}）</div>
      <div class="item-body">${escHtml(it.content)}</div>
    </li>`);

  const dissemItems = itemsHtml(rep.dissem.items, it => `
    <li class="brief-item">
      <div class="item-title">${escHtml(it.title)}</div>
      <div class="item-meta">${escHtml(it.publisher)} · ${escHtml(it.category)} · 发布 ${escHtml(it.publishDate)}</div>
      <div class="item-body">专业：${escHtml(it.divisions)}　|　二级专业：${escHtml(it.subDivisions)}</div>
    </li>`);

  const rrjItems = itemsHtml(rep.renrenjiang.items, it => `
    <li class="brief-item">
      <div class="item-title">${escHtml(it.title)}</div>
      <div class="item-meta">${escHtml(it.reporter)} · 闭环 ${escHtml(it.closedAt)}${it.selectedBy ? ` · 精选人：${escHtml(it.selectedBy)}` : ''}</div>
      <div class="item-body">专业：${escHtml(it.division)}　|　二级专业：${escHtml(it.subDivision)}</div>
    </li>`);

  const regularItems = itemsHtml(rep.renrenjiangRegular.items, it => `
    <li class="brief-item">
      <div class="item-title">${escHtml(it.title)}</div>
      <div class="item-meta">${escHtml(it.reporter)} · 闭环 ${escHtml(it.closedAt)}</div>
      <div class="item-body">专业：${escHtml(it.division)}　|　二级专业：${escHtml(it.subDivision)}</div>
    </li>`);

  // 五、检验池测试：场次 + 参与人数（已完成作答去重）+ 第一名（区间内最高分作答者）
  const exam = rep.exam || { total: 0, participants: 0, top: null };
  let examHtml;
  if (!exam.total) {
    examHtml = '<p class="empty-tip">本周期暂无测试</p>';
  } else {
    const topLine = exam.top
      ? `第一名：${escHtml(exam.top.name)} —— ${exam.top.score} 分（答对 ${exam.top.correctCount} 题）${exam.top.roundTitle ? `，出自《${escHtml(exam.top.roundTitle)}》` : ''}`
      : '本期尚无完成的作答记录';
    examHtml = `<ol>
    <li class="brief-item">
      <div class="item-title">本期检验池共发起 ${exam.total} 场测试</div>
      <div class="item-meta">参与 ${exam.participants} 人（已完成作答）　|　第一名（本期最高分）</div>
      <div class="item-body">${topLine}</div>
    </li>
  </ol>`;
  }

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta name="ProgId" content="Word.Document">
<title>质量工作简报 ${rep.range.from}_${rep.range.to}</title>
<style>
  body { font-family:"Microsoft YaHei","SimSun","SimHei",sans-serif; font-size:14px; line-height:1.8; color:#222; margin:0; }
  .report { padding:30px 46px 34px; max-width:880px; margin:0 auto; }
  .header { text-align:center; padding-bottom:14px; border-bottom:2px solid #0a5c50; margin-bottom:22px; }
  .header h1 { font-size:23px; font-weight:700; color:#0a5c50; margin:0 0 8px; letter-spacing:1px; }
  .header h2 { font-size:16px; font-weight:600; color:#333; margin:0 0 6px; }
  .header .meta { font-size:12px; color:#888; margin-top:6px; }
  .summary { margin:18px auto 26px; max-width:560px; }
  .summary h3 { text-align:center; font-size:15px; color:#0a5c50; margin:0 0 12px; font-weight:700; }
  .sum-table { width:100%; border-collapse:collapse; font-size:13px; }
  .sum-table th, .sum-table td { border:1px solid #cfdedb; padding:9px 12px; text-align:center; }
  .sum-table th { background:#0a5c50; color:#fff; font-weight:600; }
  .sum-table td:first-child { text-align:left; background:#f6faf9; }
  .sum-table tr:last-child td { background:#eaf3f1; font-weight:600; }
  .section { margin-bottom:24px; }
  .section-title { font-size:15px; font-weight:700; color:#0a5c50; margin:0 0 10px; padding:7px 0 7px 12px; border-left:4px solid #0a5c50; background:#f4f9f8; border-radius:0 3px 3px 0; }
  .stat { background:#f9fcfb; border:1px solid #e2efec; border-radius:4px; padding:8px 14px; margin:10px 0 12px; font-size:12px; color:#555; }
  ol { margin:6px 0 0; padding-left:1.6em; }
  ol li.brief-item { margin-bottom:12px; }
  .brief-item { padding:10px 0; border-bottom:1px solid #eef2f1; page-break-inside:avoid; break-inside:avoid; }
  .brief-item:last-child { border-bottom:none; }
  .item-title { font-weight:600; font-size:14px; color:#1a1a1a; }
  .item-meta { font-size:12px; color:#777; margin:4px 0 6px; }
  .item-body { font-size:13px; color:#444; line-height:1.7; }
  .empty-tip { color:#999; font-size:13px; padding:8px 0; }
  .note { font-size:11px; color:#999; margin-top:28px; border-top:1px solid #eee; padding-top:12px; line-height:1.7; }
  .section, .summary { page-break-before:auto; }
  .brief-item, .section-title, .stat, .note { page-break-inside:avoid; break-inside:avoid; }
</style>
</head>
<body>
<div class="report">
  <div class="header">
    <h1>质量管理部门 · 质量千里行</h1>
    <h2>质量工作简报（${escHtml(label)}）</h2>
    <div class="meta">生成时间：${escHtml(gen)}</div>
  </div>

  <div class="summary">
    <h3>本期内容总览</h3>
    <table class="sum-table">
      <tr><th>版块</th><th>数量</th></tr>
      <tr><td>平台公告</td><td>${rep.announcements.total} 条</td></tr>
      <tr><td>质量宣贯</td><td>${rep.dissem.total} 条</td></tr>
      <tr><td>质量人人讲（院选精选）</td><td>${rep.renrenjiang.total} 条</td></tr>
      <tr><td>质量人人讲（普通）</td><td>${rep.renrenjiangRegular.total} 条</td></tr>
      <tr><td>检验池测试</td><td>${exam.total} 场 / ${exam.participants} 人参与</td></tr>
      <tr><td>合计（内容条数）</td><td>${rep.announcements.total + rep.dissem.total + rep.renrenjiang.total + rep.renrenjiangRegular.total} 条</td></tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">一、平台公告（共 ${rep.announcements.total} 条）</div>
    <div class="stat">专业分布：${escHtml(breakdownLine(rep.announcements.divisionBreakdown))}</div>
    ${annItems}
  </div>

  <div class="section">
    <div class="section-title">二、质量宣贯（共 ${rep.dissem.total} 条）</div>
    <div class="stat">一级专业分布：${escHtml(breakdownLine(rep.dissem.divisionBreakdown))}</div>
    <div class="stat">二级专业分布：${escHtml(breakdownLine(rep.dissem.subDivisionBreakdown))}</div>
    ${dissemItems}
  </div>

  <div class="section">
    <div class="section-title">三、质量人人讲（院选精选，共 ${rep.renrenjiang.total} 条）</div>
    <div class="stat">专业分布：${escHtml(breakdownLine(rep.renrenjiang.divisionBreakdown))}</div>
    ${rrjItems}
  </div>

  <div class="section">
    <div class="section-title">四、质量人人讲（普通，共 ${rep.renrenjiangRegular.total} 条）</div>
    <div class="stat">专业分布：${escHtml(breakdownLine(rep.renrenjiangRegular.divisionBreakdown))}</div>
    ${regularItems}
  </div>

  <div class="section">
    <div class="section-title">五、检验池测试（共 ${exam.total} 场 / ${exam.participants} 人参与）</div>
    <div class="stat">统计口径：场次按「考试发起月」计；参与人数为已完成作答（已交卷）的去重人数；第一名取本期所有已完成作答中分数最高者（同分用时短者优先）。</div>
    ${examHtml}
  </div>

  <p class="note">统计口径说明：① 平台公告按「发布月」统计；质量宣贯按「最后一环批准月」统计（设计师发布的宣贯取<b>审核通过时刻</b>，专总/室主任/院长直发的宣贯取发布时刻）；数量为所选期间「已发布过」的全部条数（<b>不受公示期影响</b>：公示期到期归档的内容仍照常计入，仅剔除已软删条目）；
② 质量人人讲（含院选与普通）按「闭环月」统计，须已闭环（status=closed）；
③ 院选 = 已闭环且经专总/院长精选（rrj_selected=1），普通 = 已闭环但未入选院选；④ 公告发布时未强制选专业，故归为「全院（未指定专业）」；
⑤ 分专业统计依据内容所打的一级/二级专业标签聚合；⑥ 检验池测试按「考试发起月」统计场次，参与人数为已完成作答（已交卷）的去重人数，第一名取本期已完成作答中分数最高者（同分用时短者优先）。</p>
</div>
</body>
</html>`;
}

// ── Word 原生 .docx 简报导出（2026-09-15）────────────────────
// 背景：原 /monthly-export 返回「HTML 套 Word 头」的 .doc（application/msword）。Word 用它老旧的
// HTML 引擎解析这份「为 Chrome 写」的 HTML（flex/背景块/圆角/分页规则），版式严重走形；而 PDF 是
// Chrome 渲染后 html2canvas 的像素快照——同一份 HTML、两种引擎，故必然不像。
// 现改为用**已装依赖 docx@9** 生成真 .docx：标题/表格/编号列表均为 Word 原生对象 →
// 文字可编辑、可检索、打印不乱；配色与结构按 PDF 版设计规范复刻（主色 #0A5C50、总览表、
// 分节标题、条目三段式、口径说明、A4 + 12mm 页边距）。
// lazy require 避免 docx 常驻内存（与 ima.js 同法）。
const DOCX_FONT = 'Microsoft YaHei';
let _DOCX_LIB = null;
function getDocxLib() { if (!_DOCX_LIB) _DOCX_LIB = require('docx'); return _DOCX_LIB; }

function buildDocx(rep) {
  const D = getDocxLib();
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, BorderStyle, ShadingType, AlignmentType, LevelFormat,
    VerticalAlign, TableLayoutType, LineRuleType, convertMillimetersToTwip } = D;

  const label = rep.range.label;
  const exam = rep.exam || { total: 0, participants: 0, top: null };
  const gen = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const hp = px => Math.round(px * 1.5);   // 设计稿 px → Word 半磅（half-point）：px*0.75pt*2
  const tw = px => Math.round(px * 15);    // 设计稿 px → 缇（twip）：1px = 0.75pt = 15twip
  const FONT = { ascii: DOCX_FONT, eastAsia: DOCX_FONT, hAnsi: DOCX_FONT };
  const run = (text, o) => new TextRun(Object.assign(
    { text: String(text == null ? '' : text), font: FONT }, o || {}));
  const bd = (color, size) => ({ style: BorderStyle.SINGLE, size: size == null ? 6 : size, color, space: 0 });
  const shade = fill => ({ type: ShadingType.CLEAR, fill, color: 'auto' });

  // 每个版块独立 numbering reference → 各自从 1 重新编号
  const NUM_REFS = ['bn1', 'bn2', 'bn3', 'bn4', 'bn5'];
  const numLevel = { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START };

  // 条目三段式：标题（带序号，悬挂缩进）/ 元信息 / 正文（下边框分隔）；keepNext 防条目跨页断开
  const itemParas = (ref, title, meta, body) => ([
    new Paragraph({
      numbering: { reference: ref, level: 0 },
      indent: { left: tw(24), hanging: tw(24) },
      spacing: { before: tw(10), after: tw(3) },
      keepNext: true,
      children: [run(title, { bold: true, size: hp(14), color: '1A1A1A' })],
    }),
    new Paragraph({
      indent: { left: tw(24) },
      spacing: { after: tw(4), line: 300, lineRule: LineRuleType.AUTO },
      keepNext: true,
      children: [run(meta, { size: hp(12), color: '777777' })],
    }),
    new Paragraph({
      indent: { left: tw(24) },
      spacing: { after: tw(10), line: 408, lineRule: LineRuleType.AUTO },
      border: { bottom: bd('EEF2F1') },
      children: [run(body, { size: hp(13), color: '444444' })],
    }),
  ]);

  const sectionTitle = text => new Paragraph({
    shading: shade('F4F9F8'),
    border: { left: bd('0A5C50', 24) },   // 4px ≈ 3pt → 八分之一磅制 size=24
    indent: { left: tw(12) },
    spacing: { before: tw(16), after: tw(10) },
    keepNext: true,
    children: [run(text, { bold: true, size: hp(15), color: '0A5C50' })],
  });

  const statPara = text => new Paragraph({
    shading: shade('F9FCFB'),
    border: { top: bd('E2EFEC'), bottom: bd('E2EFEC'), left: bd('E2EFEC'), right: bd('E2EFEC') },
    indent: { left: tw(14), right: tw(14) },
    spacing: { before: tw(10), after: tw(12) },
    keepNext: true,
    children: [run(text, { size: hp(12), color: '555555' })],
  });

  const emptyTip = () => new Paragraph({
    indent: { left: tw(24) },
    spacing: { before: tw(8), after: tw(10) },
    children: [run('本周期暂无内容', { size: hp(13), color: '999999' })],
  });

  const blockItems = (ref, items, toTitle, toMeta, toBody) => {
    if (!items.length) return [emptyTip()];
    return items.reduce((acc, it) => acc.concat(itemParas(ref, toTitle(it), toMeta(it), toBody(it))), []);
  };

  // ── 总览表（Word 原生表格）──
  const sumRows = [
    ['平台公告', rep.announcements.total],
    ['质量宣贯', rep.dissem.total],
    ['质量人人讲（院选精选）', rep.renrenjiang.total],
    ['质量人人讲（普通）', rep.renrenjiangRegular.total],
  ];
  const sumTotal = sumRows.reduce((a, r) => a + r[1], 0);
  const W1 = 5040, W2 = 3360;   // 60% / 40%，合计 8400 dxa ≈ 148mm（对齐 PDF 总览表 560px 上限）
  const tcell = (text, o) => {
    o = o || {};
    return new TableCell({
      width: { size: o.w, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: tw(9), bottom: tw(9), left: tw(12), right: tw(12) },
      ...(o.fill ? { shading: shade(o.fill) } : {}),
      children: [new Paragraph({
        alignment: o.align || AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [run(text, { size: hp(13), bold: !!o.bold, color: o.color || '333333' })],
      })],
    });
  };
  const sumTable = new Table({
    width: { size: W1 + W2, type: WidthType.DXA },
    alignment: AlignmentType.CENTER,
    layout: TableLayoutType.FIXED,
    borders: {
      top: bd('CFDEDB'), bottom: bd('CFDEDB'), left: bd('CFDEDB'), right: bd('CFDEDB'),
      insideHorizontal: bd('CFDEDB'), insideVertical: bd('CFDEDB'),
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          tcell('版块', { w: W1, fill: '0A5C50', color: 'FFFFFF', bold: true }),
          tcell('数量', { w: W2, fill: '0A5C50', color: 'FFFFFF', bold: true }),
        ],
      }),
      ...sumRows.map(([name, n]) => new TableRow({
        children: [tcell(name, { w: W1, align: AlignmentType.LEFT, fill: 'F6FAF9' }), tcell(`${n} 条`, { w: W2 })],
      })),
      new TableRow({
        children: [tcell('检验池测试', { w: W1, align: AlignmentType.LEFT, fill: 'F6FAF9' }), tcell(`${exam.total} 场 / ${exam.participants} 人参与`, { w: W2 })],
      }),
      new TableRow({
        children: [
          tcell('合计（内容条数）', { w: W1, align: AlignmentType.LEFT, fill: 'EAF3F1', bold: true }),
          tcell(`${sumTotal} 条`, { w: W2, fill: 'EAF3F1', bold: true }),
        ],
      }),
    ],
  });

  // ── 五、检验池测试 ──
  const examParas = (!exam.total)
    ? [emptyTip()]
    : (() => {
        const topLine = exam.top
          ? `第一名：${exam.top.name} —— ${exam.top.score} 分（答对 ${exam.top.correctCount} 题）${exam.top.roundTitle ? `，出自《${exam.top.roundTitle}》` : ''}`
          : '本期尚无完成的作答记录';
        return itemParas(NUM_REFS[4], `本期检验池共发起 ${exam.total} 场测试`, `参与 ${exam.participants} 人（已完成作答）　|　第一名（本期最高分）`, topLine);
      })();

  const children = [
    // 页眉区
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: tw(6) }, children: [run('质量管理部门 · 质量千里行', { bold: true, size: hp(23), color: '0A5C50', characterSpacing: 15 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: tw(4) }, children: [run(`质量工作简报（${label}）`, { bold: true, size: hp(16), color: '333333' })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: tw(14) }, border: { bottom: bd('0A5C50', 12) }, children: [run(`生成时间：${gen}`, { size: hp(12), color: '888888' })] }),

    // 总览
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: tw(14), after: tw(12) }, children: [run('本期内容总览', { bold: true, size: hp(15), color: '0A5C50' })] }),
    sumTable,

    // 一、平台公告
    sectionTitle(`一、平台公告（共 ${rep.announcements.total} 条）`),
    statPara(`专业分布：${breakdownLine(rep.announcements.divisionBreakdown)}`),
    ...blockItems(NUM_REFS[0], rep.announcements.items,
      it => it.title, it => `${it.publisher}（${it.date}）`, it => it.content),

    // 二、质量宣贯
    sectionTitle(`二、质量宣贯（共 ${rep.dissem.total} 条）`),
    statPara(`一级专业分布：${breakdownLine(rep.dissem.divisionBreakdown)}`),
    statPara(`二级专业分布：${breakdownLine(rep.dissem.subDivisionBreakdown)}`),
    ...blockItems(NUM_REFS[1], rep.dissem.items,
      it => it.title, it => `${it.publisher} · ${it.category} · 发布 ${it.publishDate}`, it => `专业：${it.divisions}　|　二级专业：${it.subDivisions}`),

    // 三、质量人人讲（院选精选）
    sectionTitle(`三、质量人人讲（院选精选，共 ${rep.renrenjiang.total} 条）`),
    statPara(`专业分布：${breakdownLine(rep.renrenjiang.divisionBreakdown)}`),
    ...blockItems(NUM_REFS[2], rep.renrenjiang.items,
      it => it.title, it => `${it.reporter} · 闭环 ${it.closedAt}${it.selectedBy ? ` · 精选人：${it.selectedBy}` : ''}`, it => `专业：${it.division}　|　二级专业：${it.subDivision}`),

    // 四、质量人人讲（普通）
    sectionTitle(`四、质量人人讲（普通，共 ${rep.renrenjiangRegular.total} 条）`),
    statPara(`专业分布：${breakdownLine(rep.renrenjiangRegular.divisionBreakdown)}`),
    ...blockItems(NUM_REFS[3], rep.renrenjiangRegular.items,
      it => it.title, it => `${it.reporter} · 闭环 ${it.closedAt}`, it => `专业：${it.division}　|　二级专业：${it.subDivision}`),

    // 五、检验池测试
    sectionTitle(`五、检验池测试（共 ${exam.total} 场 / ${exam.participants} 人参与）`),
    statPara('统计口径：场次按「考试发起月」计；参与人数为已完成作答（已交卷）的去重人数；第一名取本期所有已完成作答中分数最高者（同分用时短者优先）。'),
    ...examParas,

    // 口径说明（含加粗片段）
    new Paragraph({
      border: { top: bd('EEEEEE') },
      spacing: { before: tw(28), after: 0, line: 408, lineRule: LineRuleType.AUTO },
      children: [
        run('统计口径说明：① 平台公告按「发布月」统计；质量宣贯按「最后一环批准月」统计（设计师发布的宣贯取审核通过时刻，专总/室主任/院长直发的宣贯取发布时刻）；数量为所选期间「已发布过」的全部条数（', { size: hp(11), color: '999999' }),
        run('不受公示期影响', { size: hp(11), color: '999999', bold: true }),
        run('：公示期到期归档的内容仍照常计入，仅剔除已软删条目）；② 质量人人讲（含院选与普通）按「闭环月」统计，须已闭环（status=closed）；③ 院选 = 已闭环且经专总/院长精选（rrj_selected=1），普通 = 已闭环但未入选院选；④ 公告发布时未强制选专业，故归为「全院（未指定专业）」；⑤ 分专业统计依据内容所打的一级/二级专业标签聚合；⑥ 检验池测试按「考试发起月」统计场次，参与人数为已完成作答（已交卷）的去重人数，第一名取本期已完成作答中分数最高者（同分用时短者优先）。', { size: hp(11), color: '999999' }),
      ],
    }),
  ];

  const doc = new Document({
    creator: '质量管理部门 · 质量千里行',
    title: `质量工作简报 ${rep.range.from}_${rep.range.to}`,
    description: '由质量千里行系统自动生成',
    numbering: { config: NUM_REFS.map(ref => ({ reference: ref, levels: [numLevel] })) },
    sections: [{
      properties: {
        page: {
          size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
          margin: {
            top: convertMillimetersToTwip(12), right: convertMillimetersToTwip(12),
            bottom: convertMillimetersToTwip(14), left: convertMillimetersToTwip(12),
          },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

// 2026-07-26 修复 P0②：月度简报导出仅院长/专总可下载，防设计师等越权导出专属简报
// 2026-09-15：由「HTML 套 Word 头」的 .doc 改为**真 .docx**（docx@9 原生生成，文字可编辑，
//             版式按 PDF 版设计规范复刻），根治 Word 打开后版式走形。
router.get('/monthly-export', async (req, res) => {
  if (!rbac.canPublishAll(req.user)) return res.status(403).json({ error: '仅院长/专总可导出质量工作简报' });
  try {
    const rep = buildMonthly(req.query);
    const buf = await buildDocx(rep);
    const fname = `quality_report_${rep.range.from}_${rep.range.to}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e) {
    console.error('[stats/monthly-export]', e);
    res.status(500).json({ error: '导出失败' });
  }
});

// 2026-08-20：新增纯 HTML 简报（供前端 html2canvas 截图生成 PDF）；内容结构与 Word 版一致（含总览）
router.get('/monthly-html', (req, res) => {
  if (!rbac.canPublishAll(req.user)) return res.status(403).json({ error: '仅院长/专总可查看质量工作简报' });
  try {
    const rep = buildMonthly(req.query);
    const html = buildDoc(rep);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(Buffer.from(html, 'utf-8'));
  } catch (e) {
    console.error('[stats/monthly-html]', e);
    res.status(500).json({ error: '生成简报失败' });
  }
});

module.exports = router;
