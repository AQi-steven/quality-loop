/**
 * 认证路由
 *
 * 登录方案：管理员分配账号+密码
 * - POST /login       账号密码登录
 * - POST /change-pwd   修改密码（首次登录强制）
 * - GET  /me           获取当前用户信息
 * - GET  /check        检查token是否有效
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const { safeExtra, publicUser, signToken, recordLogin } = require('../authHelpers');

const router = express.Router();

// ─── 登录限流（审计 M-3，2026-09-11）─────────────────
// 同一 IP+用户名 在 15 分钟窗口内累计 5 次登录失败 → 返回 429，直到窗口过期。
// 成功登录即清零该键。单 fork 进程内存实现（qc-app 为单实例，够用且无外部依赖）。
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 分钟
const RATE_MAX_FAILS = 5;
const loginFails = new Map(); // key -> { count, firstAt }

// 定期清理过期条目，防 Map 无限增长（扫描器打登录口时不留垃圾）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) {
    if (now - v.firstAt > RATE_WINDOW_MS) loginFails.delete(k);
  }
}, 10 * 60 * 1000).unref();

// 拓扑说明：外部流量必经 443 反代（proxy-https.js），它把真实客户端 IP
// 写入 x-forwarded-for；直连 3000 只可能是本机。故取 XFF 第一跳为客户端 IP。
function loginClientKey(req, username) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const ip = (xff.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  return ip + '|' + String(username || '').toLowerCase();
}
function isLoginBlocked(key) {
  const v = loginFails.get(key);
  if (!v) return false;
  if (Date.now() - v.firstAt > RATE_WINDOW_MS) { loginFails.delete(key); return false; }
  return v.count >= RATE_MAX_FAILS;
}
function recordLoginFail(key) {
  const v = loginFails.get(key);
  if (!v || Date.now() - v.firstAt > RATE_WINDOW_MS) {
    loginFails.set(key, { count: 1, firstAt: Date.now() });
  } else {
    v.count += 1;
  }
}

// ─── 登录 ───────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username) {
    return res.status(400).json({ error: '请输入用户名' });
  }

  const failKey = loginClientKey(req, username);
  if (isLoginBlocked(failKey)) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }

  const user = db.prepare('SELECT * FROM users WHERE lower(username) = lower(?) AND is_active = 1').get(username);
  if (!user) {
    recordLoginFail(failKey);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  // 游客免密：is_guest 用户直接放行（密码留空即可），不校验 password_hash
  const isGuest = !!user.is_guest;
  if (!isGuest) {
    if (!password) {
      return res.status(400).json({ error: '请输入密码' });
    }
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      recordLoginFail(failKey);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
  }

  // 登录成功：清除该键的失败计数
  loginFails.delete(failKey);

  // 更新最后登录时间 + 最近活跃时间（登录属于"真正登录"，两者都更新），并记录登录流水
  recordLogin(req, user);

  // 签发JWT
  const token = signToken(user);

  res.json({
    token,
    mustChangePwd: !!user.must_change_pwd,
    isGuest,
    user: publicUser(user),
  });
});

// ─── 修改密码 ────────────────────────────────────────
router.post('/change-pwd', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请输入旧密码和新密码' });
  }

  if (newPassword.length < config.password.minLength) {
    return res.status(400).json({ error: `新密码至少${config.password.minLength}位` });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const valid = bcrypt.compareSync(oldPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: '旧密码错误' });
  }

  const hash = bcrypt.hashSync(newPassword, config.password.bcryptRounds);
  db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(hash, user.id);

  res.json({ message: '密码修改成功' });
});

// ─── 获取当前用户信息 ────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare(
    `SELECT id, username, real_name, role, title_tag, division, extra_roles, department, phone, must_change_pwd, is_guest, can_exam,
            last_login_at, last_active_at,
            datetime(last_login_at, '+8 hours') AS lastLoginAtBJ,
            datetime(last_active_at, '+8 hours') AS lastActiveAtBJ
     FROM users WHERE id = ? AND is_active = 1`
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: '用户不存在或已禁用' });
  }

  // 记录"最近活跃"：App 每次打开会走 /me 用存储的 token 续期（不重新输密码），
  // 故在此更新 last_active_at，使"最近活跃"反映真实使用情况。
  // 限频：距上次记录超过 1 分钟才写，避免每次页面切换都落库。
  try {
    db.prepare(`UPDATE users SET last_active_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-1 minutes'))`).run(user.id);
    if (!user.last_active_at) user.last_active_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } catch (e) {}

  res.json({
    id: user.id,
    username: user.username,
    realName: user.real_name,
    role: user.role,
    titleTag: user.title_tag,
    division: user.division,
    extraRoles: safeExtra(user),
    department: user.department,
    phone: user.phone,
    mustChangePwd: !!user.must_change_pwd,
    isGuest: !!user.is_guest,
    canExam: !!user.can_exam,
    lastLoginAt: user.lastLoginAtBJ || user.last_login_at,
    lastActiveAt: user.lastActiveAtBJ || user.last_active_at,
  });
});

// ─── 活跃心跳（浏览/筛选即活跃）──────────────────────
// 前端在"翻页/切换栏目/筛选/搜索输入/切回前台"时调用，使"最近活跃"
// 反映真实使用情况（含仅打开浏览、未做具体内容操作的情形）。
// 服务端限频：距上次记录超过 1 分钟才落库，避免频繁写入。
router.post('/active', authMiddleware, (req, res) => {
  try {
    db.prepare(`UPDATE users SET last_active_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-1 minutes'))`).run(req.user.id);
  } catch (e) {}
  res.json({ ok: true });
});

// ─── 检查token ──────────────────────────────────────
router.get('/check', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

module.exports = router;
