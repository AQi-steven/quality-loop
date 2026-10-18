// 前端错误上报（排查微信白屏等难以复现的问题用）。
// 无需鉴权：仅记录到服务端日志（pm2 logs qc-app 可见），绝不影响业务主流程。
// 审计 L-4（2026-09-11）：接口无鉴权可被脚本刷日志（日志膨胀/淹没真实错误），
//   加每 IP 限频：5 分钟窗口内最多 30 条，超限静默丢弃（仍返回 ok，不影响前端）。
const express = require('express');
const router = express.Router();

const CL_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
const CL_MAX_PER_WINDOW = 30;
const clHits = new Map(); // ip -> [timestamps]

setInterval(() => { // 清理过期条目，防 Map 无限增长
  const cutoff = Date.now() - CL_WINDOW_MS;
  for (const [ip, arr] of clHits) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) clHits.set(ip, kept); else clHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function overLimit(ip) {
  const now = Date.now();
  const cutoff = now - CL_WINDOW_MS;
  let arr = (clHits.get(ip) || []).filter((t) => t > cutoff);
  if (arr.length >= CL_MAX_PER_WINDOW) { clHits.set(ip, arr); return true; }
  arr.push(now);
  clHits.set(ip, arr);
  return false;
}

router.post('/log', (req, res) => {
  try {
    const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || 'unknown';
    if (!overLimit(ip)) {
      const b = req.body || {};
      console.error('[CLIENT-ERR]', JSON.stringify({
        msg: String(b.msg || '').slice(0, 500),
        stack: String(b.stack || '').slice(0, 1500),
        url: String(b.url || ''),
        ua: String(b.ua || '').slice(0, 300),
        ip,
        t: new Date().toISOString(),
      }));
    }
  } catch (e) { /* 记录失败也不影响前端 */ }
  res.json({ ok: 1 });
});

module.exports = router;
