/**
 * 质量目标路由
 *
 * - GET  /goals        目标列表
 * - POST /goals        发布目标（管理员）
 * - PUT  /goals/:id    更新目标（管理员）
 * - DELETE /goals/:id  归档目标（管理员，软删除设为archived）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const manageMiddleware = require('../middleware/manage');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

// ─── 目标列表 ────────────────────────────────────────
router.get('/', (req, res) => {
  const { status = 'active', category } = req.query;
  let sql = 'SELECT * FROM goals WHERE 1=1';
  const params = [];

  if (status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }

  sql += ' ORDER BY priority DESC, published_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// ─── 发布目标（仅院长/专总可发全员管理目标）──────────
router.post('/', manageMiddleware, (req, res) => {
  if (!rbac.canPublishAll(req.user)) return res.status(403).json({ error: '管理目标仅院长/专总可发布' });
  const { title, content, category, period, priority } = req.body;
  if (!title || !content) return res.status(400).json({ error: '标题和内容为必填' });

  const info = db.prepare(`
    INSERT INTO goals (title, content, category, period, status, priority, published_by, published_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
  `).run(title, content, category || '通用', period || '', priority || 0, req.user.realName);

  res.json({ id: info.lastInsertRowid, message: '发布成功' });
});

// ─── 更新目标 ────────────────────────────────────────
router.put('/:id', manageMiddleware, (req, res) => {
  const { title, content, category, period, priority, status } = req.body;
  const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: '目标不存在' });

  db.prepare(`
    UPDATE goals SET
      title = COALESCE(?, title), content = COALESCE(?, content),
      category = COALESCE(?, category), period = COALESCE(?, period),
      priority = COALESCE(?, priority), status = COALESCE(?, status),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title || null, content || null, category || null, period || null,
    priority !== undefined ? priority : null, status || null, req.params.id);

  res.json({ message: '更新成功' });
});

// ─── 归档目标 ────────────────────────────────────────
router.delete('/:id', manageMiddleware, (req, res) => {
  const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: '目标不存在' });

  db.prepare("UPDATE goals SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  res.json({ message: '已归档' });
});

module.exports = router;
