/**
 * Server酱（ServerChan）微信推送封装（server/src/wechat/serverchan.js）
 *
 * 用途：把「质量千里行」的红点提醒（宣贯审核 / 院选待精选 / PDCA 待办）通过微信发给对应员工。
 *
 * 为什么用 Server酱 替代 WxPusher：
 *   - WxPusher 在本应用被平台禁用「微信服务通知」通道（只能走自家 App），且扫码 UID 无法稳定获取，
 *     绑定永远失败。Server酱 直接走微信原生「服务通知」，免下载 App、免扫码。
 *   - 绑定极简：用户在 sct.ftqq.com 用微信登录拿到 SendKey → 在 App 里粘贴 → 立即发测试消息验证。
 *     无需二维码、无需轮询、无需 webhook、无 https 强制要求。
 *
 * 接口：POST https://sctapi.ftqq.com/{sendkey}.send
 *   表单字段：title（标题）、desp（正文，支持 Markdown/换行）
 *   成功返回 { code: 0, message: "OK" }；失败返回非 0 code + message。
 *
 * 设计原则（与 WxPusher 封装一致）：
 *   1. SendKey 缺失/格式错 → 降级为 no-op，绝不抛错、绝不阻塞主流程。
 *   2. 发送统一 try/catch，失败仅记日志，不影响业务（与 IMA 同步一致）。
 */

const SCT_BASE = 'https://sctapi.ftqq.com';

// 校验 SendKey 基本格式：以 SCT 开头，后面至少 5 位字母数字
function isValidKey(key) {
  return typeof key === 'string' && /^SCT[a-zA-Z0-9]{5,}$/.test(key.trim());
}

/**
 * 发送一条消息给指定 SendKey。
 * @param {string} key      SendKey（SCT 开头）
 * @param {string} title    标题
 * @param {string} content  正文（支持 \n 换行 / Markdown）
 * @returns {Promise<{ok:boolean, code:number, message:string}>}
 */
async function send(key, title, content) {
  if (!isValidKey(key)) return { ok: false, code: -1, message: 'SendKey 无效' };
  const k = key.trim();
  try {
    const body = new URLSearchParams();
    body.set('title', title || '质量千里行提醒');
    body.set('desp', content || '');
    const r = await fetch(`${SCT_BASE}/${encodeURIComponent(k)}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (j && j.code === 0) return { ok: true, code: 0, message: j.message || 'OK' };
    return { ok: false, code: (j && j.code) || -1, message: (j && j.message) || `HTTP ${r.status}` };
  } catch (e) {
    console.error('[Server酱] 发送失败：', e.message);
    return { ok: false, code: -1, message: e.message };
  }
}

// 发送一条测试消息（绑定后立即验证通道是否通畅），文案固定。
async function sendTest(key) {
  return send(
    key,
    '质量千里行·绑定测试',
    '✅ 微信提醒绑定成功！\n\n今后「宣贯审核 / 人人讲院选 / PDCA 待办」将在此处提醒你。\n\n（绑定仅用于接收通知，登录系统仍需用户名密码）'
  );
}

module.exports = { isValidKey, send, sendTest };
