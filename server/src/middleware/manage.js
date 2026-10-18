/**
 * 管理者权限中间件
 *
 * 允许具备「管理能力」的角色通过：室主任 / 专总 / 院长 / 系统管理员 / 领导
 * （用户管理等超管动作请用 admin.js 中间件）
 */

const rbac = require('../rbac');

module.exports = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: '未登录' });
  }

  if (!rbac.canManage(req.user)) {
    return res.status(403).json({ error: '权限不足' });
  }

  next();
};
