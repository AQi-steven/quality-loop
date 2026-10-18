/**
 * 审计日志（操作留痕）
 *
 * 把「谁、在什么时间、对什么对象、做了什么、为何」写进 audit_log 表，
 * 用于事后追溯关键动作（问题闭环 / 院选精选 / 强制关闭 / 宣贯审核·驳回·删除 等）。
 *
 * 设计：
 *   - 仅追加，绝不 UPDATE / DELETE（与 issues 的 ticket_logs 一致）。
 *   - 写入失败静默（绝不因审计失败阻断主流程）。
 *   - actor / actor_role 来自登录态；detail 为可读中文说明。
 */

const db = require('./db/connection');

function audit({ actor, actorRole, action, targetType, targetId, detail }) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor, actor_role, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      actor || '',
      actorRole || '',
      action || '',
      targetType || '',
      targetId === undefined || targetId === null ? '' : String(targetId),
      detail || ''
    );
  } catch (e) {
    console.error('[audit] 写入失败：', e && e.message);
  }
}

module.exports = { audit };
