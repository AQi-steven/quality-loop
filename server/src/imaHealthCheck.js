/**
 * IMA 同步主动自检脚本（由服务器 root crontab 每日调用，无需 HTTP 鉴权）。
 * 探测 IMA OpenAPI 凭证是否有效，记录状态到 ima_sync_status；
 * 若失效且状态由 ok→fail，自动推送微信告警（Server酱），实现「主动发现、不晚于用户」。
 * 用法：node /opt/qc-app/server/src/imaHealthCheck.js
 */
// 加载 server/.env（pm2 不会自动注入环境变量；cron 直跑 node 时必须手动加载，否则读不到 IMA_CLIENT_ID/IMA_API_KEY，会误报"未找到凭证"）
require('./env').loadDeployEnv();
const db = require('./db/connection');
const ima = require('./ima');

(async () => {
  try {
    const r = await ima.checkImaAuth();
    await ima.recordImaStatus(db, { ok: r.ok, error: r.ok ? '' : r.error }); // await 确保微信告警推送完成后再退出
    if (r.ok) console.log('[IMA自检] 正常');
    else console.log('[IMA自检] 失败：', r.error);
  } catch (e) {
    console.error('[IMA自检] 异常', e.message);
  } finally {
    process.exit(0);
  }
})();
