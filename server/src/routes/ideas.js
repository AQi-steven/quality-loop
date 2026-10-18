/**
 * 质量人人讲（点子墙）路由
 *
 * - GET  /ideas          点子列表（按时间/点赞排序）
 * - POST /ideas          发布点子
 * - POST /ideas/:id/like 点赞/取消点赞
 * - PUT  /ideas/:id/adopt 标记已采纳（管理员）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const manageMiddleware = require('../middleware/manage');

const router = express.Router();
router.use(authMiddleware);

// ─── 点子列表 ────────────────────────────────────────
router.get('/', (req, res) => {
  const { sort = 'time', category, status = 'active' } = req.query;
  let sql = 'SELECT * FROM ideas WHERE 1=1';
  const params = [];

  if (status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }

  sql += sort === 'likes' ? ' ORDER BY likes DESC, created_at DESC' : ' ORDER BY created_at DESC';
  const ideas = db.prepare(sql).all(...params);

  // 标记当前用户是否已点赞
  const likedStmt = db.prepare('SELECT 1 FROM idea_likes WHERE idea_id = ? AND user_name = ?');
  for (const idea of ideas) {
    idea.liked = !!likedStmt.get(idea.id, req.user.realName);
  }

  res.json(ideas);
});

// ─── 发布点子 ────────────────────────────────────────
router.post('/', (req, res) => {
  const { title, content, category } = req.body;
  if (!title || !content) return res.status(400).json({ error: '标题和内容为必填' });

  const info = db.prepare(`
    INSERT INTO ideas (author, category, title, content, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(req.user.realName, category || '经验分享', title, content);

  res.json({ id: info.lastInsertRowid, message: '发布成功' });
});

// ─── 点赞/取消点赞 ───────────────────────────────────
router.post('/:id/like', (req, res) => {
  const ideaId = req.params.id;
  const idea = db.prepare('SELECT id FROM ideas WHERE id = ?').get(ideaId);
  if (!idea) return res.status(404).json({ error: '点子不存在' });

  const existing = db.prepare('SELECT id FROM idea_likes WHERE idea_id = ? AND user_name = ?')
    .get(ideaId, req.user.realName);

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('DELETE FROM idea_likes WHERE id = ?').run(existing.id);
      db.prepare('UPDATE ideas SET likes = likes - 1 WHERE id = ?').run(ideaId);
      return false;
    } else {
      db.prepare('INSERT INTO idea_likes (idea_id, user_name) VALUES (?, ?)').run(ideaId, req.user.realName);
      db.prepare('UPDATE ideas SET likes = likes + 1 WHERE id = ?').run(ideaId);
      return true;
    }
  });

  const liked = tx();
  const { likes } = db.prepare('SELECT likes FROM ideas WHERE id = ?').get(ideaId);
  res.json({ liked, likes });
});

// ─── 标记已采纳 ──────────────────────────────────────
router.put('/:id/adopt', manageMiddleware, (req, res) => {
  const idea = db.prepare('SELECT id FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: '点子不存在' });

  db.prepare("UPDATE ideas SET status = 'adopted', adopted_by = ?, adopted_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.user.realName, req.params.id);
  res.json({ message: '已标记采纳' });
});

module.exports = router;
