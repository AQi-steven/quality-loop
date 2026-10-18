/**
 * 认证公共 helper（server/src/authHelpers.js）
 * 抽出 token 签发 / 登录记录 / 对外用户对象，供密码登录使用，避免重复实现导致漂移。
 */
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db/connection');

// 安全解析 users.extra_roles（库里出现非法 JSON 时不 500，返回空数组）
function safeExtra(u) {
  try { return u && u.extra_roles ? JSON.parse(u.extra_roles) : []; } catch (e) { return []; }
}

// 对外返回的用户对象（不含敏感字段）
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    realName: user.real_name,
    role: user.role,
    titleTag: user.title_tag,
    division: user.division,
    extraRoles: safeExtra(user),
    department: user.department,
    phone: user.phone,
    isGuest: !!user.is_guest,
    canExam: !!user.can_exam,
  };
}

// 签发 JWT（payload 与密码登录完全一致）
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      realName: user.real_name,
      role: user.role,
      titleTag: user.title_tag,
      division: user.division,
      extraRoles: safeExtra(user),
      isGuest: !!user.is_guest,
      canExam: !!user.can_exam,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

// 记录"真正登录"：更新最后登录/活跃时间 + 写登录流水（供院长查"登录动态"）
function recordLogin(req, user) {
  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  try {
    db.prepare('INSERT INTO login_log (user_id, username, real_name, login_at, ip) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)')
      .run(user.id, user.username, user.real_name, (req && req.ip) || '');
  } catch (e) { /* 流水表缺失也不影响登录 */ }
}

module.exports = { safeExtra, publicUser, signToken, recordLogin };
