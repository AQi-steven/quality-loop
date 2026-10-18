/**
 * 小红花激励体系路由
 *
 *   GET /api/flowers/summary   排行榜：按用户汇总小红花数（含 宣贯/PDCA 分项）
 *   GET /api/flowers/me        我的小红花数
 *   GET /api/flowers           发放明细（可按 ?user=姓名 过滤）
 */
const express = require('express');
const db = require('../db/connection');
const rbac = require('../rbac');
const flowers = require('../flowers');
const { FLOWER_ELIGIBLE_IDS, FLOWER_EXCLUDE_ROLES, flowerShouldExclude, settlePreviousMonth, settleBimonthChampion } = flowers;
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 手动补充小红花（仅 admin 可调，用于修复历史数据）
router.post('/fix', (req, res) => {
  const u = req.user;
  if (u.username !== 'admin') return res.status(403).json({ error: '仅 admin 可执行' });
  const { userId, userName, kind, refId, title, amount = 1 } = req.body;
  if (!userId || !userName || !kind || !refId) return res.status(400).json({ error: '缺少参数' });
  const existing = db.prepare('SELECT id FROM red_flowers WHERE kind=? AND ref_id=?').get(kind, refId);
  if (existing) return res.json({ message: '已存在', id: existing.id });
  const info = db.prepare(
    'INSERT INTO red_flowers (user_id, user_name, kind, ref_id, ref_title, awarded_by, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
  ).run(userId, userName, kind, refId, title || '', userName, amount);
  res.json({ message: '已添加', id: info.lastInsertRowid });
});

