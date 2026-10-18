/**
 * 通用评论路由（公告 / 宣贯 / PDCA 院选公示 公示后他人可评论）
 *
 * 统一以 (target_type, target_id) 定位被评论对象：
 *   - announcement  公告
 *   - dissem        质量宣贯
 *   - pdca          PDCA 问题（含人人讲院选公示）
 *
 *  GET    /counts?targets=type:id,...  批量计数（首页一屏多卡片一次拉全评论数）
 *  GET    /?target_type=&target_id=   列表（按时间正序，返回 count + items + is_mine）
 *  POST   /                           创建（登录且非游客；类型校验；长度上限 1000）
 *  DELETE /:id                       删除（评论作者本人 或 管理员 superadmin）
 *
 * 权限说明：
 *   - 「他人可评论」= 任意登录用户（含发布者本人）均可评论；游客(isGuest)一律 403。
 *   - 删除仅限作者本人或 superadmin，避免他人误删 / 抹除讨论记录。
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const TYPES = new Set(['announcement', 'dissem', 'pdca']);
const MAX_LEN = 1000;

// 批量计数：首页一屏多卡片，一次请求拉全屏评论数，避免 N+1。
// 入参 targets=announcement:1,dissem:2,pdca:3（逗号分隔 type:id）
// 返回 { counts: { "announcement:1": 3, "dissem:2": 0, ... } }
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
  for (const [type, id] of valid) result[type + ':' + id] = 0;
  if (valid.length) {
    const conds = valid.map(() => '(target_type=? AND target_id=?)').join(' OR ');
    const params = [];
    valid.forEach(([t, id]) => { params.push(t, id); });
    const rows = db.prepare(
      `SELECT target_type, target_id, COUNT(*) AS c FROM comments WHERE ${conds} GROUP BY target_type, target_id`
    ).all(...params);
    for (const r of rows) result[r.target_type + ':' + r.target_id] = r.c;
  }
  res.json({ counts: result });
});

// 列表
router.get('/', (req, res) => {
  const { target_type, target_id } = req.query;
  if (!TYPES.has(target_type) || !target_id) {
    return res.status(400).json({ error: '参数缺失或 target_type 非法' });
  }
  const items = db.prepare(
    'SELECT id, user_id, real_name, content, created_at FROM comments WHERE target_type=? AND target_id=? ORDER BY created_at ASC, id ASC'
  ).all(target_type, Number(target_id));
  const uid = req.user.id;
  const list = items.map(c => Object.assign({}, c, { is_mine: c.user_id === uid }));
  res.json({ count: list.length, items: list });
});

// 创建
router.post('/', (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: '游客无权评论' });
  const { target_type, target_id, content } = req.body || {};
  if (!TYPES.has(target_type) || !target_id) {
    return res.status(400).json({ error: '参数缺失或 target_type 非法' });
  }
  const text = (content || '').toString().trim();
  if (!text) return res.status(400).json({ error: '评论内容不能为空' });
  if (text.length > MAX_LEN) return res.status(400).json({ error: `评论过长（上限 ${MAX_LEN} 字）` });

  // real_name 以 users 表为准（避免前端伪造），兜底用 token 中的真实姓名
  const u = db.prepare('SELECT real_name FROM users WHERE id=?').get(req.user.id);
  const realName = (u && u.real_name) || req.user.realName || req.user.username;

  const r = db.prepare(
    'INSERT INTO comments (target_type, target_id, user_id, real_name, content) VALUES (?,?,?,?,?)'
  ).run(target_type, Number(target_id), req.user.id, realName, text);

  const row = db.prepare(
    'SELECT id, user_id, real_name, content, created_at FROM comments WHERE id=?'
  ).get(r.lastInsertRowid);
  res.json(Object.assign({}, row, { is_mine: true }));
});

// 删除
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  const isAuthor = c.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin' || req.user.username === 'superadmin';
  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ error: '仅评论作者或管理员可删除' });
  }
  db.prepare('DELETE FROM comments WHERE id=?').run(id);
  res.json({ message: '已删除' });
});

module.exports = router;
