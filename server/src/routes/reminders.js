/**
 * 提醒路由（PDCA 备忘传送 / 校审·提资·要点提醒）
 *
 *   GET    /users          收件人候选（全员，排除自己；供选择器）
 *   GET    /inbox          我收到的（按 state ASC，待处理在前）
 *   GET    /sent           我发出的
 *   POST   /              发提醒 / 从备忘传送（sender=当前用户）
 *   POST   /:id/done      标记完成（仅接收人）
 *   DELETE /:id           删除（仅隐藏自己这侧；双方都隐藏后才物理清理）
 *
 * 设计：提醒是一个独立实体，sender/recipient 双方可见（两个视角：我发出的 / 待我处理）。
 * 状态简单：pending -> done。不做自动流转链（v2 再做校审流转）。
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const { HIDDEN_DIVISIONS } = require('../divisions');

const router = express.Router();
router.use(authMiddleware);

// ─── 收件人候选（全员，排除自己；排除暂不参与的专业室）──────────────────
router.get('/users', (req, res) => {
  const hidden = HIDDEN_DIVISIONS.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, real_name, role, title_tag FROM users WHERE is_active=1 AND id<>? AND (division IS NULL OR division NOT IN (${hidden})) ORDER BY role ASC, real_name ASC`
  ).all(req.user.id, ...HIDDEN_DIVISIONS);
  res.json(rows);
});

// ─── 我收到的（过滤掉「我隐藏」的）───────────────────
router.get('/inbox', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM reminders WHERE recipient_id=? AND COALESCE(recipient_deleted,0)=0 AND type <> '已阅提醒' ORDER BY state ASC, created_at DESC"
  ).all(req.user.id);
  res.json(rows);
});

// ─── 我发出的（过滤掉「我隐藏」的）──────────────────
router.get('/sent', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM reminders WHERE sender_id=? AND COALESCE(sender_deleted,0)=0 AND type <> '已阅提醒' ORDER BY created_at DESC"
  ).all(req.user.id);
  res.json(rows);
});

// ─── 发提醒 / 从备忘传送 ──────────────────────────
router.post('/', (req, res) => {
  const {
    recipient_id, type = '通用', title = '', content = '',
    due_time = '', related_problem_id = null,
  } = req.body || {};

  if (!recipient_id) {
    return res.status(400).json({ error: '请选择接收人' });
  }
  if (Number(recipient_id) === req.user.id) {
    return res.status(400).json({ error: '不能发提醒给自己' });
  }

  const rec = db.prepare('SELECT id, real_name FROM users WHERE id=? AND is_active=1').get(recipient_id);
  if (!rec) {
    return res.status(400).json({ error: '接收人不存在或已禁用' });
  }

  const info = db.prepare(`
    INSERT INTO reminders (sender_id, sender_name, recipient_id, recipient_name, type, title, content, due_time, related_problem_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, req.user.realName, rec.id, rec.real_name,
    (type || '通用').trim(), (title || '').trim(), (content || '').trim(),
    due_time || null, related_problem_id || null
  );

  res.json({ id: info.lastInsertRowid, message: '已发送提醒' });
});

// ─── 标记完成（仅接收人）──────────────────────────
router.post('/:id/done', (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '提醒不存在' });
  if (r.recipient_id !== req.user.id) {
    return res.status(403).json({ error: '只能标记自己收到的提醒' });
  }
  if (r.state === 'done') return res.json({ message: '已完成' });
  db.prepare("UPDATE reminders SET state='done', done_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  res.json({ message: '已标记完成' });
});

// ─── 删除（仅隐藏自己这侧；双方都隐藏后才真正清理）────────
router.delete('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '提醒不存在' });
  const isSender = r.sender_id === req.user.id;
  const isRecipient = r.recipient_id === req.user.id;
  if (!isSender && !isRecipient) {
    return res.status(403).json({ error: '无权删除该提醒' });
  }
  // 仅标记当前用户这一侧为已隐藏，不影响对方视角
  if (isSender) db.prepare('UPDATE reminders SET sender_deleted=1 WHERE id=?').run(req.params.id);
  if (isRecipient) db.prepare('UPDATE reminders SET recipient_deleted=1 WHERE id=?').run(req.params.id);
  // 双方都隐藏后，记录不再被任何一方可见，物理清理
  db.prepare('DELETE FROM reminders WHERE id=? AND sender_deleted=1 AND recipient_deleted=1').run(req.params.id);
  res.json({ message: '已删除（仅自己侧隐藏）' });
});

module.exports = router;
