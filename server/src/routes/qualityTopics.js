/**
 * 质量专题：主题主页、阶段动态、已发布内容关联。
 * 第一阶段不复制公告/宣贯/PDCA正文，专题仅保存引用关系。
 */
const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

const TARGET_TABLES = {
  announcement: 'announcements',
  dissem: 'quality_dissem',
  pdca: 'pdca_problems',
  flower: 'flower_adjustments', // 专题红花：链接「红花奖惩台账」(只引用、不复制、不重发)
};
const POST_TYPES = new Set(['启动说明', '阶段进展', '问题案例', '整改措施', '活动报道', '成果发布', '阶段总结']);

function me(req) {
  return db.prepare('SELECT id, real_name, role, extra_roles, division, username, is_guest FROM users WHERE id=?').get(req.user.id);
}
function arr(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function clean(value, max = 20000) {
  return String(value == null ? '' : value).replace(/[<>]/g, '').trim().slice(0, max);
}
function cleanJson(value, maxItems = 100) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map(x => typeof x === 'object' ? x : String(x)).filter(Boolean);
}
// 权限三层（2026-10-09 用户裁定，2026-10-10 放宽建专题权限）：
//   建壳（创建专题）                          → 超级管理员 + 院长/专总/室主任（复用 rbac.canPublishDissem）
//   改专题信息 / 发布上线 / 下线                → 作者本人 + 超级管理员
//   置顶 / 归档 / 删除（含专题置顶）            → 超级管理员 + 副院长×××（2026-10-10 裁定）
//   填内容（发动态 / 改自己的动态 / 关联内容）   → 超级管理员 + 院长/专总/室主任（复用 rbac.canPublishDissem，不另造角色判断）
//   看内容（未发布草稿）                       → 仅作者本人 + 超级管理员 + 副院长×××
// 游客一律只读；普通设计师在本模块无任何写权限。
const canContribute = (u) => !u.is_guest && rbac.canPublishDissem(u);
// 专题管理权（删/置顶/改他人/看全部状态）：超级管理员 + 副院长×××，仅限本模块（不影响公告/宣贯/PDCA 全局管理权）
const canAdminister = (u) => !u.is_guest && (rbac.isSuperAdmin(u) || u.username === 'shenxiangming' || u.realName === '×××');
// 红花（引用「红花奖惩台账」）的**选与挂**权限：2026-10-10 用户明确「只能超级管理员做，其他人不给权限」。
//   与 canContribute 解耦——专总/室主任仍可发动态、关联公告/宣贯/PDCA，但不能挂红花。
//   注意：这只限制"谁来挂"；已挂上去的明细按用户 2026-10-10 裁定「保持全员可见」，任何人都能点开看。
const canManageFlower = (u) => !u.is_guest && rbac.isSuperAdmin(u);
// 改专题信息 / 发布 / 下线：作者本人 + 超级管理员
const canEditTopic = (u, topic) => canAdminister(u) || (topic && topic.owner_id === u.id);
// 动态的可见性：已发布全员可见；草稿仅作者 + 超级管理员
function canSeePost(u, post) {
  if (post.status === 'published') return true;
  if (post.status === 'deleted') return post.author_id === u.id || canAdminister(u);
  return post.author_id === u.id || canAdminister(u);
}
function parseTopic(row, u) {
  if (!row) return row;
  return { ...row, divisions: arr(row.divisions), require_ack: row.require_ack ? 1 : 0,
    color: (row.color || '') + '', pinned: row.pinned ? 1 : 0, pinned_at: row.pinned_at || '',
    canEdit: canEditTopic(u, row), canManage: canAdminister(u), canContribute: canContribute(u), canPin: canAdminister(u),
    canManageFlower: canManageFlower(u) };
}
function parsePost(row) {
  return row ? { ...row, photos: arr(row.photos), attachments: arr(row.attachments), is_pinned: row.is_pinned ? 1 : 0 } : row;
}
function topicOr404(req, res) {
  const topic = db.prepare('SELECT * FROM quality_topics WHERE id=?').get(Number(req.params.id));
  if (!topic) { res.status(404).json({ error: '专题不存在' }); return null; }
  return topic;
}
function sourceExists(type, id) {
  const table = TARGET_TABLES[type];
  if (!table || !Number.isInteger(Number(id)) || Number(id) <= 0) return false;
  // flower_adjustments 无 status 软删字段，单独处理（仅按 id 校验存在性）
  if (type === 'flower') return !!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(Number(id));
  return !!db.prepare(`SELECT id FROM ${table} WHERE id=? AND status <> 'deleted'`).get(Number(id));
}

