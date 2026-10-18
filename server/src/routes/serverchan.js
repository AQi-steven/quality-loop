/**
 * Server酱（ServerChan）微信提醒绑定路由（server/src/routes/serverchan.js）
 *
 * 绑定机制（极简，无需二维码 / 轮询 / webhook）：
 *   1. 用户 GET /status                              → 查看当前是否已绑定 SendKey
 *   2. 用户在 sct.ftqq.com 用微信登录拿到 SendKey，POST /bind { key }  → 存库
 *   3. 前端调 POST /test                              → 立即发一条测试消息验证通道
 *   4. POST /unbind                                   → 清空 SendKey
 *
 * 之后三种提醒（宣贯审核 / 院选待精选 / PDCA 待办）触发时按 serverchan_key 推送。
 * 所有接口受 authMiddleware 保护（绑定的是本人账号）。
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const sc = require('../wechat/serverchan');

const router = express.Router();
router.use(authMiddleware);

// 当前绑定状态
router.get('/status', (req, res) => {
  const u = db.prepare('SELECT serverchan_key FROM users WHERE id=?').get(req.user.id);
  res.json({ bound: !!(u && u.serverchan_key) });
});

// 绑定 SendKey（粘贴）
router.post('/bind', async (req, res) => {
  const key = ((req.body && req.body.key) || '').trim();
  if (!sc.isValidKey(key)) return res.status(400).json({ error: 'SendKey 格式不正确（应以 SCT 开头）' });
  db.prepare('UPDATE users SET serverchan_key=? WHERE id=?').run(key, req.user.id);
  res.json({ ok: true });
});

// 发送测试消息（立即验证绑定是否成功，消息会推到微信「服务通知」）
router.post('/test', async (req, res) => {
  try {
    const u = db.prepare('SELECT id, serverchan_key FROM users WHERE id=?').get(req.user.id);
    if (!u || !u.serverchan_key) return res.status(400).json({ error: '尚未绑定 SendKey' });
    const r = await sc.sendTest(u.serverchan_key);
    if (r.ok) return res.json({ ok: true, message: r.message });
    return res.status(502).json({ error: '测试发送失败：' + r.message });
  } catch (e) {
    console.error('[serverchan/test]', e.message);
    return res.status(502).json({ error: '测试发送异常：' + e.message });
  }
});

// 解绑
router.post('/unbind', (req, res) => {
  db.prepare('UPDATE users SET serverchan_key=NULL WHERE id=?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