// 红花奖惩：院长/系统管理员基于额外理由授予或减扣小红花（专总/院长/总工/系统管理员不参与评选，不计）
router.post('/adjust', (req, res) => {
  const u = req.user;
  if (!rbac.rolesOf(u).some(r => ['admin', 'dean'].includes(r))) {
    return res.status(403).json({ error: '仅院长/系统管理员可执行红花奖惩' });
  }
  const { targetUserId, targetName, delta, reason } = req.body;
  const d = parseInt(delta, 10);
  if (!targetUserId || !targetName || !Number.isInteger(d) || d === 0) {
    return res.status(400).json({ error: '参数不完整或增减数量无效（不能为 0）' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: '请填写奖惩原因' });
  }
  const t = db.prepare('SELECT id, role, is_active FROM users WHERE id=?').get(targetUserId);
  if (!t) return res.status(404).json({ error: '目标用户不存在' });
  if (!t.is_active) return res.status(400).json({ error: '目标用户已禁用' });
  if (FLOWER_EXCLUDE_ROLES.includes(t.role) && !FLOWER_ELIGIBLE_IDS.has(t.id)) {
    return res.status(400).json({ error: '专总/院长/总工/系统管理员不参与小红花，不可增减' });
  }
  const info = db.prepare(
    `INSERT INTO flower_adjustments (target_user_id, target_name, operator_id, operator_name, delta, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(targetUserId, targetName, u.id, u.realName, d, String(reason).trim());
  res.json({ message: '已' + (d > 0 ? '授予' : '减扣') + ' ' + Math.abs(d) + ' 朵小红花', id: info.lastInsertRowid, delta: d });
});

// 红花奖惩记录（仅院长/系统管理员可查，按时间倒序）
router.get('/adjustments', (req, res) => {
  const u = req.user;
  if (!rbac.rolesOf(u).some(r => ['admin', 'dean'].includes(r))) return res.status(403).json({ error: '仅院长/系统管理员可查看' });
  // 不参与红花评选的岗位（专总/院长/总工/系统管理员）的历史奖惩记录也不展示；例外名单仍展示
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const list = db.prepare(
    `SELECT a.id, a.target_user_id, a.target_name, a.operator_name, a.delta, a.reason,
            strftime('%Y-%m-%d %H:%M', a.created_at, '+8 hours') AS created_at
     FROM flower_adjustments a
     LEFT JOIN users u ON a.target_user_id = u.id
     WHERE (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${[...FLOWER_ELIGIBLE_IDS].join(',')}))
     ORDER BY a.created_at DESC LIMIT 50`
  ).all();
  res.json(list);
});

// 红花评选例外白名单（前端「红花奖惩管理」选人下拉需纳入，与后端一致）
router.get('/eligible-ids', (req, res) => {
  res.json([...FLOWER_ELIGIBLE_IDS]);
});

// 月冠军结算（仅 院长/系统管理员/专总 可触发；幂等，上月已结算则跳过）
// 将上一自然月小红花月度总数最高者写入 month_champions，供年度榜「👑×N」累计展示
router.post('/settle-month', (req, res) => {
  const u = req.user;
  if (!rbac.rolesOf(u).some(r => ['admin', 'dean', 'chief'].includes(r))) {
    return res.status(403).json({ error: '仅院长/系统管理员/专总可结算月冠军' });
  }
  try {
    const month = settlePreviousMonth(db);
    const bimonth = settleBimonthChampion(db);
    res.json({ ok: true, month, bimonth });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 质量工作奖惩榜：按「净奖惩」从加分到减分排列，含每人的逐条加减分具体内容
// 全员可见（与 /summary 一致），理由为质量工作奖惩公开内容
router.get('/adjust-board', (req, res) => {
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const ELIGIBLE_IDS = [...FLOWER_ELIGIBLE_IDS].join(',');
  const rows = db.prepare(`
    SELECT a.target_name AS userName, a.delta, a.reason, a.operator_name,
           strftime('%Y-%m-%d %H:%M', a.created_at, '+8 hours') AS created_at
    FROM flower_adjustments a
    LEFT JOIN users u ON a.target_user_id = u.id
    WHERE (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))
    ORDER BY a.created_at DESC
  `).all();
  const map = {};
  for (const r of rows) {
    if (!map[r.userName]) map[r.userName] = { userName: r.userName, adjust: 0, records: [] };
    map[r.userName].adjust += (r.delta || 0);
    map[r.userName].records.push({ delta: r.delta, reason: r.reason, operator_name: r.operator_name, created_at: r.created_at });
  }
  const list = Object.values(map).sort((a, b) => (b.adjust - a.adjust) || (a.userName < b.userName ? -1 : 1));
  res.json(list);
});

router.get('/summary', (req, res) => {
  // 不参与红花评选的岗位：专总/院长/总工/系统管理员（leader 为管理员别名）；例外白名单仍参与
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const ELIGIBLE_IDS = [...FLOWER_ELIGIBLE_IDS].join(',');
  const rows = db.prepare(`
    SELECT COALESCE(rf.user_name, '匿名') AS userName,
           SUM(rf.amount) AS c,
           SUM(CASE WHEN rf.kind='dissem' THEN rf.amount ELSE 0 END) AS dissem,
           SUM(CASE WHEN rf.kind='pdca' THEN rf.amount ELSE 0 END) AS pdca,
           SUM(CASE WHEN rf.kind='rrj' THEN rf.amount ELSE 0 END) AS rrj,
           SUM(CASE WHEN rf.kind='quiz' THEN rf.amount ELSE 0 END) AS quiz,
           SUM(CASE WHEN rf.kind='dissem' AND strftime('%Y-%m', rf.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS dissemM,
           SUM(CASE WHEN rf.kind='pdca'   AND strftime('%Y-%m', rf.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS pdcaM,
           SUM(CASE WHEN rf.kind='rrj'    AND strftime('%Y-%m', rf.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS rrjM,
           SUM(CASE WHEN rf.kind='quiz'   AND strftime('%Y-%m', rf.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS quizM,
           SUM(CASE WHEN rf.kind='dissem' AND strftime('%Y', rf.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS dissemY,
           SUM(CASE WHEN rf.kind='pdca'   AND strftime('%Y', rf.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS pdcaY,
           SUM(CASE WHEN rf.kind='rrj'    AND strftime('%Y', rf.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS rrjY,
           SUM(CASE WHEN rf.kind='quiz'   AND strftime('%Y', rf.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS quizY,
           SUM(CASE WHEN strftime('%Y-%m', rf.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS month,
           SUM(CASE WHEN strftime('%Y', rf.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN rf.amount ELSE 0 END) AS year
    FROM red_flowers rf
    LEFT JOIN users u ON rf.user_id = u.id OR rf.user_name = u.real_name
    WHERE (u.id IS NULL OR (u.username != 'admin' AND (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))))
    GROUP BY rf.user_name
  `).all();
  const map = {};
  for (const r of rows) {
    map[r.userName] = {
      userName: r.userName, count: r.c || 0, dissem: r.dissem || 0, pdca: r.pdca || 0,
      rrj: r.rrj || 0, quiz: r.quiz || 0, month: r.month || 0, year: r.year || 0, adjust: 0,
      dissemM: r.dissemM || 0, pdcaM: r.pdcaM || 0, rrjM: r.rrjM || 0, quizM: r.quizM || 0,
      dissemY: r.dissemY || 0, pdcaY: r.pdcaY || 0, rrjY: r.rrjY || 0, quizY: r.quizY || 0,
      adjustM: 0, adjustY: 0, champions: 0,
    };
  }
  // 月冠军累计：每人历史上累计获得「月冠军」次数（status='settled' 的有效记录）
  const champRows = db.prepare(
    `SELECT user_name AS userName, COUNT(*) AS n FROM month_champions WHERE status='settled' GROUP BY user_name`
  ).all();
  for (const c of champRows) {
    if (!map[c.userName]) {
      map[c.userName] = { userName: c.userName, count: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, month: 0, year: 0, adjust: 0,
        dissemM: 0, pdcaM: 0, rrjM: 0, quizM: 0, dissemY: 0, pdcaY: 0, rrjY: 0, quizY: 0, adjustM: 0, adjustY: 0, champions: 0 };
    }
    map[c.userName].champions = c.n || 0;
  }
  // 合并红花奖惩（质量工作奖惩）：增减计入总数与本月/本年
  const adjRows = db.prepare(`
    SELECT a.target_name AS userName,
           SUM(a.delta) AS adj,
           SUM(CASE WHEN strftime('%Y-%m', a.created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN a.delta ELSE 0 END) AS adjMonth,
           SUM(CASE WHEN strftime('%Y', a.created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN a.delta ELSE 0 END) AS adjYear
    FROM flower_adjustments a
    LEFT JOIN users u ON a.target_user_id = u.id
    WHERE (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))
    GROUP BY a.target_name
  `).all();
  for (const a of adjRows) {
    const adj = a.adj || 0;
    if (!map[a.userName]) {
      map[a.userName] = { userName: a.userName, count: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, month: 0, year: 0, adjust: 0,
        dissemM: 0, pdcaM: 0, rrjM: 0, quizM: 0, dissemY: 0, pdcaY: 0, rrjY: 0, quizY: 0, adjustM: 0, adjustY: 0, champions: 0 };
    }
    map[a.userName].count += adj;
    map[a.userName].month += (a.adjMonth || 0);
    map[a.userName].year += (a.adjYear || 0);
    map[a.userName].adjust += adj;
    map[a.userName].adjustM += (a.adjMonth || 0);
    map[a.userName].adjustY += (a.adjYear || 0);
  }
  // 种子：纳入所有应参与红花评选的在岗人员（设计师/室主任等 + 例外白名单），保证名单完整（无花者计 0，领导岗位不计）
  const eligible = db.prepare(
    `SELECT real_name AS userName FROM users WHERE is_active=1 AND COALESCE(is_guest,0)=0 AND COALESCE(title_tag,'') <> '体验账号' AND (role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR id IN (${ELIGIBLE_IDS}))`
  ).all();
  for (const e of eligible) {
    if (!map[e.userName]) {
      map[e.userName] = { userName: e.userName, count: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, month: 0, year: 0, adjust: 0,
        dissemM: 0, pdcaM: 0, rrjM: 0, quizM: 0, dissemY: 0, pdcaY: 0, rrjY: 0, quizY: 0, adjustM: 0, adjustY: 0, champions: 0 };
    }
  }
  const list = Object.values(map).sort((a, b) => (b.count - a.count) || (a.userName < b.userName ? -1 : 1));
  res.json(list);
});

// 质量双月榜：统计指定年份 9 月 + 10 月小红花数量的总和排名（含宣贯/PDCA/人人讲/测验/质量工作奖惩五项）
// 与 /summary 一致：同样排除专总/院长/总工/系统管理员（例外白名单仍参与），纳入在岗种子
router.get('/bimonth', (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const ELIGIBLE_IDS = [...FLOWER_ELIGIBLE_IDS].join(',');
  const rows = db.prepare(`
    SELECT COALESCE(rf.user_name, '匿名') AS userName,
           SUM(rf.amount) AS c,
           SUM(CASE WHEN rf.kind='dissem' THEN rf.amount ELSE 0 END) AS dissem,
           SUM(CASE WHEN rf.kind='pdca' THEN rf.amount ELSE 0 END) AS pdca,
           SUM(CASE WHEN rf.kind='rrj' THEN rf.amount ELSE 0 END) AS rrj,
           SUM(CASE WHEN rf.kind='quiz' THEN rf.amount ELSE 0 END) AS quiz
    FROM red_flowers rf
    LEFT JOIN users u ON rf.user_id = u.id OR rf.user_name = u.real_name
    WHERE (u.id IS NULL OR (u.username != 'admin' AND (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))))
      AND strftime('%Y', rf.created_at, '+8 hours') = :year
      AND strftime('%m', rf.created_at, '+8 hours') IN ('09','10')
    GROUP BY rf.user_name
  `).all({ year: String(year) });
  const map = {};
  for (const r of rows) {
    map[r.userName] = {
      userName: r.userName, bimonth: r.c || 0, count: r.c || 0,
      dissem: r.dissem || 0, pdca: r.pdca || 0, rrj: r.rrj || 0, quiz: r.quiz || 0,
      adjust: 0, champions: 0,
    };
  }
  // 合并红花奖惩（质量工作奖惩）：仅计入该年 9-10 月
  const adjRows = db.prepare(`
    SELECT a.target_name AS userName,
           SUM(a.delta) AS adj
    FROM flower_adjustments a
    LEFT JOIN users u ON a.target_user_id = u.id
    WHERE (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))
      AND strftime('%Y', a.created_at, '+8 hours') = :year
      AND strftime('%m', a.created_at, '+8 hours') IN ('09','10')
    GROUP BY a.target_name
  `).all({ year: String(year) });
  for (const a of adjRows) {
    const adj = a.adj || 0;
    if (!map[a.userName]) {
      map[a.userName] = { userName: a.userName, bimonth: 0, count: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, adjust: 0, champions: 0 };
    }
    map[a.userName].bimonth += adj;
    map[a.userName].count += adj;
    map[a.userName].adjust += adj;
  }
  // 种子：纳入所有应参与红花评选的在岗人员（保证名单完整，无花者计 0）
  const eligible = db.prepare(
    `SELECT real_name AS userName FROM users WHERE is_active=1 AND COALESCE(is_guest,0)=0 AND COALESCE(title_tag,'') <> '体验账号' AND (role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR id IN (${ELIGIBLE_IDS}))`
  ).all();
  for (const e of eligible) {
    if (!map[e.userName]) {
      map[e.userName] = { userName: e.userName, bimonth: 0, count: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, adjust: 0, champions: 0 };
    }
  }
  // 已结算的「双月冠军」（type='bimonth'）标记，供前端展示 👑 质量双月冠军（未结算前仅显示 ⭐ 双月领先）
  const champRows = db.prepare("SELECT user_name FROM month_champions WHERE month=? AND type='bimonth' AND status='settled'").all(`${year}-10`);
  const champSet = new Set(champRows.map(c => c.user_name));
  const list = Object.values(map)
    .sort((a, b) => (b.bimonth - a.bimonth) || (a.userName < b.userName ? -1 : 1))
    .map(x => Object.assign({}, x, { bimonthChampion: champSet.has(x.userName) }));
  res.json(list);
});

// 我的小红花（按 id 或 姓名匹配，兼容历史数据无 user_id）
// 专总/院长不计入小红花榜（其任何行为不计入统计），故直接返回 0
router.get('/me', (req, res) => {
  const u = req.user;
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  if (rbac.hasAllDivisions(u) && !FLOWER_ELIGIBLE_IDS.has(u.id)) return res.json({ count: 0, month: 0, year: 0, bimonth: 0, bimonthAdj: 0, dissemB: 0, pdcaB: 0, rrjB: 0, quizB: 0, dissem: 0, pdca: 0, rrj: 0, adjust: 0, adjustments: [] });
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount),0) c,
           COALESCE(SUM(CASE WHEN kind='dissem' THEN amount ELSE 0 END),0) AS dissem,
           COALESCE(SUM(CASE WHEN kind='pdca' THEN amount ELSE 0 END),0) AS pdca,
           COALESCE(SUM(CASE WHEN kind='rrj' THEN amount ELSE 0 END),0) AS rrj,
           COALESCE(SUM(CASE WHEN kind='quiz' THEN amount ELSE 0 END),0) AS quiz,
           COALESCE(SUM(CASE WHEN kind='dissem' AND strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS dissemM,
           COALESCE(SUM(CASE WHEN kind='pdca'   AND strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS pdcaM,
           COALESCE(SUM(CASE WHEN kind='rrj'    AND strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS rrjM,
           COALESCE(SUM(CASE WHEN kind='quiz'   AND strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS quizM,
           COALESCE(SUM(CASE WHEN kind='dissem' AND strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS dissemY,
           COALESCE(SUM(CASE WHEN kind='pdca'   AND strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS pdcaY,
           COALESCE(SUM(CASE WHEN kind='rrj'    AND strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS rrjY,
           COALESCE(SUM(CASE WHEN kind='quiz'   AND strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS quizY,
           COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS m,
           COALESCE(SUM(CASE WHEN strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN amount ELSE 0 END),0) AS y
    FROM red_flowers WHERE (user_id=? AND user_id IS NOT NULL) OR user_name=?
  `).get(u.id, u.realName);
  const adj = db.prepare(`
    SELECT COALESCE(SUM(delta),0) a,
           COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at, '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN delta ELSE 0 END),0) AS am,
           COALESCE(SUM(CASE WHEN strftime('%Y', created_at, '+8 hours') = strftime('%Y', 'now', '+8 hours') THEN delta ELSE 0 END),0) AS ay
    FROM flower_adjustments WHERE target_user_id=? OR target_name=?
  `).get(u.id, u.realName);
  const list = db.prepare(`
    SELECT delta, reason, operator_name, strftime('%Y-%m-%d %H:%M', created_at, '+8 hours') AS created_at
    FROM flower_adjustments WHERE target_user_id=? OR target_name=? ORDER BY created_at DESC
  `).all(u.id, u.realName);
  // 终身累计的宣贯 / PDCA / 人人讲 小红花明细（构成明细四项之一；记录区也需展示这三类对应记录）
  const rfList = db.prepare(`
    SELECT kind, ref_title, amount, strftime('%Y-%m-%d %H:%M', created_at, '+8 hours') AS created_at
    FROM red_flowers WHERE (user_id=? AND user_id IS NOT NULL) OR user_name=? ORDER BY created_at DESC
  `).all(u.id, u.realName);
  // 质量双月（指定年份 9-10 月）小红花合计与分项，供「质量双月」页签个人卡展示
  const bRow = db.prepare(`
    SELECT COALESCE(SUM(rf.amount),0) b,
           COALESCE(SUM(CASE WHEN rf.kind='dissem' THEN rf.amount ELSE 0 END),0) AS dissemB,
           COALESCE(SUM(CASE WHEN rf.kind='pdca' THEN rf.amount ELSE 0 END),0) AS pdcaB,
           COALESCE(SUM(CASE WHEN rf.kind='rrj' THEN rf.amount ELSE 0 END),0) AS rrjB,
           COALESCE(SUM(CASE WHEN rf.kind='quiz' THEN rf.amount ELSE 0 END),0) AS quizB
    FROM red_flowers rf
    WHERE ((rf.user_id=? AND rf.user_id IS NOT NULL) OR rf.user_name=?)
      AND strftime('%Y', rf.created_at, '+8 hours')=?
      AND strftime('%m', rf.created_at, '+8 hours') IN ('09','10')
  `).get(u.id, u.realName, String(year));
  const bAdj = db.prepare(`
    SELECT COALESCE(SUM(delta),0) a
    FROM flower_adjustments
    WHERE (target_user_id=? OR target_name=?)
      AND strftime('%Y', created_at, '+8 hours')=?
      AND strftime('%m', created_at, '+8 hours') IN ('08','09')
  `).get(u.id, u.realName, String(year));
  const champ = db.prepare("SELECT COUNT(*) AS n FROM month_champions WHERE status='settled' AND user_name=?").get(u.realName);
  res.json({
    count: (row.c || 0) + (adj.a || 0),
    month: (row.m || 0) + (adj.am || 0),
    year: (row.y || 0) + (adj.ay || 0),
    bimonth: (bRow.b || 0) + (bAdj.a || 0),
    bimonthAdj: (bAdj.a || 0),
    dissemB: (bRow.dissemB || 0), pdcaB: (bRow.pdcaB || 0), rrjB: (bRow.rrjB || 0), quizB: (bRow.quizB || 0),
    dissemM: (row.dissemM || 0), pdcaM: (row.pdcaM || 0), rrjM: (row.rrjM || 0), quizM: (row.quizM || 0),
    dissemY: (row.dissemY || 0), pdcaY: (row.pdcaY || 0), rrjY: (row.rrjY || 0), quizY: (row.quizY || 0),
    adjustM: (adj.am || 0), adjustY: (adj.ay || 0),
    adjust: adj.a || 0,
    dissem: (row.dissem || 0), pdca: (row.pdca || 0), rrj: (row.rrj || 0), quiz: (row.quiz || 0),
    champions: champ ? (champ.n || 0) : 0,
    adjustments: list,
    redflowers: rfList,
  });
});

// 明细（可选按姓名过滤）
// 仅管理者（室主任/专总/院长/系统管理员）可查看全部红花明细，避免设计师越权读取他人逐条记录
router.get('/', (req, res) => {
  const u = req.user;
  if (!rbac.canManage(u) && u.role !== 'admin') {
    return res.status(403).json({ error: '仅管理者可查看红花明细' });
  }
  const { user } = req.query;
  let sql = 'SELECT * FROM red_flowers';
  const p = [];
  if (user) { sql += ' WHERE user_name=?'; p.push(user); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...p));
});

module.exports = router;
