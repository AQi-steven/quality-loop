/**
 * 已阅确认路由（取代通用 comments）
 *
 * 统一以 (target_type, target_id) 定位被确认对象：
 *   - announcement  公告
 *   - dissem        质量宣贯
 *   - pdca          PDCA 问题（含人人讲院选公示）
 *
 *   GET    /counts?targets=type:id,...  批量计数（首页一屏多卡片一次拉全，避免 N+1）
 *                                      返回 { counts: { "announcement:1": { acked, total, requireAck } } }
 *   GET    /?target_type=&target_id=   详情：{ requireAck, read[], unread[], title }
 *   POST   /                           标记已阅（游客 403；require_ack=0 则 403；幂等）
 *   POST   /remind                     给未阅人批量建站内提醒（仅发布人/管理者可触发）
 *
 * 应阅池口径（2026-10-12 修订，与人员重分类一致）：
 *   排除：游客 / 院长 / 总工 / 系统管理员 / 综管 / 咨询 / 内部体验账号。
 *   专总、室主任、各设计专业设计师均纳入应阅；唯二按姓名单列剔除：李硕(绿建低碳)、×××(建筑专总)。
 *   - 赵良福(77) 已转综管；咨询专业 = 综能/节能全量 + 通信(王楠/肖苏超/张昭/沈浩宇/施国华)
 *     + 建筑(×××、×××)，其 division 在库中置为 '咨询'，由 isManagement 统一排除。
 *   - ×××(建筑) 经裁定"不排除"，正常纳入应阅池。
 *   - 作者豁免（2026-10-12）：帖子作者（公告/宣贯 publisher_id、PDCA reporter_user_id）
 *     不计入本人所发帖子的应阅池，无论其是否属面向专业（作者无需阅自己的帖）。
 *   - 面向专业（公告 scope=division / 宣贯 divisions 非空 / PDCA divisions 非空）：
 *     仅「面向专业」内、在册、非游客、未被排除的设计师；
 *   - 全员帖（公告 scope=all / 宣贯 divisions 空 / PDCA 无专业老数据）：
 *     所有在册非游客未被排除的设计师，无专业过滤；
 *   - PDCA 额外剔除已在帖内回复的专家（answer_by 实名）。
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

const TYPES = new Set(['announcement', 'dissem', 'pdca']);
const TABLES = { announcement: 'announcements', dissem: 'quality_dissem', pdca: 'pdca_problems' };

function safeJson(s, def = []) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : def; } catch (e) { return def; }
}

// 应阅排除口径（2026-10-12 修订，与人员重分类一致）：
//   排除：游客 / 院长(dean) / 总工(chief_engineer) / 系统管理员(admin) /
//        综管 / 咨询 / 空专业（院领导、总工，按 role 已排除）/ 内部体验账号。
//   专总、室主任、各设计专业设计师均纳入应阅；仅李硕(绿建低碳)、×××(建筑专总) 按姓名单列剔除。
//   注：赵良福(77) 已转综管；咨询专业 = 综能/节能全量 + 通信(王楠/肖苏超/张昭/沈浩宇/施国华)
//       + 建筑(×××、×××)，这些人 division 已在库中置为 '咨询'，由下方 division 判断统一排除。
const isTestAccount = (u) => String(u.title_tag || '').trim() === '体验账号';
function isManagement(u) {
  if (isTestAccount(u)) return true;             // 体验账号不计入任何应阅池
  if (u.is_guest) return true;                   // 游客已在查询层剔除，双保险
  const role = u.role;
  if (['dean', 'chief_engineer', 'admin'].includes(role)) return true; // 院长/总工/管理员
  const d = (u.division || '').trim();
  if (d === '综管' || d === '咨询') return true;  // 综管 / 咨询 整建制剔除
  return false;                                  // 专总 / 室主任 / 设计师 均纳入
}

// 按姓名单列剔除（2026-10-12 裁定）：李硕(绿建低碳)、×××(建筑专总) 不计入任何应阅池；
// 其余设计师（含×××）均纳入。姓名精确匹配，改名需同步此处。
const ACK_EXCLUDED_NAMES = new Set(['李硕', '×××']);

// 取目标记录 + 标题 + require_ack（列缺省视为 1 = 要求确认）
function getTarget(type, id) {
  const tbl = TABLES[type];
  if (!tbl) return null;
  const r = db.prepare(`SELECT * FROM ${tbl} WHERE id=?`).get(Number(id));
  if (!r) return null;
  const requireAck = (r.require_ack === 0 || r.require_ack === false) ? 0 : 1;
  return { record: r, requireAck, title: r.title || '' };
}

// 计算应阅人员池（仅在 requireAck=1 时有意义）
function getPool(type, record) {
  // 在册、非游客、在岗；排除逻辑统一在 isManagement 中（游客/院领导/总工/admin/综管/咨询/体验账号）
  const users = db.prepare(
    "SELECT id, real_name, division, role, extra_roles, title_tag, is_guest FROM users WHERE is_active=1 AND COALESCE(is_guest,0)=0"
  ).all();
  // 姓名单列剔除（李硕 / ×××）统一在 pool 层生效，覆盖全员帖与专业帖两条分支
  const pool = users.filter(u => !ACK_EXCLUDED_NAMES.has(u.real_name));
  // 作者豁免（2026-10-12）：本人所发帖子，作者不进应阅池（无论是否属面向专业）
  const authorId = (type === 'pdca')
    ? (record.reporter_user_id ?? null)
    : (record.publisher_id ?? null);
  const notAuthor = (u) => u.id !== authorId;
  if (type === 'pdca') {
    // PDCA：按问题「面向专业」（divisions 数组，旧单值 division 兜底）圈定应阅池；
    // 仅该专业在册非管理岗非游客，并剔除已在帖内回复的专家（answer_by 实名）。
    // —— 不再扩展到所有设计师。divisions 为空的老数据兜底为全员（非管理岗），避免无人可阅。
    let divisions = safeJson(record.divisions);
    if (!divisions.length && (record.division || '').trim()) divisions.push((record.division || '').trim());
    const answered = db.prepare(
      "SELECT DISTINCT answer_by FROM pdca_answers WHERE problem_id=? AND answer_by IS NOT NULL AND answer_by != ''"
    ).all(record.id).map(x => x.answer_by);
    const ansSet = new Set(answered);
    const base = divisions.length ? pool.filter(u => divisions.includes(u.division)) : pool;
    return base.filter(u => notAuthor(u) && !isManagement(u) && !ansSet.has(u.real_name));
  }
  // announcement / dissem
  let divisions = [];
  if (type === 'announcement') {
    divisions = (record.scope === 'division' && record.division) ? [record.division] : [];
  } else if (type === 'dissem') {
    divisions = safeJson(record.divisions);
  }
  if (divisions.length === 0) {
    // 全员帖：所有在册设计师都要点，但剔除管理岗（专总/院长/admin/总工/综管 + 非目标专业室主任）及额外排除名单；游客已在查询中剔除
    return pool.filter(u => notAuthor(u) && !isManagement(u));
  }
  // 专业帖：仅对应专业内 + 在册 + 非游客 + 剔除管理岗 的设计师（额外排除名单已在 pool 层剔除）
  return pool.filter(u => notAuthor(u) && divisions.includes(u.division) && !isManagement(u));
}

// 取已阅记录（按确认时间正序）
function getRead(type, id) {
  return db.prepare(
    'SELECT user_id, real_name, created_at FROM read_acks WHERE target_type=? AND target_id=? ORDER BY created_at ASC, id ASC'
  ).all(type, Number(id));
}

// 批量计数：首页一屏多卡片，一次请求拉全屏已阅计数，避免 N+1
// 入参 targets=announcement:1,dissem:2,pdca:3（逗号分隔 type:id）
router.get('/counts', (req, res) => {
  const raw = (req.query.targets || '').toString();
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const valid = [];
  for (const p of parts) {
    const i = p.lastIndexOf(':');
    if (i < 0) continue;
    const type = p.slice(0, i);
    const id = Number(p.slice(i + 1));
    if (!TYPES.has(type) || !Number.isFinite(id)) continue;
    valid.push([type, id]);
  }
  const result = {};
  for (const [type, id] of valid) result[type + ':' + id] = { acked: 0, total: 0, requireAck: 1, meInPool: false, meAcked: false };
  for (const [type, id] of valid) {
    const t = getTarget(type, id);
    if (!t || t.requireAck === 0) {
      result[type + ':' + id] = { acked: 0, total: 0, requireAck: t ? t.requireAck : 0, meInPool: false, meAcked: false };
      continue;
    }
    const pool = getPool(type, t.record);
    const readRows = getRead(type, id);
    const readSet = new Set(readRows.map(r => r.user_id));
    const acked = pool.filter(u => readSet.has(u.id)).length;
    // 当前登录用户是否「应阅人」及是否已阅（用于列表缩略栏显示个人状态）
    const meInPool = !!(req.user && pool.some(u => u.id === req.user.id));
    const meAcked = meInPool && readSet.has(req.user.id);
    result[type + ':' + id] = { acked, total: pool.length, requireAck: 1, meInPool, meAcked };
  }
  res.json({ counts: result });
});

// 详情（应阅名单 / 未阅名单）
router.get('/', (req, res) => {
  const { target_type, target_id } = req.query;
  if (!TYPES.has(target_type) || !target_id) {
    return res.status(400).json({ error: '参数缺失或 target_type 非法' });
  }
  const t = getTarget(target_type, Number(target_id));
  if (!t) return res.status(404).json({ error: '目标不存在' });
  if (t.requireAck === 0) {
    return res.json({ requireAck: 0, read: [], unread: [], title: t.title });
  }
  const pool = getPool(target_type, t.record);
  const poolIds = new Set(pool.map(u => u.id));
  const readRows = getRead(target_type, Number(target_id));
  const readSet = new Set(readRows.map(r => r.user_id));
  // 应阅池内的已阅者（口径与 /counts 列表缩略一致：以 pool 为基准）
  const read = readRows
    .filter(r => poolIds.has(r.user_id))
    .map(r => ({ user_id: r.user_id, real_name: r.real_name, created_at: r.created_at }));
  // 池外点击者（如管理岗点已阅）：单独列出，不计入「应阅 X 人」统计，避免与 8/50 矛盾
  const readOthers = readRows
    .filter(r => !poolIds.has(r.user_id))
    .map(r => ({ user_id: r.user_id, real_name: r.real_name, created_at: r.created_at }));
  const unread = pool.filter(u => !readSet.has(u.id)).map(u => ({ id: u.id, real_name: u.real_name, division: u.division || '' }));
  const acked = read.length;
  const total = pool.length;
  // 当前用户是否真在应阅池（非应阅人点了已阅也会进入 readOthers，须以 pool 判定为准）
  const uid = req.user.id;
  const meInPool = pool.some(u => u.id === uid);
  // meAcked = 当前用户是否点过已阅（无论是否在池内，点了即算，用于按钮显示「你已阅」）
  const meAcked = readSet.has(uid);
  res.json({ requireAck: 1, acked, total, read, readOthers, unread, title: t.title, meInPool, meAcked });
});

// 标记已阅（任意登录用户；游客一律 403；require_ack=0 则 403；幂等）
router.post('/', (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: '游客无权标记已阅' });
  const { target_type, target_id } = req.body || {};
  if (!TYPES.has(target_type) || !target_id) {
    return res.status(400).json({ error: '参数缺失或 target_type 非法' });
  }
  const t = getTarget(target_type, Number(target_id));
  if (!t) return res.status(404).json({ error: '目标不存在' });
  if (t.requireAck === 0) return res.status(403).json({ error: '该帖未开启已阅确认' });
  const u = db.prepare('SELECT real_name FROM users WHERE id=?').get(req.user.id);
  const realName = (u && u.real_name) || req.user.realName || req.user.username;
  db.prepare(
    'INSERT OR IGNORE INTO read_acks (target_type, target_id, user_id, real_name) VALUES (?,?,?,?)'
  ).run(target_type, Number(target_id), req.user.id, realName);
  // 自动核销本人对应的「已阅提醒」站内信，使「我的」站内信与帖子已阅自洽（点了已阅就不再是待确认）
  const title = `请确认已阅：${t.title}`;
  let cleared = 0;
  try {
    const up = db.prepare(
      "UPDATE reminders SET state='done', done_at=CURRENT_TIMESTAMP WHERE recipient_id=? AND type='已阅提醒' AND title=? AND COALESCE(state,'pending')<>'done'"
    );
    const r = up.run(req.user.id, title);
    cleared = r.changes || 0;
  } catch (e) { /* 站内信核销失败不影响已阅主流程 */ }
  res.json({ ok: true, realName, cleared, message: '已标记已阅' });
});