router.get('/', (req, res) => {
  const u = me(req);
  const kw = clean(req.query.kw || '', 200);
  const status = clean(req.query.status || '', 20);
  const args = [];
  let sql = `SELECT t.*, (SELECT COUNT(*) FROM quality_topic_posts p WHERE p.topic_id=t.id AND p.status='published') AS post_count,
    (SELECT COUNT(*) FROM quality_topic_items i WHERE i.topic_id=t.id) AS item_count,
    (SELECT MAX(COALESCE(p.published_at,p.created_at)) FROM quality_topic_posts p WHERE p.topic_id=t.id AND p.status='published') AS last_post_at
    FROM quality_topics t WHERE t.status <> 'deleted'`;
  if (status && ['draft','active','archived'].includes(status)) { sql += ' AND t.status=?'; args.push(status); }
  // 可见性：超级管理员看全部；作者本人可见自己建的任何状态；其他人仅看已上线专题
  else if (canAdminister(u)) { /* 不限状态 */ }
  else { sql += " AND (t.status='active' OR t.owner_id=?)"; args.push(u.id); }
  if (kw) { sql += ' AND (t.title LIKE ? OR t.code LIKE ? OR t.summary LIKE ?)'; const like = `%${kw}%`; args.push(like, like, like); }
  sql += ' ORDER BY t.pinned DESC, CASE WHEN t.status=\'active\' THEN 0 WHEN t.status=\'draft\' THEN 1 ELSE 2 END, COALESCE(last_post_at,t.updated_at,t.created_at) DESC, t.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args).map(x => parseTopic(x, u)));
});

router.get('/:id', (req, res) => {
  const u = me(req); const topic = topicOr404(req, res); if (!topic) return;
  // 专题本体：未上线（draft/archived）仅作者本人 + 超级管理员可见；已上线全员可见
  if (topic.status === 'deleted') return res.status(404).json({ error: '专题不存在' });
  if (topic.status !== 'active' && !canAdminister(u) && topic.owner_id !== u.id) return res.status(404).json({ error: '专题不存在' });
  // 动态：已发布全员可见；草稿仅作者本人 + 超级管理员（用户裁定：其他管理者看不到同侪草稿）
  const all = db.prepare("SELECT * FROM quality_topic_posts WHERE topic_id=? AND status<>'deleted' ORDER BY is_pinned DESC, COALESCE(published_at,created_at) DESC, id DESC").all(topic.id);
  const posts = all.filter(p => canSeePost(u, p)).map(p => ({ ...parsePost(p), canEdit: p.author_id === u.id || canAdminister(u), canPin: canAdminister(u) }));
  const items = db.prepare(`SELECT i.*, CASE i.target_type WHEN 'announcement' THEN a.title WHEN 'dissem' THEN d.title WHEN 'pdca' THEN p.title WHEN 'flower' THEN (fa.target_name || ' ' || (CASE WHEN fa.delta>0 THEN '+' ELSE '' END) || fa.delta || '朵 · ' || COALESCE(fa.reason,'')) END AS target_title,
    CASE i.target_type WHEN 'announcement' THEN a.status WHEN 'dissem' THEN d.status WHEN 'pdca' THEN p.status ELSE NULL END AS target_status,
    fa.target_name AS fl_name, fa.delta AS fl_delta, fa.reason AS fl_reason, strftime('%Y-%m-%d %H:%M', fa.created_at, '+8 hours') AS fl_created,
    CASE i.target_type WHEN 'announcement' THEN CASE WHEN a.division IS NULL OR TRIM(a.division)='' THEN '[]' ELSE json_array(a.division) END
      WHEN 'dissem' THEN CASE WHEN d.divisions IS NULL OR TRIM(d.divisions)='' THEN '[]' ELSE d.divisions END
      WHEN 'pdca' THEN CASE WHEN p.divisions IS NOT NULL AND TRIM(p.divisions) NOT IN ('','[]') THEN p.divisions WHEN p.division IS NULL OR TRIM(p.division)='' THEN '[]' ELSE json_array(p.division) END
      ELSE '[]' END AS item_divisions
    FROM quality_topic_items i LEFT JOIN announcements a ON i.target_type='announcement' AND a.id=i.target_id
    LEFT JOIN quality_dissem d ON i.target_type='dissem' AND d.id=i.target_id
    LEFT JOIN pdca_problems p ON i.target_type='pdca' AND p.id=i.target_id
    LEFT JOIN flower_adjustments fa ON i.target_type='flower' AND fa.id=i.target_id
    WHERE i.topic_id=? ORDER BY i.sort_order ASC, i.id ASC`).all(topic.id)
    // 每条附canUnlink：前端据此决定是否显示 ✕（红花仅超级管理员可撤；其余"谁挂谁撤 + 超级管理员/专总"）
    .map(it => ({ ...it, canUnlink: it.target_type === 'flower'
      ? canManageFlower(u)
      : (it.created_by === u.id || rbac.isSuperAdmin(u) || rbac.rolesOf(u).includes('chief')) }));
  res.json({ topic: parseTopic(topic, u), posts, items });
});

