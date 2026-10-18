/**
 * 数据库初始化（独立脚本）
 *
 * 服务器启动时 connection.js 已自动建表，本脚本仅用于：
 *   - 手动确认/dump 表结构
 *   - 在全新数据目录上预创建 schema
 * 直接 require connection 即触发建表 + 默认管理员种子。
 */

const db = require('./connection');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('✅ 数据库就绪:', require('../config').db.path);
console.log('   表数量:', tables.length);
tables.forEach((t) => console.log('   -', t.name));

const admin = db.prepare('SELECT username, real_name, role FROM users WHERE username = ?').get('admin');
if (admin) {
  console.log(`\n   默认管理员: ${admin.real_name} (${admin.username} / ${require('../config').password.defaultPassword})`);
  console.log('   ⚠️  首次登录后请立即修改密码！');
}
