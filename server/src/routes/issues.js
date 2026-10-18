/**
 * 问题上报路由
 *
 * - POST /issues          上报新问题（生成工单号）
 * - GET  /issues          问题列表（支持过滤）
 * - GET  /issues/:ticketNo  工单详情（含照片+流转日志）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

// 生成工单号：QC + YYYYMMDD + 3位序号
function genTicketNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const datePrefix = `QC${y}${m}${d}`;

  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM issues WHERE ticket_no LIKE ?"
  ).get(`${datePrefix}%`);
  const seq = String(row.cnt + 1).padStart(3, '0');
  return `${datePrefix}${seq}`;
}

// ─── 上报问题 ────────────────────────────────────────
router.post('/', (req, res) => {
  const {
    projectName, volumeCode, volumeName, volumeOwner,
    issueType, severity, description, photos,
  } = req.body;

  if (!issueType || !description) {
    return res.status(400).json({ error: '问题类型和描述为必填' });
  }

  const ticketNo = genTicketNo();
  const reporter = req.user.realName;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO issues (ticket_no, project_name, volume_code, volume_name, volume_owner,
        reporter, issue_type, severity, description, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    `).run(
      ticketNo, projectName || '', volumeCode || '', volumeName || '', volumeOwner || '',
      reporter, issueType, severity || 'normal', description
    );

    // 照片
    if (Array.isArray(photos)) {
      const insertPhoto = db.prepare('INSERT INTO issue_photos (issue_id, photo_url) VALUES (?, ?)');
      for (const url of photos) {
        insertPhoto.run(info.lastInsertRowid, url);
      }
    }

    // 流转日志
    db.prepare(`
      INSERT INTO ticket_logs (ticket_no, action, from_status, to_status, operator, comment)
      VALUES (?, '上报', NULL, 'submitted', ?, ?)
    `).run(ticketNo, reporter, description.slice(0, 50));

    return info.lastInsertRowid;
  });

  const id = tx();
  res.json({ id, ticketNo, message: '上报成功' });
});

// ─── 问题列表 ────────────────────────────────────────
router.get('/', (req, res) => {
  const { status, mine, issueType, assignedToMe, page = 1, pageSize = 20 } = req.query;
  const isManager = rbac.canManage(req.user);

  let sql = 'SELECT * FROM issues WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (mine === '1') {
    sql += ' AND reporter = ?';
    params.push(req.user.realName);
  }
  if (assignedToMe === '1') {
    sql += ' AND assigned_to = ?';
    params.push(req.user.realName);
  }
  // 数据隔离：非管理者未显式指定 mine/assignedToMe 时，默认只看自己上报的，
  // 防止任意用户通过不带过滤参数直接拉取全员问题列表（含项目/卷册/严重度等敏感信息）。
  if (!isManager && mine !== '1' && assignedToMe !== '1') {
    sql += ' AND reporter = ?';
    params.push(req.user.realName);
  }
  if (issueType) {
    sql += ' AND issue_type = ?';
    params.push(issueType);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(pageSize), (Number(page) - 1) * Number(pageSize));

  const issues = db.prepare(sql).all(...params);

  // 附加照片数量
  const countPhotos = db.prepare('SELECT COUNT(*) as cnt FROM issue_photos WHERE issue_id = ?');
  for (const issue of issues) {
    issue.photoCount = countPhotos.get(issue.id).cnt;
  }

  res.json(issues);
});

// ─── 工单详情 ────────────────────────────────────────
router.get('/:ticketNo', (req, res) => {
  const { ticketNo } = req.params;

  const issue = db.prepare('SELECT * FROM issues WHERE ticket_no = ?').get(ticketNo);
  if (!issue) {
    return res.status(404).json({ error: '工单不存在' });
  }

  // 数据隔离：非管理者仅可查看自己上报或被分配处理的工单
  if (!rbac.canManage(req.user) && issue.reporter !== req.user.realName && issue.assigned_to !== req.user.realName) {
    return res.status(403).json({ error: '无权查看该工单' });
  }

  issue.photos = db.prepare('SELECT id, photo_url FROM issue_photos WHERE issue_id = ?').all(issue.id);
  issue.logs = db.prepare('SELECT * FROM ticket_logs WHERE ticket_no = ? ORDER BY created_at ASC').all(ticketNo);

  res.json(issue);
});

module.exports = router;
