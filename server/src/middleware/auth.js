/**
 * JWT认证中间件
 *
 * 从Authorization header提取token，验证后注入req.user
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/connection');

module.exports = (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }

  const token = auth.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    // 审计 L-1（2026-09-11）：孤儿令牌防御——令牌签名有效但用户已被删除/停用时，
    // 旧逻辑会把 decoded 直接注入 req.user，下游 me(req) 查库得 undefined，
    // 解引用 u.id 抛 TypeError → 500。这里改为每请求校验用户存在且未停用（主键查询单行，开销可忽略），
    // 一处修复覆盖全部路由，同时实现「停用即踢下线」。
    const u = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(decoded.id);
    if (!u || !u.is_active) {
      return res.status(401).json({ error: '账号不存在或已停用，请重新登录' });
    }
    req.user = decoded;
    // 游客账户：仅 GET 浏览放行；任何写操作（POST/PUT/DELETE/PATCH）一律拦截，防越权。
    // 例外：可考试游客（can_exam=1，如 EXAMGUEST1~EXAMGUEST9）额外放行「检验池」三个考生写接口（start/draft/submit），
    // 使其能参加考试并看排名；其余写操作（含发起/删除考试）仍 403（发起/删除另有 isExamAdmin 兜底拒绝游客）。
    if (req.user.isGuest && req.method !== 'GET') {
      const _p = String(req.originalUrl || '').split('?')[0];
      const _examCandidateWrite = /^\/api\/exam\/rounds\/\d+\/(start|draft|submit)$/.test(_p);
      if (!(req.user.canExam && _examCandidateWrite)) {
        return res.status(403).json({ error: '游客账户仅可浏览，无操作权限' });
      }
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    return res.status(401).json({ error: '无效的登录凭证' });
  }
};