// 提醒未阅：给未阅人批量建站内提醒（仅发布人/管理者可触发；按 发送人+接收人+标题 去重，防重复刷提醒）
router.post('/remind', (req, res) => {
  const { target_type, target_id } = req.body || {};
  if (!TYPES.has(target_type) || !target_id) {
    return res.status(400).json({ error: '参数缺失或 target_type 非法' });
  }
  const t = getTarget(target_type, Number(target_id));
  if (!t) return res.status(404).json({ error: '目标不存在' });
  if (t.requireAck === 0) return res.status(403).json({ error: '该帖未开启已阅确认' });
  const u = db.prepare('SELECT id, role, extra_roles, division FROM users WHERE id=?').get(req.user.id);
  // 仅发布人 / 管理者可提醒
  const isPublisher = (t.record.publisher_id === req.user.id) || (t.record.reporter_user_id === req.user.id);
  if (!isPublisher && !rbac.canManage(u)) {
    return res.status(403).json({ error: '仅发布人或管理者可提醒未阅' });
  }
  const pool = getPool(target_type, t.record);
  const readRows = getRead(target_type, Number(target_id));
  const readSet = new Set(readRows.map(r => r.user_id));
  const unread = pool.filter(x => !readSet.has(x.id));
  if (!unread.length) return res.json({ message: '所有人都已阅，无需提醒', created: 0 });
  const title = `请确认已阅：${t.title}`;
  const content = `「${t.title}」需要您确认已阅，请进入查看并在底部点“已阅”。`;
  const ins = db.prepare(
    `INSERT INTO reminders (sender_id, sender_name, recipient_id, recipient_name, type, title, content)
     VALUES (?, ?, ?, ?, '已阅提醒', ?, ?)`
  );
  // 去重：同 发送人+接收人+标题 且未完成的提醒已存在则跳过
  const dup = db.prepare(
    `SELECT 1 FROM reminders WHERE sender_id=? AND recipient_id=? AND type='已阅提醒' AND title=? AND COALESCE(state,'pending')<>'done' LIMIT 1`
  );
  let created = 0;
  const tx = db.transaction(() => {
    for (const x of unread) {
      if (dup.get(req.user.id, x.id, title)) continue;
      ins.run(req.user.id, req.user.realName || req.user.username, x.id, x.real_name, title, content);
      created++;
    }
  });
  tx();
  res.json({ message: `已向 ${created} 位未阅人发送提醒`, created });
});

module.exports = router;
