/**
 * 短期签名 URL 工具（#536）
 *
 * 用途：为上传文件生成带时效（默认 10 分钟）的 HMAC-SHA256 签名 URL，
 * 允许无登录态（如微信内置浏览器 / 收藏夹离线）打开 PDF/Word 等附件，
 * 避免每次下载都强依赖 JWT，同时避免链接被永久外传。
 *
 * 安全：
 *  - 签名 = HMAC-SHA256(storedPath + ':' + exp, secret)
 *  - 校验严格比对 exp（> now）且 HMAC 相等（timingSafeEqual 防时序攻击）
 *  - 缺 exp 或 sig → 调用方自行决定是登录态兜底还是直接拒绝
 *  - 默认 TTL = 10 分钟（短时足够覆盖 WPS/微信收藏抓取周期；过期即作废）
 *
 * 配置：
 *  - 优先读 URL_SIGN_SECRET（可与 JWT_SECRET 独立，方便轮换）
 *  - 否则复用 JWT_SECRET（避免引入新密钥管理面）
 *  - TTL 可通过 URL_SIGN_TTL_MS 自定义
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function getSecret() {
  return process.env.URL_SIGN_SECRET || process.env.JWT_SECRET || '';
}

function getTtlMs() {
  return Number(process.env.URL_SIGN_TTL_MS) || DEFAULT_TTL_MS;
}

/**
 * 生成签名字符串与过期时间
 * @param {string} storedPath 形如 '202608/abc.pdf'
 * @param {number} [ttlMs] 可选自定义有效期（毫秒）
 * @returns {{sig: string, exp: number, ttlMs: number}}
 */
function signPath(storedPath, ttlMs) {
  const ttl = Number.isFinite(ttlMs) ? Number(ttlMs) : getTtlMs();
  const exp = Date.now() + ttl;
  const payload = String(storedPath) + ':' + exp;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return { sig, exp, ttlMs: ttl };
}

/**
 * 校验签名：sig/exp 缺失、过期、长度不匹配、HMAC 不一致均返回 false。
 * @param {string} storedPath
 * @param {string|undefined} sigHex
 * @param {string|undefined|number} exp
 * @returns {boolean}
 */
function verifyPathSignature(storedPath, sigHex, exp) {
  if (!sigHex || !exp) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Date.now()) return false; // 已过期
  const payload = String(storedPath) + ':' + expNum;
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  const sigStr = String(sigHex);
  // 等长比较防 timingSafeEqual 抛错；不等长则必不匹配
  if (expected.length !== sigStr.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sigStr, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { signPath, verifyPathSignature, getTtlMs };