/**
 * 管理员路由
 *
 * 管理员分配账号、管理用户
 * - GET    /admin/users         获取用户列表
 * - POST   /admin/users         创建新用户
 * - PUT    /admin/users/:id     更新用户信息
 * - PUT    /admin/users/:id/reset-pwd  重置用户密码
 * - PUT    /admin/users/:id/toggle-active  启用/禁用用户
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

// 安全解析 users.extra_roles：与 auth.js 对齐，防止库里非法 JSON 导致用户列表 500
const safeExtra = (u) => {
  try { return u && u.extra_roles ? JSON.parse(u.extra_roles) : []; } catch (e) { return []; }
};

const router = express.Router();

// 所有管理员路由都需要登录 + admin/leader权限
router.use(authMiddleware, adminMiddleware);

// 将数据库行(蛇形字段)映射为前端期望的驼峰字段
function mapUser(u) {
  return {
    id: u.id,
    username: u.username,
    realName: u.real_name,
    role: u.role,
    titleTag: u.title_tag,
    division: u.division,
    department: u.department,
    phone: u.phone,
    extraRoles: safeExtra(u),
    mustChangePwd: !!u.must_change_pwd,
    isActive: !!u.is_active,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

// ─── 最近一个月登录动态（仅 superadmin / 系统管理员可见，供院长掌握活跃情况）───
// 返回：最近 30 天内有活跃记录的用户，整体按最近一次活跃倒序。
// 前端默认折叠展示近 7 天（"最长可点开扩展"），后端一次返回 30 天全量，由前端按需展开。
router.get('/login-activity', (req, res) => {
  try {
    // 以"最近活跃(last_active_at)"为主：App 每次打开走 /me 续期即更新，
    // 故能反映真实使用情况（含 token 续期进来的活跃），而非仅"输密码登录"。
    const rows = db.prepare(`
      SELECT u.id AS userId, u.real_name AS realName, u.username AS username,
             datetime(u.last_active_at, '+8 hours') AS lastActiveAt,
             datetime(u.last_login_at, '+8 hours') AS lastLoginAt
      FROM users u
      WHERE u.is_active = 1
        AND u.username NOT IN ('superadmin', 'admin')
        AND COALESCE(u.is_guest,0) = 0
        AND u.last_active_at IS NOT NULL
        AND u.last_active_at >= datetime('now', '-30 days')
      ORDER BY u.last_active_at DESC
    `).all();
    const list = rows.map(x => ({
      name: x.realName,
      username: x.username,
      lastActiveAt: x.lastActiveAt || '',
      lastLoginAt: x.lastLoginAt || '',
    }));
    res.json({ list, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[login-activity]', e && e.message);
    res.status(500).json({ error: '查询登录动态失败' });
  }
});

// ─── 获取用户列表 ────────────────────────────────────
router.get('/users', (req, res) => {
  const { role, department, active } = req.query;

  let sql = 'SELECT id, username, real_name, role, extra_roles, title_tag, department, division, phone, must_change_pwd, is_active, datetime(last_login_at, \'+8 hours\') AS last_login_at, created_at FROM users WHERE 1=1 AND COALESCE(is_guest,0)=0';
  const params = [];

  if (role) {
    sql += ' AND role = ?';
    params.push(role);
  }
  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }
  if (active !== undefined) {
    sql += ' AND is_active = ?';
    params.push(active === '1' ? 1 : 0);
  }

  sql += ' ORDER BY role ASC, real_name ASC';

  const users = db.prepare(sql).all(...params);
  res.json(users.map(mapUser));
});

// ─── 批量创建用户 ────────────────────────────────────
const VALID_ROLES = ['designer', 'section_leader', 'chief', 'chief_engineer', 'dean', 'leader', 'admin'];

router.post('/users', (req, res) => {
  const { users } = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: '请提供用户列表' });
  }

  // 验证每个用户的必填字段
  for (const u of users) {
    if (!u.username || !u.realName) {
      return res.status(400).json({ error: `用户名和真实姓名为必填 (${JSON.stringify(u)})` });
    }
    if (!VALID_ROLES.includes(u.role || 'designer')) {
      return res.status(400).json({ error: `无效角色: ${u.role}` });
    }
    // 附加身份（双身份，如 专总+室主任）必须为合法角色
    if (u.extraRoles && Array.isArray(u.extraRoles)) {
      for (const r of u.extraRoles) {
        if (!VALID_ROLES.includes(r)) {
          return res.status(400).json({ error: `无效附加角色: ${r}` });
        }
      }
    }
  }

  const insert = db.prepare(`
    INSERT INTO users (username, password_hash, real_name, role, title_tag, department, phone, extra_roles, division, must_change_pwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const results = [];
  const errors = [];

  const insertMany = db.transaction(() => {
    for (const u of users) {
      try {
        const hash = bcrypt.hashSync(config.password.defaultPassword, config.password.bcryptRounds);
        const ex = (u.extraRoles && Array.isArray(u.extraRoles)) ? JSON.stringify(u.extraRoles) : '[]';
        const info = insert.run(
          u.username,
          hash,
          u.realName,
          u.role || 'designer',
          u.titleTag || '',
          u.department || '',
          u.phone || '',
          ex,
          u.division || ''
        );
        results.push({ id: info.lastInsertRowid, username: u.username, realName: u.realName });
      } catch (err) {
        if (err.message.includes('UNIQUE')) {
          errors.push({ username: u.username, error: '用户名已存在' });
        } else {
          errors.push({ username: u.username, error: err.message });
        }
      }
    }
  });

  insertMany();

  res.json({
    created: results,
    errors: errors,
    defaultPassword: config.password.defaultPassword,
  });
});

// ─── 更新用户信息 ────────────────────────────────────
router.put('/users/:id', (req, res) => {
  const { id } = req.params;
  const { realName, role, titleTag, department, phone, division } = req.body;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 注意：division / department 允许显式置空（传 '' 即清空），故不用 `|| null` 兜底
  const divisionVal = division !== undefined ? division : null;
  const departmentVal = department !== undefined ? department : null;
  db.prepare(`
    UPDATE users SET
      real_name = COALESCE(?, real_name),
      role = COALESCE(?, role),
      title_tag = COALESCE(?, title_tag),
      department = COALESCE(?, department),
      division = COALESCE(?, division),
      phone = COALESCE(?, phone),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(realName || null, role || null, titleTag !== undefined ? titleTag : null, departmentVal, divisionVal, phone || null, id);

  res.json({ message: '更新成功' });
});

// ─── 重置用户密码 ────────────────────────────────────
router.put('/users/:id/reset-pwd', (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const pwd = newPassword || config.password.defaultPassword;
  const hash = bcrypt.hashSync(pwd, config.password.bcryptRounds);
  db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(hash, id);

  res.json({ message: '密码已重置', newPassword: pwd });
});

// ─── 启用/禁用用户 ────────────────────────────────────
router.put('/users/:id/toggle-active', (req, res) => {
  const { id } = req.params;

  const user = db.prepare('SELECT id, is_active FROM users WHERE id = ?').get(id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const newActive = user.is_active ? 0 : 1;
  db.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newActive, id);

  res.json({ message: newActive ? '已启用' : '已禁用', isActive: !!newActive });
});

module.exports = router;
