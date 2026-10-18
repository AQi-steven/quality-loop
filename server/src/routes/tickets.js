/**
 * 工单流转路由
 *
 * 状态机：submitted → assigned → processing → resolved → closed
 *                                    ↑__________ rejected(打回)
 *
 * - PUT /tickets/:ticketNo/assign    分配（管理员）submitted/rejected → assigned
 * - PUT /tickets/:ticketNo/process   开始处理（被分配人）assigned → processing
 * - PUT /tickets/:ticketNo/resolve   提交处理结果（被分配人）processing → resolved
 * - PUT /tickets/:ticketNo/close     验证关闭（管理员）resolved → closed
 * - PUT /tickets/:ticketNo/reject    打回（管理员）resolved → assigned
 * - POST /tickets/:ticketNo/comment  添加评论/追问
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const manageMiddleware = require('../middleware/manage');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

function isAdmin(user) {
  return rbac.canManage(user);
}

// 状态流转通用函数
function transition(ticketNo, fromStatuses, toStatus, action, operator, extra = {}) {
  const issue = db.prepare('SELECT * FROM issues WHERE ticket_no = ?').get(ticketNo);
  if (!issue) return { error: '工单不存在', code: 404 };
  if (!fromStatuses.includes(issue.status)) {
    return { error: `当前状态(${issue.status})不允许此操作`, code: 400 };
  }

  const tx = db.transaction(() => {
    const fields = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [toStatus];

    if (extra.assignedTo !== undefined) { fields.push('assigned_to = ?'); params.push(extra.assignedTo); }
    if (extra.resolvedNote !== undefined) { fields.push('resolved_note = ?', 'resolved_by = ?', 'resolved_at = CURRENT_TIMESTAMP'); params.push(extra.resolvedNote, operator); }
    if (extra.closedBy !== undefined) { fields.push('closed_by = ?', 'closed_at = CURRENT_TIMESTAMP'); params.push(operator); }

    params.push(ticketNo);
    db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE ticket_no = ?`).run(...params);

    db.prepare(`
      INSERT INTO ticket_logs (ticket_no, action, from_status, to_status, operator, comment)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ticketNo, action, issue.status, toStatus, operator, extra.comment || '');
  });

  tx();
  return { ok: true };
}

// ─── 分配 ────────────────────────────────────────────
router.put('/:ticketNo/assign', manageMiddleware, (req, res) => {
  const { assignedTo, comment } = req.body;
  if (!assignedTo) return res.status(400).json({ error: '请指定处理人' });

  const r = transition(req.params.ticketNo, ['submitted', 'rejected'], 'assigned', '分配', req.user.realName, {
    assignedTo, comment: comment || `分配给 ${assignedTo}`,
  });
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ message: '已分配' });
});

// ─── 开始处理 ────────────────────────────────────────
router.put('/:ticketNo/process', (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE ticket_no = ?').get(req.params.ticketNo);
  if (!issue) return res.status(404).json({ error: '工单不存在' });
  if (issue.assigned_to !== req.user.realName && !isAdmin(req.user)) {
    return res.status(403).json({ error: '只有被分配人可以处理' });
  }

  const r = transition(req.params.ticketNo, ['assigned'], 'processing', '开始处理', req.user.realName, {
    comment: req.body.comment || '',
  });
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ message: '已开始处理' });
});

// ─── 提交处理结果 ────────────────────────────────────
router.put('/:ticketNo/resolve', (req, res) => {
  const { resolvedNote } = req.body;
  if (!resolvedNote) return res.status(400).json({ error: '请填写处理说明' });

  const issue = db.prepare('SELECT * FROM issues WHERE ticket_no = ?').get(req.params.ticketNo);
  if (!issue) return res.status(404).json({ error: '工单不存在' });
  if (issue.assigned_to !== req.user.realName && !isAdmin(req.user)) {
    return res.status(403).json({ error: '只有被分配人可以提交结果' });
  }

  const r = transition(req.params.ticketNo, ['processing', 'assigned'], 'resolved', '提交处理结果', req.user.realName, {
    resolvedNote, comment: resolvedNote.slice(0, 50),
  });
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ message: '已提交，等待验证' });
});

// ─── 验证关闭 ────────────────────────────────────────
router.put('/:ticketNo/close', manageMiddleware, (req, res) => {
  const r = transition(req.params.ticketNo, ['resolved'], 'closed', '验证关闭', req.user.realName, {
    closedBy: req.user.realName, comment: req.body.comment || '验证通过，关闭',
  });
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ message: '已关闭' });
});

// ─── 打回 ────────────────────────────────────────────
router.put('/:ticketNo/reject', manageMiddleware, (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: '打回必须填写原因' });

  const r = transition(req.params.ticketNo, ['resolved'], 'assigned', '打回', req.user.realName, { comment });
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ message: '已打回' });
});

// ─── 评论/追问 ───────────────────────────────────────
router.post('/:ticketNo/comment', (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: '评论内容不能为空' });

  const issue = db.prepare('SELECT status FROM issues WHERE ticket_no = ?').get(req.params.ticketNo);
  if (!issue) return res.status(404).json({ error: '工单不存在' });

  db.prepare(`
    INSERT INTO ticket_logs (ticket_no, action, from_status, to_status, operator, comment)
    VALUES (?, '评论', ?, ?, ?, ?)
  `).run(req.params.ticketNo, issue.status, issue.status, req.user.realName, comment);

  res.json({ message: '评论成功' });
});

module.exports = router;
