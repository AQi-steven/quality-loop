/**
 * bcrypt worker（2026-10-18 大会加固）
 * 在独立线程里执行 bcryptjs 计算，把 CPU 密集的密码校验移出主线程事件循环。
 * 只收 { id, op, a, b }，回 { id, err?, valid?/hash? }——不碰数据库，无共享状态。
 */
const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', (m) => {
  const done = (r) => {
    try { parentPort.postMessage(Object.assign({ id: m && m.id }, r)); } catch (_) { /* 端口已关闭 */ }
  };
  try {
    if (!m || typeof m.id !== 'number') return;
    if (m.op === 'compare') {
      bcrypt.compare(String(m.a), String(m.b), (err, valid) => {
        done(err ? { err: String(err.message || err) } : { valid: !!valid });
      });
    } else if (m.op === 'hash') {
      bcrypt.hash(String(m.a), Number(m.b), (err, hash) => {
        done(err ? { err: String(err.message || err) } : { hash });
      });
    } else {
      done({ err: 'unknown op: ' + m.op });
    }
  } catch (e) {
    done({ err: String((e && e.message) || e) });
  }
});
