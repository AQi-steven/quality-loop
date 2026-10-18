/**
 * 统一微信推送层（server/src/wechat/push.js）
 *
 * 屏蔽底层通道差异，对外只暴露 pushToUser(user, title, content)。
 * 通道：Server酱（serverchan_key 存在且格式合法）→ 走微信原生「服务通知」，免 App 免扫码，最稳。
 *
 * user 为含 serverchan_key 字段的 users 行对象。
 * 失败均被静默（返回 {ok:false}），不影响业务主流程（与 IMA/原有行为一致）。
 */

const sc = require('./serverchan');

/**
 * @param {{serverchan_key?:string}} user  用户行对象
 * @param {string} title    提醒标题
 * @param {string} content  提醒正文
 * @returns {Promise<{ok:boolean, channel?:string, message:string}>}
 */
async function pushToUser(user, title, content) {
  if (!user) return { ok: false, channel: null, message: '用户不存在' };

  // Server酱（ServerChan）：微信原生「服务通知」，免 App 免扫码，最稳
  if (user.serverchan_key && sc.isValidKey(user.serverchan_key)) {
    const r = await sc.send(user.serverchan_key, title, content);
    if (r.ok) return { ok: true, channel: 'serverchan', message: r.message };
  }

  return { ok: false, channel: null, message: '未绑定微信提醒（Server酱）' };
}

module.exports = { pushToUser };
