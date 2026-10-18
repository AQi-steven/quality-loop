// imaRebind.js —— IMA Key 自动重绑（每 ~20 天由 cron 调用，也可 `node src/imaRebind.js --now` 立即执行）
//
// 背景：IMA OpenAPI Key 约每月失效（code 200002 skill auth failed），但 Key 字符串本身往往不变，
//       重新"绑定"一次即可恢复。本脚本把 ima_key.json（超级管理员维护的凭证源）同步进 .env，
//       重启 qc-app 使运行中的服务使用新凭证，并探测 IMA 鉴权是否通过。
//       - 通过：立即清空 IMA 异常红条（写 ima_sync_status=ok），静默成功（不消耗微信额度）；
//       - 失败：推送微信告警，提示需人工到 ima.qq.com 重新生成 Key 并写回 ima_key.json。
//
// 设计要点：
//   * ima_key.json 是凭证"唯一真源"，.env 只是它的副本；更新 Key 只需改 ima_key.json。
//   * 用状态文件做"每 20 天"精确门控（cron 每日跑，未到间隔则跳过），比 crontab 的 */20 更准确、且不怕漏跑。
//   * 探测用脚本进程内即时写入的 process.env，直接验证 Key 本身是否被 IMA 接受，与 qc-app 重启无关。

require('./env').loadDeployEnv();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const db = require('./db/connection');
const ima = require('./ima');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, 'ima_key.json');
const ENV_FILE = path.join(ROOT, '.env');
const STATE_FILE = path.join(ROOT, 'data', 'ima_rebind_state.json');
const REBIND_INTERVAL_DAYS = 20;
const FORCE = process.argv.includes('--now');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function readLastRebind() {
  const s = readJson(STATE_FILE);
  return s && s.last_rebind_at ? new Date(s.last_rebind_at) : null;
}
function writeState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ last_rebind_at: new Date().toISOString() })); }
  catch (e) { console.error('[IMA重绑] 状态写入失败', e.message); }
}

// 把 client_id / api_key 同步进 .env，保留其它变量不变
function syncEnv(clientId, apiKey) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n'); } catch (e) { lines = []; }
  let setCid = false, setKey = false;
  const out = [];
  for (const ln of lines) {
    if (/^\s*IMA_CLIENT_ID\s*=/.test(ln)) { out.push(`IMA_CLIENT_ID=${clientId}`); setCid = true; }
    else if (/^\s*IMA_API_KEY\s*=/.test(ln)) { out.push(`IMA_API_KEY=${apiKey}`); setKey = true; }
    else out.push(ln);
  }
  if (!setCid) out.push(`IMA_CLIENT_ID=${clientId}`);
  if (!setKey) out.push(`IMA_API_KEY=${apiKey}`);
  fs.writeFileSync(ENV_FILE, out.join('\n'));
  console.log('[IMA重绑] 已同步凭证到 .env');
}

function pm2Restart() {
  const candidates = ['pm2', '/usr/bin/pm2', '/usr/local/bin/pm2'].filter(Boolean);
  for (const c of candidates) {
    try { execSync(`${c} restart qc-app`, { stdio: 'ignore' }); console.log('[IMA重绑] pm2 restart qc-app 完成'); return true; }
    catch (e) { /* 尝试下一个 */ }
  }
  console.error('[IMA重绑] pm2 restart 失败：未找到可用 pm2');
  return false;
}

(async () => {
  try {
    const key = readJson(KEY_FILE);
    if (!key || !key.client_id || !key.api_key ||
        String(key.client_id).startsWith('REPLACE') || String(key.api_key).startsWith('REPLACE')) {
      console.log('[IMA重绑] ima_key.json 未配置有效凭证（仍为占位符或缺失），跳过。请把 IMA Client ID / Api Key 写入该文件。');
      return;
    }

    const last = readLastRebind();
    const due = FORCE || !last || (Date.now() - last.getTime()) > REBIND_INTERVAL_DAYS * 86400000;
    if (!due) {
      const days = last ? ((Date.now() - last.getTime()) / 86400000).toFixed(1) : '?';
      console.log(`[IMA重绑] 距上次重绑 ${days} 天，未到 ${REBIND_INTERVAL_DAYS} 天，跳过`);
      return;
    }

    console.log('[IMA重绑] 开始：写入 .env 并重启 qc-app');
    syncEnv(key.client_id, key.api_key);
    // 让本进程使用新凭证做探测（独立于 qc-app 重启结果）
    process.env.IMA_CLIENT_ID = key.client_id;
    process.env.IMA_API_KEY = key.api_key;

    pm2Restart();
    await new Promise(r => setTimeout(r, 2500)); // 等 qc-app 重启完成

    const r = await ima.checkImaAuth();
    if (r.ok) {
      writeState();
      // 立即清空 IMA 异常红条，避免误报
      try { await ima.recordImaStatus(db, { ok: true, error: '' }); } catch (e) {}
      console.log('[IMA重绑] 成功，IMA 鉴权通过');
    } else {
      console.error('[IMA重绑] 失败：', r.error);
      await ima.alertImaFailure(
        'IMA 自动重绑后仍鉴权失败（' + (r.error || 'unknown') + '）。\n' +
        '可能 Key 已彻底失效。请到 https://ima.qq.com/agent-interface 重新生成 Client ID / Api Key，' +
        '写入服务器 /opt/qc-app/server/ima_key.json 后，执行 `node src/imaRebind.js --now` 立即重绑。'
      );
    }
  } catch (e) {
    console.error('[IMA重绑] 异常', e && e.message);
  } finally {
    process.exit(0);
  }
})();
