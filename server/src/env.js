/**
 * 部署环境变量加载（server/.env）
 *
 * pm2 不会自动把 .env 注入 process.env，而 IMA 等密钥依赖此文件。
 * 该逻辑被 app.js（服务启动）与一次性脚本（如 IMA 对账 / 补推）共用，
 * 故抽成独立模块，避免两边各自实现导致行为不一致。
 *
 * 注意：变量缺失或为空（如 pm2 注入了空串）时一律用 .env 覆盖，
 * 以保证 .env 为权威来源。
 */
const fs = require('fs');
const path = require('path');

function loadDeployEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '.env'); // server/.env
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // 部署 .env 为权威来源：变量缺失或为空（如 pm2 注入了空串）时一律用 .env 覆盖
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) { /* env 缺失时上层会报错提示，这里不影响启动 */ }
}

module.exports = { loadDeployEnv };
