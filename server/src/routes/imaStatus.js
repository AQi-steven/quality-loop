/**
 * IMA 同步状态路由（server/src/routes/imaStatus.js）
 * 提供 GET /api/ima/status 供前端横幅展示最近一次 IMA 知识库同步状态（成功/失败时间与错误）。
 */
const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 最近一次 IMA 同步状态（status: ok/fail；last_success_at/last_check_at；last_error）
router.get('/status', (req, res) => {
  const row = db.prepare('SELECT status, last_success_at, last_check_at, last_error FROM ima_sync_status WHERE id=1').get() || {};
  res.json(row);
});

module.exports = router;
