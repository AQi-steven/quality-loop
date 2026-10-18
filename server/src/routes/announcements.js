/**
 * 公告路由（首页展示 + 管理者发布/删除）
 *
 *  scope 控制发布范围：
 *    - all     全员公告：仅院长 + 专总（canPublishAll）可发，所有人可见
 *    - division 专业室公告：室主任（canPublishDivision，锁定本室）或院长/专总（canPublishDivision，任选目标室）可发；
 *                          可见范围 = 本室设计师 + 所有管理者
 *
 *   GET    /announcements        列表（按 viewer 过滤，最多 30 条；置顶优先，置顶覆盖公示期）
 *   GET    /announcements/divisions  专业室列表（供院长发布专业室公告时选择）
 *   POST   /announcements        发布（按 scope 校验权限）
 *   POST   /announcements/:id/pin 置顶/取消置顶（仅超级管理员）
 *   DELETE /announcements/:id    删除（仅管理者）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');
const { visibleDivisions, orderDivisions } = require('../divisions');
const ima = require('../ima');

const router = express.Router();
router.use(authMiddleware);

// 列表接口硬上限（#537）：分页 limit 服务端 clamp，防 ?limit=99999 一次性把表全拉回客户端 OOM。
const MAX_LIST_LIMIT = 200;

// 取当前用户完整信息（含 division、extra_roles 用于权限判定）
function me(req) {
  return db.prepare('SELECT id, role, extra_roles, division, username FROM users WHERE id = ?').get(req.user.id);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
// 公示期计算：自定义日期优先；否则按天数累加。2026-09-13 取消「长久（永久）」选项，默认 2 个月（60 天）。
// 'long'/'长久'/非法值一律按 60 天处理，不再生成永久不过期的帖子。
function computeExpiry(pub, durationDays, expiry_date) {
  if (expiry_date && String(expiry_date).trim()) return String(expiry_date).trim().slice(0, 10);
  const d = Number(durationDays);
  const days = (Number.isFinite(d) && d > 0) ? d : 60;
  return addDays(pub, days);
}

// 自动归档：过期且仍 active 的公告 → archived（列表对所有角色隐藏，含管理者；质量库沉淀保留，与宣贯一致）
// 2026-09-11 用户确认：归档帖即使管理者也不在列表展示；如需重置公示期，可经详情接口（管理者仍可访问）PUT expiry_date 恢复。
function autoArchive() {
  db.prepare("UPDATE announcements SET status='archived' WHERE status='active' AND expiry_date IS NOT NULL AND date(expiry_date) < date('now')").run();
}

router.get('/', (req, res) => {
  autoArchive();
  const { limit = '', offset = '' } = req.query;
  // 排序：置顶（pinned DESC）优先于一切，其次按发布时间倒序 ——
  // 即置顶组内部「较晚发布的排更前」（满足「除非后一条也有置顶」）。
  let sql = 'SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC';
  if (limit !== '' && Number(limit) > 0) {
    sql += ' LIMIT ' + Math.min(Number(limit), MAX_LIST_LIMIT);
    const off = Math.max(0, parseInt(offset, 10) || 0);
    if (off > 0) sql += ' OFFSET ' + off;
  } else {
    sql += ' LIMIT 30';
  }
  const rows = db.prepare(sql).all();
  const u = me(req);
  const canManage = rbac.canManage(u);
  const canPin = rbac.isSuperAdmin(u);   // 置顶权仅超级管理员（2026-09-14）
  const list = rows.filter((r) => {
    if (r.status === 'deleted') return false; // 软删（#542.3）：所有人都不再看到已删除的公告
    // 公示期满（归档）：默认对所有人隐藏（含管理者）；但「置顶」公告覆盖公示期，照常展示（2026-09-14 超级管理员决策）
    if (r.status && r.status !== 'active' && !r.pinned) return false;
    if (canManage || rbac.hasAllDivisions(u)) return true; // 管理者 / 院领导（专总·院长）看全部专业室公告
    if (!r.scope || r.scope === 'all') return true;   // 全员公告人人可见
    return !!r.division && r.division === u.division;  // 专业室公告仅本室设计师可见
  }).map((r) => ({ ...r, pinned: r.pinned ? 1 : 0, canEdit: rbac.canEditContent(u, r), canDelete: rbac.isSuperAdmin(u) || (r.publisher_id === u.id), canPin }));
  res.json(list);
});

// 专业列表（规范化：专业室→专业，并排除暂不参与的专业）
router.get('/divisions', (req, res) => {
  const rows = db.prepare(
    "SELECT DISTINCT division FROM users WHERE division IS NOT NULL AND division != ''"
  ).all();
  res.json(orderDivisions(rows.map(r => r.division)));
});

// 详情（点击卡片展开查看全文）
router.get('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '公告不存在' });
  if (r.status === 'deleted') return res.status(404).json({ error: '公告不存在' }); // 软删（#542.3）：详情接口也对删除项返回 404
  const u = me(req);
  // P5 可见性过滤：与 GET / 列表口径一致，非管理者 / 非院领导看受限范围
  // 注意（2026-10-11）：归档(archived)只表示「首页不再展示、质量库沉淀保留」，
  //   不等于「内容不可见」。原先这里对 status!=='active' 一律 403，导致专题里已关联的
  //   归档公告设计师一点就报「该公告不可见」，专题沉淀价值尽失。
  //   现口径：只要未删除(已在上方拦截)都允许直达查看，仍保留 scope/专业室越权校验；
  //   pending(待审核) 等未放出状态仍按原逻辑对非管理者隐藏。
  if (!rbac.canManage(u) && !rbac.hasAllDivisions(u)) {
    if (r.status && r.status !== 'active' && r.status !== 'archived') return res.status(403).json({ error: '该公告不可见' });
    if (r.scope && r.scope !== 'all' && r.division !== u.division) return res.status(403).json({ error: '该公告不可见' });
  }
  try { r.attachments = r.attachments ? JSON.parse(r.attachments) : []; } catch (e) { r.attachments = []; }
  try { r.photos = r.photos ? JSON.parse(r.photos) : []; } catch (e) { r.photos = []; }
  r.pinned = r.pinned ? 1 : 0;
  r.canEdit = rbac.canEditContent(u, r);
  r.canPin = rbac.isSuperAdmin(u);
  res.json(r);
});

// 发布（按 scope 校验权限）
router.post('/', async (req, res) => {
  if (!rbac.isSuperAdmin(req.user) && !rbac.rolesOf(req.user).includes('chief')) return res.status(403).json({ error: '仅超级管理员与专总可发布公告' });
  const { title, content, scope, division: bodyDiv, attachments = [], photos = [], durationDays = 60, expiry_date = '', publish_date = '', require_ack = 1 } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: '标题和内容为必填' });

  const s = scope === 'division' ? 'division' : 'all';
  const publisher = req.user.realName;
  const u = me(req);
  let division = null;

  if (s === 'division') {
    if (!rbac.isSuperAdmin(req.user) && !rbac.rolesOf(req.user).includes('chief')) return res.status(403).json({ error: '仅超级管理员与专总可发专业室公告' });
    const u = me(req);
    const roles = rbac.rolesOf(u);
    // 院长/专总（含双身份的专总·室主任）= 自由选室；纯室主任锁定本室
    const isFree = rbac.isSuperAdmin(req.user) || roles.includes('chief') || roles.includes('dean');
    if (isFree) {
      division = (bodyDiv || '').trim();       // 院长/专总：任选目标室
      if (!division) return res.status(400).json({ error: '请选择目标专业室' });
    } else {
      division = u.division;                    // 室主任：锁定本室
      if (!division) return res.status(400).json({ error: '室主任未归属专业室，无法发布专业室公告' });
    }
  } else {
    if (!rbac.isSuperAdmin(req.user) && !rbac.rolesOf(req.user).includes('chief')) return res.status(403).json({ error: '仅超级管理员与专总可发全员公告' });
  }

  // 规范化 attachments / photos：仅保留 {url,name} 结构
  const atts = Array.isArray(attachments)
    ? attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }))
    : [];
  const phs = Array.isArray(photos)
    ? photos.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }))
    : [];

  // 发布时间周期（公示期），与质量宣贯一致：默认「2 个月」，可自定义到期日或选固定期限（1周/1月/3月）
  const pub = (publish_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const exp = computeExpiry(pub, durationDays, expiry_date);

  const info = db.prepare(
    'INSERT INTO announcements (title, content, publisher, publisher_id, publisher_role, scope, division, attachments, photos, ima_synced, publish_date, expiry_date, status, require_ack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title.trim(), content.trim(), publisher, u.id, u.role, s, division, JSON.stringify(atts), JSON.stringify(phs), 0, pub, exp, 'active', (require_ack === 0 || require_ack === false) ? 0 : 1);
  const newId = info.lastInsertRowid;
  const createdAt = (db.prepare('SELECT created_at FROM announcements WHERE id=?').get(newId) || {}).created_at || '';

  // 自动同步到 IMA「00千里行质量公告」文件夹（docx + 附件，按文件夹聚合）
  let imaUrl = '';
  let imaSynced = false;
  try {
    const r = await ima.pushAnnouncement({
      id: newId, title: title.trim(), content: content.trim(),
      publisher, scope: s, division, attachments: atts,
      created_at: createdAt, existingFolderId: null, publishDate: pub, expiryDate: exp,
    });
    imaUrl = r.url || '';
    imaSynced = !!(r && r.media_id);
    if (imaSynced) {
      db.prepare('UPDATE announcements SET ima_synced=1 WHERE id=?').run(newId);
      if (r.folderId) db.prepare('UPDATE announcements SET ima_folder_id=? WHERE id=?').run(r.folderId, newId);
    }
  } catch (e) { console.error('[公告] IMA 同步失败：', e.message); }

  res.json({ id: newId, message: '已发布', imaUrl, imaSynced });
});

// 编辑（已发布内容修订：修正错别字等）
// 权限：canEditContent —— 院长改全部；专总/室主任改自己+设计师发的；设计师不能改已发布
// 仅更新 标题/内容/图片/附件；scope/division 保持不变（避免重新走发布权限）。
// 注意：本地修订生效，IMA「00千里行质量公告」中的旧副本不会自动同步（IMA 无更新接口，重推会重复）。
router.put('/:id', (req, res) => {
  const u = me(req);
  const r = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '公告不存在' });
  if (!rbac.canEditContent(u, r)) return res.status(403).json({ error: '无权限修改该公告' });
  const { title, content, attachments, photos, durationDays, expiry_date, require_ack } = req.body || {};
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: '标题不能为空' });
    db.prepare('UPDATE announcements SET title=? WHERE id=?').run(String(title).trim(), r.id);
  }
  if (content !== undefined) {
    if (!String(content).trim()) return res.status(400).json({ error: '内容不能为空' });
    db.prepare('UPDATE announcements SET content=? WHERE id=?').run(String(content).trim(), r.id);
  }
  if (Array.isArray(attachments)) {
    const atts = attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }));
    db.prepare('UPDATE announcements SET attachments=? WHERE id=?').run(JSON.stringify(atts), r.id);
  }
  if (Array.isArray(photos)) {
    const phs = photos.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }));
    db.prepare('UPDATE announcements SET photos=? WHERE id=?').run(JSON.stringify(phs), r.id);
  }
  // 允许修改公示期：长久 → 空串（永久）；否则按天数 / 自定义日期；并据此重置 active/archived
  if (durationDays !== undefined || expiry_date !== undefined) {
    const pub = (r.publish_date || r.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const exp = computeExpiry(pub, durationDays, expiry_date);
    db.prepare('UPDATE announcements SET expiry_date=? WHERE id=?').run(exp, r.id);
    const now = new Date().toISOString().slice(0, 10);
    const active = !exp || exp >= now;
    db.prepare("UPDATE announcements SET status=? WHERE id=?").run(active ? 'active' : 'archived', r.id);
  }
  // 允许事后修改「是否需要已阅确认」（超级管理员/管理者/发布人均可在修改公告时切换）
  if (require_ack !== undefined) {
    const v = (require_ack === 0 || require_ack === false) ? 0 : 1;
    db.prepare('UPDATE announcements SET require_ack=? WHERE id=?').run(v, r.id);
  }
  res.json({ message: '已保存修改' });
});

// 删除（仅管理者；非超管/全员发布者仅可删本人发布的，与宣贯删除口径对齐，避免室主任误删他人/院长公告）
// 软删（#542.3）：改为 status='deleted'，保留审计追溯；列表/详情接口统一排除
router.delete('/:id', (req, res) => {
  const u = req.user;
  const a = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  if (a.status === 'deleted') return res.status(400).json({ error: '公告已删除' });
  // 删除权限（2026-09 收窄）：超级管理员可删任意公告；发布人仅可删本人发布的；其余（专总/院长/室主任/管理员）一律禁止
  if (!rbac.isSuperAdmin(u) && a.publisher_id !== u.id) return res.status(403).json({ error: '仅超级管理员可删除他人公告，或仅可删除本人发布的公告' });
  db.prepare("UPDATE announcements SET status='deleted' WHERE id=?").run(req.params.id);
  res.json({ message: '已删除' });
});

// 置顶 / 取消置顶（2026-09-14）：**仅超级管理员** 可操作（发布仍为超级管理员+专总，但置顶权收窄到超级管理员一人）
// 语义：pinned=1 → 列表恒排第一位；且「覆盖公示期」——即使已到期归档(status='archived')仍显示在主页，直至手动取消置顶。
// body.pinned 省略时按当前值取反（切换）。
router.post('/:id/pin', (req, res) => {
  const u = req.user;
  if (!rbac.isSuperAdmin(u)) return res.status(403).json({ error: '仅超级管理员可置顶公告' });
  const a = db.prepare('SELECT * FROM announcements WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  if (a.status === 'deleted') return res.status(400).json({ error: '公告已删除，无法置顶' });
  const pinned = (req.body && req.body.pinned !== undefined) ? (req.body.pinned ? 1 : 0) : (a.pinned ? 0 : 1);
  db.prepare('UPDATE announcements SET pinned=?, pinned_at=? WHERE id=?')
    .run(pinned, pinned ? new Date().toISOString() : null, a.id);
  // 审计留痕（关键动作，与闭环/院选等一致）
  try {
    db.prepare('INSERT INTO audit_log (actor, actor_role, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)')
      .run(u.realName || u.username || '', u.role || '', pinned ? 'announcement_pin' : 'announcement_unpin', 'announcement', String(a.id), a.title || '');
  } catch (e) { /* 留痕失败不影响置顶 */ }
  res.json({ id: a.id, pinned: !!pinned, message: pinned ? '已置顶' : '已取消置顶' });
});

module.exports = router;
