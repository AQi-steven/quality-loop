// imaKeyRemind.js —— IMA Key 到期主动提醒（cron 每日 08:37 调用）
//
// 背景：IMA OpenAPI Key 有效期约 1 个月（2026-10-11 用户确认），且只能在 ima.qq.com
//       网页人工重新生成（OpenAPI 无 key 轮换接口，无法全自动）。
//       imaRebind.js 只能救"key 字符串没变、绑定态失效"的情况；用户重新生成新 key 后
//       旧 key 立即作废（2026-10-11 全口径审计实测复现），必须人工换 key。
//
// 本脚本做**事前提醒**（与 imaHealthCheck.js 的事后告警互补）：
//   * key 年龄 >= 25 天：每天推一条 Server酱 微信提醒（换 key 后 updated_at 变新，自动停）
//   * key 年龄 >= 32 天：文案升级为"今天很可能已失效"（催办）
//   * `--test`：无视年龄强制推一条，用于验证推送链路
//
// 依赖：src/env（加载 .env）、src/wechat/serverchan、src/db/connection、src/ima（取 key 兜底）
// 用法：node /opt/qc-app/server/src/imaKeyRemind.js [--test]

require('./env').loadDeployEnv();
const fs = require('fs');
const path = require('path');

const KEY_FILE = path.join(__dirname, '..', 'ima_key.json');
const FORCE = process.argv.includes('--test');
const REMIND_AT_DAY = 25;   // 开始提醒的天数阈值（key 月效，留 5 天缓冲）
const URGENT_AT_DAY = 32;   // 文案升级阈值

function keyAgeDays() {
  try {
    const j = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (!j.updated_at) return null;
    const t = new Date(j.updated_at + 'T00:00:00+08:00').getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  } catch (e) { return null; }
}

async function push(title, body) {
  // key 优先级与 ima.js alertImaFailure 一致：env IMA_ALERT_SCKEY → 超级管理员账号 serverchan_key
  let key = process.env.IMA_ALERT_SCKEY;
  if (!key) {
    try {
      const db = require('./db/connection');
      const u = db.prepare("SELECT serverchan_key FROM users WHERE username='superadmin' AND serverchan_key IS NOT NULL LIMIT 1").get();
      key = u && u.serverchan_key;
    } catch (e) { key = null; }
  }
  if (!key) { console.error('[IMA提醒] 无可用 Server酱 SendKey，跳过'); return false; }
  const sc = require('./wechat/serverchan');
  const r = await sc.send(key, title, body);
  console.log('[IMA提醒] 推送结果：', r && r.message);
  return true;
}

(async () => {
  const age = keyAgeDays();
  if (age === null) {
    console.error('[IMA提醒] 无法读取 ima_key.json 的 updated_at，跳过');
    process.exit(0);
  }
  console.log('[IMA提醒] key 已使用 ' + age + ' 天（updated_at 见 ima_key.json）');

  if (FORCE) {
    await push('🔔 千里行·IMA Key 提醒（链路测试）',
      '这是一条测试推送，验证「IMA Key 到期提醒」链路正常。\n\n当前 key 已使用 ' + age + ' 天。正式提醒将从第 ' + REMIND_AT_DAY + ' 天起每天推送，换 key 后自动停止。');
    process.exit(0);
  }

  if (age < REMIND_AT_DAY) {
    console.log('[IMA提醒] 未到提醒阈值（' + REMIND_AT_DAY + ' 天），跳过');
    process.exit(0);
  }

  const urgent = age >= URGENT_AT_DAY;
  const title = urgent
    ? '🚨 千里行·IMA Key 很可能已失效，请立即更换'
    : '🔔 千里行·IMA Key 即将满月，请安排更换';
  const body = (urgent
    ? 'IMA Key 已使用 ' + age + ' 天，超过月效期，千里行往大库的自动推送（公告/宣贯/人人讲）很可能已失败。\n\n'
    : 'IMA Key 已使用 ' + age + ' 天（有效期约 1 个月），为避免千里行→大库推送中断，请尽快更换。\n\n')
    + '更换步骤：\n'
    + '1. 打开 https://ima.qq.com/agent-interface 重新生成 API Key\n'
    + '2. 把新 Key 发给 WorkBuddy 里的 AI，说「更新 IMA key」\n'
    + '3. AI 会同步服务器 ima_key.json + .env 并重启验证\n\n'
    + '（换好后本提醒自动停止）';

  await push(title, body);
  process.exit(0);
})();
