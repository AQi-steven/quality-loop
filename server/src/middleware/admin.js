/**
 * 管理员权限中间件
 *
 * 用户管理（建号/改密/禁用等）仅开放给：
 *   - admin  （系统管理员账号）
 *   - superadmin   （超级管理员，院长）—— 特批
 * 其余账号（leader / chief / dean / 室主任 / 设计师 / 总工）一律不可访问用户管理 API。
 * （总工经 2026-07-25 院长决策：仅保留专家身份，不给用户管理权）
 */

const ALLOWED_USERS = ['admin', 'superadmin'];

// 游客只读白名单（2026-09-11 用户裁定）：guest9（超级管理员视野游客）可 GET 用户列表 / 最近活跃，
// 仅放行 GET —— 用户管理写操作（POST/PUT）仍一律拒绝。
const GUEST_READ_ONLY = ['guest9'];

module.exports = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: '未登录' });
  }

  if (ALLOWED_USERS.includes(req.user.username)) {
    return next();
  }
  if (req.user.isGuest && GUEST_READ_ONLY.includes(req.user.username) && req.method === 'GET') {
    return next();
  }
  return res.status(403).json({ error: '权限不足' });
};