// 可关联内容候选池：跨公告/宣贯/PDCA/红花 一次搜完，已关联的自动剔除。
// 公告/宣贯/PDCA 候选对游客也开放浏览；但「红花」候选仅超级管理员/副院长/院长专总室主任可见，
// 避免向普通设计师、游客泄露「红花奖惩台账」。真正写入仍由 POST /:id/items 把关（flower 要求 canContribute）。
router.get('/:id/linkable', (req, res) => {
  const u = me(req); const topic = topicOr404(req, res); if (!topic) return;
  const kw = clean(req.query.kw || '', 200);
  const only = clean(req.query.type || '', 20);
  const linked = new Set(db.prepare('SELECT target_type, target_id FROM quality_topic_items WHERE topic_id=?').all(topic.id)
    .map(r => r.target_type + '#' + r.target_id));
  const like = `%${kw}%`;
  const out = [];
  const push = (type, rows) => { for (const r of rows) if (!linked.has(type + '#' + r.id)) out.push({ ...r, target_type: type }); };
  // 公告：排除软删；置顶与归档都保留可选（归档内容仍值得挂到专题上做沉淀）
  if (!only || only === 'announcement') {
    const args = []; let sql = "SELECT id, title, publisher, status, created_at, CASE WHEN division IS NULL OR TRIM(division)='' THEN '[]' ELSE json_array(division) END AS divisions FROM announcements WHERE status<>'deleted'";
    if (kw) { sql += ' AND title LIKE ?'; args.push(like); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    push('announcement', db.prepare(sql).all(...args));
  }
  // 宣贯：含 active / archived（到期进质量库的内容同样可挂）
  if (!only || only === 'dissem') {
    const args = []; let sql = "SELECT id, title, publisher, category, status, created_at, CASE WHEN divisions IS NULL OR TRIM(divisions)='' THEN '[]' ELSE divisions END AS divisions FROM quality_dissem WHERE status<>'deleted'";
    if (kw) { sql += ' AND title LIKE ?'; args.push(like); }
    sql += ' ORDER BY COALESCE(reviewed_at, created_at) DESC, id DESC LIMIT 50';
    push('dissem', db.prepare(sql).all(...args));
  }
  // PDCA：标题 + 工单号一起搜，便于直接粘贴 QC 编号定位
  if (!only || only === 'pdca') {
    const args = []; let sql = "SELECT id, code, title, reporter, status, created_at, CASE WHEN divisions IS NOT NULL AND TRIM(divisions) NOT IN ('','[]') THEN divisions WHEN division IS NULL OR TRIM(division)='' THEN '[]' ELSE json_array(division) END AS divisions FROM pdca_problems WHERE 1=1";
    if (kw) { sql += ' AND (title LIKE ? OR code LIKE ?)'; args.push(like, like); }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT 50';
    push('pdca', db.prepare(sql).all(...args));
  }
  // 红花奖惩记录：仅超级管理员可浏览候选（2026-10-10 用户裁定：链接红花只能超级管理员做）。
  //   ⚠️ 只有**显式 type=flower**（专题小红花区的「＋ 关联红花」按钮）才返回；
  //   「＋ 关联内容」里的「全部」列表**刻意不含红花**——红花只在下方专属栏目挂载，避免两处重复。
  if (only === 'flower') {
    if (canManageFlower(u)) {
      const args = [];
      let sql = "SELECT id, (target_name || ' ' || (CASE WHEN delta>0 THEN '+' ELSE '' END) || delta || '朵 · ' || COALESCE(reason,'')) AS title, target_name, delta, reason, operator_name, strftime('%Y-%m-%d %H:%M', created_at, '+8 hours') AS created_at FROM flower_adjustments WHERE 1=1";
      if (kw) { sql += ' AND (reason LIKE ? OR target_name LIKE ? OR operator_name LIKE ?)'; args.push(like, like, like); }
      sql += ' ORDER BY created_at DESC, id DESC LIMIT 50';
      push('flower', db.prepare(sql).all(...args));
    }
  }
  res.json(out);
});

router.post('/', (req, res) => {
  const u = me(req); if (!canAdminister(u) && !canContribute(u)) return res.status(403).json({ error: '仅超级管理员与院长/专总/室主任可创建质量专题' });
  const b = req.body || {}; const title = clean(b.title, 200); if (!title) return res.status(400).json({ error: '专题标题为必填' });
  const info = db.prepare(`INSERT INTO quality_topics (code,title,summary,cover,color,status,owner_id,owner_name,scope,divisions,require_ack,publish_date,expiry_date,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?,datetime('now'))`).run(clean(b.code, 60), title, clean(b.summary, 2000), clean(b.cover, 1000), clean(b.color, 20), 'draft', u.id, u.real_name || req.user.realName || '', b.scope === 'division' ? 'division' : 'all', JSON.stringify(cleanJson(b.divisions, 30)), b.require_ack ? 1 : 0, b.publish_date || null, b.expiry_date || null);
  res.status(201).json(parseTopic(db.prepare('SELECT * FROM quality_topics WHERE id=?').get(info.lastInsertRowid), u));
});

router.put('/:id', (req, res) => {
  const u = me(req); const topic = topicOr404(req, res); if (!topic) return;
  if (!canEditTopic(u, topic)) return res.status(403).json({ error: '仅专题创建人或超级管理员可编辑质量专题' });
  const b = req.body || {}; const fields = []; const args = [];
  const textFields = [['code',60],['title',200],['summary',2000],['cover',1000],['color',20],['scope',20],['publish_date',20],['expiry_date',20]];
  for (const [key,max] of textFields) if (b[key] !== undefined) { fields.push(`${key}=?`); args.push(clean(b[key], max) || (key === 'scope' ? 'all' : null)); }
  if (b.divisions !== undefined) { fields.push('divisions=?'); args.push(JSON.stringify(cleanJson(b.divisions, 30))); }
  if (b.require_ack !== undefined) { fields.push('require_ack=?'); args.push(b.require_ack ? 1 : 0); }
  if (b.status !== undefined && ['draft','active','archived','deleted'].includes(String(b.status))) { fields.push('status=?'); args.push(String(b.status)); if (b.status === 'active' && !topic.publish_date) { fields.push("publish_date=datetime('now')"); } }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  fields.push("updated_at=datetime('now')"); args.push(topic.id); db.prepare(`UPDATE quality_topics SET ${fields.join(',')} WHERE id=?`).run(...args);
  res.json(parseTopic(db.prepare('SELECT * FROM quality_topics WHERE id=?').get(topic.id), u));
});

// 专题置顶：仅超级管理员可操作（置顶/取消），与动态置顶分开治理
router.post('/:id/pin', (req, res) => {
  const u = me(req); if (!canAdminister(u)) return res.status(403).json({ error: '仅超级管理员可置顶质量专题' });
  const topic = topicOr404(req, res); if (!topic) return;
  if (topic.status === 'deleted') return res.status(400).json({ error: '已删除的专题不可置顶' });
  const pin = req.body && req.body.pinned ? 1 : 0;
  db.prepare("UPDATE quality_topics SET pinned=?, pinned_at=?, updated_at=datetime('now') WHERE id=?").run(pin, pin ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, topic.id);
  res.json(parseTopic(db.prepare('SELECT * FROM quality_topics WHERE id=?').get(topic.id), u));
});

router.post('/:id/posts', (req, res) => {
  const u = me(req); if (!canContribute(u)) return res.status(403).json({ error: '无权限发布专题动态' });
  const topic = topicOr404(req, res); if (!topic) return;
  if (topic.status === 'deleted' || (topic.status === 'archived' && !canAdminister(u))) return res.status(403).json({ error: '该专题已归档，不能再发动态' });
  const b = req.body || {}; const title = clean(b.title, 200); const content = clean(b.content, 50000);
  if (!title && !content) return res.status(400).json({ error: '动态标题或正文至少填写一项' });
  const type = POST_TYPES.has(String(b.post_type)) ? String(b.post_type) : '阶段进展';
  // 存草稿 or 直接发布：草稿仅作者 + 超级管理员可见（用户裁定）
  const asDraft = String(b.status || 'published') === 'draft';
  const info = db.prepare(`INSERT INTO quality_topic_posts (topic_id,title,content,post_type,photos,attachments,author_id,author_name,status,published_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(topic.id, title, content, type, JSON.stringify(cleanJson(b.photos)), JSON.stringify(cleanJson(b.attachments)), u.id, u.real_name || req.user.realName || '', asDraft ? 'draft' : 'published', asDraft ? null : new Date().toISOString().slice(0, 19).replace('T', ' '));
  db.prepare("UPDATE quality_topics SET updated_at=datetime('now') WHERE id=?").run(topic.id);
  res.status(201).json(parsePost(db.prepare('SELECT * FROM quality_topic_posts WHERE id=?').get(info.lastInsertRowid)));
});

router.put('/:id/posts/:postId', (req, res) => {
  const u = me(req); if (!canContribute(u)) return res.status(403).json({ error: '无权限编辑专题动态' });
  const topic = topicOr404(req, res); if (!topic) return;
  const post = db.prepare('SELECT * FROM quality_topic_posts WHERE id=? AND topic_id=?').get(Number(req.params.postId), topic.id);
  if (!post || post.status === 'deleted') return res.status(404).json({ error: '动态不存在' });
  if (!canAdminister(u) && post.author_id !== u.id) return res.status(403).json({ error: '只能编辑自己发布的动态' });
  const b = req.body || {}; const fields=[]; const args=[];
  for (const [key,max] of [['title',200],['content',50000]]) if (b[key] !== undefined) { fields.push(`${key}=?`); args.push(clean(b[key],max)); }
  if (b.post_type !== undefined) { fields.push('post_type=?'); args.push(POST_TYPES.has(String(b.post_type)) ? String(b.post_type) : '阶段进展'); }
  if (b.photos !== undefined) { fields.push('photos=?'); args.push(JSON.stringify(cleanJson(b.photos))); }
  if (b.attachments !== undefined) { fields.push('attachments=?'); args.push(JSON.stringify(cleanJson(b.attachments))); }
  // 草稿 → 发布（补 published_at）；已发布 → 收回为草稿
  if (b.status !== undefined && ['draft','published'].includes(String(b.status))) {
    fields.push('status=?'); args.push(String(b.status));
    fields.push('published_at=?'); args.push(String(b.status) === 'published' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null);
  }
  if (b.is_pinned !== undefined) { if (!canAdminister(u)) return res.status(403).json({ error: '仅超级管理员可置顶动态' }); fields.push('is_pinned=?'); args.push(b.is_pinned ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  fields.push("updated_at=datetime('now')"); args.push(post.id); db.prepare(`UPDATE quality_topic_posts SET ${fields.join(',')} WHERE id=?`).run(...args);
  res.json(parsePost(db.prepare('SELECT * FROM quality_topic_posts WHERE id=?').get(post.id)));
});

router.delete('/:id/posts/:postId', (req, res) => {
  const u = me(req); if (!canContribute(u)) return res.status(403).json({ error: '无权限删除专题动态' });
  const topic = topicOr404(req, res); if (!topic) return; const post = db.prepare('SELECT * FROM quality_topic_posts WHERE id=? AND topic_id=?').get(Number(req.params.postId), topic.id);
  if (!post || post.status === 'deleted') return res.status(404).json({ error: '动态不存在' });
  if (!canAdminister(u) && post.author_id !== u.id) return res.status(403).json({ error: '只能删除自己发布的动态' });
  db.prepare("UPDATE quality_topic_posts SET status='deleted',updated_at=datetime('now') WHERE id=?").run(post.id); res.json({ ok:true });
});

router.post('/:id/items', (req, res) => {
  const u = me(req); if (!canContribute(u)) return res.status(403).json({ error: '无权限关联质量内容' });
  const topic = topicOr404(req, res); if (!topic) return;
  if (topic.status === 'deleted' || (topic.status === 'archived' && !canAdminister(u))) return res.status(403).json({ error: '该专题已归档，不能再关联内容' });
  const type = String(req.body && req.body.target_type || ''); const targetId = Number(req.body && req.body.target_id);
  if (!Object.prototype.hasOwnProperty.call(TARGET_TABLES,type) || !Number.isInteger(targetId) || !sourceExists(type,targetId)) return res.status(400).json({ error: '关联内容不存在或类型无效' });
  // 红花台账的挂载仅超级管理员（与 canContribute 解耦：专总/室主任可挂公告宣贯PDCA，不能挂红花）
  if (type === 'flower' && !canManageFlower(u)) return res.status(403).json({ error: '红花奖惩记录仅超级管理员可关联到专题' });
  try {
    const info = db.prepare('INSERT INTO quality_topic_items (topic_id,target_type,target_id,sort_order,is_required,created_by) VALUES (?,?,?,?,?,?)').run(topic.id,type,targetId,Number(req.body.sort_order)||0,req.body.is_required?1:0,u.id);
    res.status(201).json(db.prepare('SELECT * FROM quality_topic_items WHERE id=?').get(info.lastInsertRowid));
  } catch (e) { if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '该内容已关联到专题' }); throw e; }
});

router.delete('/:id/items/:itemId', (req, res) => {
  const u = me(req);
  const topic = topicOr404(req, res); if (!topic) return;
  const item = db.prepare('SELECT * FROM quality_topic_items WHERE id=? AND topic_id=?').get(Number(req.params.itemId), topic.id);
  if (!item) return res.status(404).json({ error: '关联不存在' });
  // 取消关联（2026-10-10 用户裁定：**谁关联的谁可以取消，另加超级管理员与专总兜底**）：
  //   ① 红花：挂载本身仅超级管理员可做（canManageFlower），故也只能超级管理员撤——红花不适用"谁挂谁撤"。
  //   ② 公告/宣贯/PDCA：item.created_by === u.id（谁挂谁撤）或 超级管理员（rbac.isSuperAdmin）或 专总（role含 chief，含 extra_roles 叠加）。
  //   注：不再以 canContribute 作为前置门槛——否则"设计师自己挂的"反撤不掉（且设计师本就无法挂）。
  if (item.target_type === 'flower') {
    if (!canManageFlower(u)) return res.status(403).json({ error: '红花奖惩记录仅超级管理员可取消关联' });
  } else {
    const isChief = rbac.rolesOf(u).includes('chief');
    const canUnlink = item.created_by === u.id || rbac.isSuperAdmin(u) || isChief;
    if (!canUnlink) return res.status(403).json({ error: '只能取消自己添加的关联' });
  }
  db.prepare('DELETE FROM quality_topic_items WHERE id=? AND topic_id=?').run(Number(req.params.itemId), topic.id);
  res.json({ ok:true });
});

module.exports = router;
