/**
 * SQLite 数据库连接（单例）
 *
 * 使用 Node.js 内置 node:sqlite（纯 JS / WASM 实现，零原生依赖）。
 * 优点：Windows 开发机与 Linux 云服务器行为完全一致，无需编译工具，运维依赖最少。
 * 注意：Node 22 调用 node:sqlite 需加 --experimental-sqlite 启动参数（见 package.json scripts）。
 *
 * WAL 模式支持并发读；连接时自动建表（幂等）。
 */

const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const { createSchema } = require('./schema');

// 确保数据目录存在
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(config.db.path);
// 2026-08-03：由 DELETE 模式切换为 WAL 模式（生产部署 20260803x）。
// 原因：pm2 单实例下，DELETE 模式写者独占锁，多人并发「提交/上传」会串行等待、发涩；
//       WAL 允许「一写多读」并发（读写互不阻塞），是改善多人同时使用体验的最省事手段。
// WAL 安全性说明（澄清既往顾虑）：
//   - 既往担心的「外部脚本写入后数据未 checkpoint 回主库、连接关闭即丢失」仅针对【外部脚本写】；
//     本应用所有写操作都走运行中的服务器进程（单一写入方），外部诊断脚本只读（cd /opt/qc-app/server 后读），不存在外部写入，故安全。
//   - 运行进程能正常读 WAL（node:sqlite 自动读取 -wal/-shm），无需担心读不到。
//   - busy_timeout：写冲突时等待而非立即报 "database is locked"，避免并发提交偶发失败。
//   - wal_autocheckpoint=100：频繁 checkpoint，缩小 -wal 文件窗口；备份须【目录级】拷贝
//     （quality.db + quality.db-wal + quality.db-shm 一并备），否则只 cp 主库会丢最近事务。
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA wal_autocheckpoint=100');
db.exec('PRAGMA foreign_keys=ON');    // 启用外键约束

// 连接即自动建表（服务器启动无需单独跑 init）
createSchema(db);

// ── 适配层 ──────────────────────────────────────────
// node:sqlite 没有提供 .transaction()，这里补齐 better-sqlite3 的同名 API，
// 这样所有路由代码无需改动即可使用：const tx = db.transaction(() => {...}); tx();
// 关键修复：原生不支持嵌套事务（会抛 "cannot start a transaction within a transaction" 致进程崩溃）。
// 这里用 _txDepth 跟踪深度：外层起 BEGIN，嵌套层改用 SAVEPOINT，杜绝嵌套崩溃。
let _txDepth = 0;
db.transaction = (fn) => {
  return (...args) => {
    const nested = _txDepth > 0;
    // 用「预增深度」作为 savepoint 唯一名：同名 SAVEPOINT 在 SQLite 中等同 RELEASE，
    // 若用固定名「qc_tx」，第 3 层及以上嵌套会误释放外层 savepoint，导致回滚层级错乱。
    const spName = 'qc_tx_' + _txDepth;
    if (nested) db.exec('SAVEPOINT ' + spName);
    else db.exec('BEGIN');
    _txDepth++;
    try {
      const result = fn(...args);
      _txDepth--;
      if (nested) db.exec('RELEASE SAVEPOINT ' + spName);
      else db.exec('COMMIT');
      return result;
    } catch (e) {
      _txDepth--;
      if (nested) db.exec('ROLLBACK TO SAVEPOINT ' + spName);
      else db.exec('ROLLBACK');
      throw e;
    }
  };
};

// 确保上传目录存在（multer 需要）
if (!fs.existsSync(config.upload.dir)) {
  fs.mkdirSync(config.upload.dir, { recursive: true });
}

module.exports = db;
