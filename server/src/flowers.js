/**
 * 小红花激励体系（共享模块）
 *
 * 发放规则（三档）：
 *   - 质量宣贯：审核通过 / 直接发布  → 发布人得 3 朵；室主任（或兼室主任）只加 1 朵
 *   - 人人讲院选：专总/院长精选已闭环 PDCA → 上报人得 3 朵（同时回撤该问题闭环时的 2 朵，净计 3）
 *   - 普通闭环 PDCA：问题「闭环」(status → closed) → 上报人得 2 朵
 * 幂等：同一 (kind, ref_id) 只发放一次，避免重复 / 重开重关导致通胀。
 * amount：单条发放数量（默认 1，宣贯/院选为 3）。
 */
const db = require('./db/connection');
const institute = require('./institute');

// 不参与小红花评选的岗位（默认：专总/院长/总工/系统管理员/leader）
const FLOWER_EXCLUDE_ROLES = ['chief', 'dean', 'chief_engineer', 'admin', 'leader'];
// 例外白名单：以下用户虽具管理/专总身份，仍参与小红花评选（业务指定：×××/×××/×××）
// 与 summary/adjustments/adjust/me 共用，保证排除集一致性，杜绝「幽灵红花」
const FLOWER_ELIGIBLE_IDS = new Set([83, 11, 55]);
// 不参与小红花评选的专业（2026-10-13 用户裁定：咨询为跨专业聚合维度，不参评排名；与其
//   「不参与筛选 / 提醒 / 排名」授权一致）。与 FLOWER_EXCLUDE_ROLES 并列，杜绝幽灵红花。
// 院级差异外置：值随院不同（科室划分不同），从 institute.config 读取。
const FLOWER_EXCLUDE_DIVISIONS = (institute.flowerExcludeDivisions && institute.flowerExcludeDivisions.length)
  ? institute.flowerExcludeDivisions
  : ['咨询'];
// 是否应排除（不计入评选）。例外名单中的用户始终参与。
function flowerShouldExclude(role, userId) {
  if (userId != null && FLOWER_ELIGIBLE_IDS.has(userId)) return false;
  return FLOWER_EXCLUDE_ROLES.includes(role);
}

function awardFlower({ kind, refId, userName, userId = null, title = '', awardedBy = '', amount = 1 }) {
  try {
    // 内部体验/测试账号永不发花（2026-10-10 用户裁定：不参加任何排名）。
    // 从源头拦，避免产生"排不进榜但数据在表里"的幽灵记录。
    if (userId != null) {
      const t = db.prepare('SELECT title_tag FROM users WHERE id=?').get(userId) || {};
      if (String(t.title_tag || '').trim() === '体验账号') return null;
    } else if (userName) {
      const t = db.prepare('SELECT title_tag FROM users WHERE real_name=?').get(userName) || {};
      if (String(t.title_tag || '').trim() === '体验账号') return null;
    }
    // 不参与小红花评选的岗位其任何行为都不计入统计，故不向其发放小红花
    // 排除集须与 summary/adjustments/adjust/me 保持一致（五类全排除），否则会写入「存在但不显示」的幽灵红花
    const role = userId != null
      ? (db.prepare('SELECT role FROM users WHERE id=?').get(userId) || {}).role
      : (db.prepare('SELECT role FROM users WHERE real_name=?').get(userName) || {}).role;
    if (flowerShouldExclude(role, userId)) return null;
    // 不参与小红花评选的专业（咨询）其任何行为都不计入统计，故不向其发放小红花
    // （与 display / settle 排除集一致，避免写入「存在但不显示」的幽灵记录）
    const div = userId != null
      ? (db.prepare('SELECT division FROM users WHERE id=?').get(userId) || {}).division
      : (db.prepare('SELECT division FROM users WHERE real_name=?').get(userName) || {}).division;
    if (FLOWER_EXCLUDE_DIVISIONS.includes(String(div || '').trim())) return null;
    const ex = db.prepare('SELECT id FROM red_flowers WHERE kind=? AND ref_id=?').get(kind, refId);
    if (ex) return null; // 已发放过，跳过
    const info = db.prepare(
      `INSERT INTO red_flowers (user_id, user_name, kind, ref_id, ref_title, awarded_by, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(userId, userName, kind, refId, title, awardedBy, amount);
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[小红花] 发放失败：', e.message);
    return null;
  }
}

// 删除某类某条目的小红花（用于院选「升级/回撤」时调整）
function removeFlowers(kind, refId) {
  try {
    db.prepare('DELETE FROM red_flowers WHERE kind=? AND ref_id=?').run(kind, refId);
    return true;
  } catch (e) {
    console.error('[小红花] 删除失败：', e.message);
    return false;
  }
}

module.exports = { awardFlower, removeFlowers, FLOWER_ELIGIBLE_IDS, FLOWER_EXCLUDE_ROLES, FLOWER_EXCLUDE_DIVISIONS, flowerShouldExclude, settlePreviousMonth, settleBimonthChampion };

/**
 * 结算「上月月冠军」：统计上一自然月（东八区 +8 hours，与全站展示口径一致）小红花月度总数（含质量工作奖惩）最高的 eligible 用户，
 * 写入 month_champions 表。并列第一者全部记为月冠军。幂等：该月已结算则跳过。
 * 返回 { settled, skipped, month, winners:[{user_name, flower_count}] }
 */
function settlePreviousMonth(database) {
  const conn = database || db;
  // 上一自然月（按东八区/北京时间，与全站展示 +8 hours 一致，避免 UTC 主机下跨日边界误差导致月冠军/月度统计错月）
  const monthStr = conn.prepare("SELECT strftime('%Y-%m','now','+8 hours','-1 month') AS m").get().m;
  const existing = conn.prepare("SELECT month FROM month_champions WHERE month=? AND (type IS NULL OR type='month')").get(monthStr);
  if (existing) return { settled: false, skipped: true, month: monthStr, winners: [] };
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const ELIGIBLE_IDS = [...FLOWER_ELIGIBLE_IDS].join(',');
  // 月度小红花总数 = red_flowers（上月） + flower_adjustments（上月），仅统计 eligible 用户
  // 注意：两张表必须分别聚合后再合并（用 UNION ALL），不能用无条件的跨表 JOIN（会产生笛卡尔积、虚增总数）
  const rows = conn.prepare(`
    SELECT userName, SUM(total) AS total FROM (
      SELECT rf.user_name AS userName, rf.amount AS total
      FROM red_flowers rf
      LEFT JOIN users u ON (rf.user_id = u.id OR rf.user_name = u.real_name)
      WHERE strftime('%Y-%m', rf.created_at, '+8 hours') = '${monthStr}'
        AND (u.id IS NULL OR (u.username != 'admin' AND (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))))
      UNION ALL
      SELECT a.target_name AS userName, a.delta AS total
      FROM flower_adjustments a
      LEFT JOIN users u ON a.target_user_id = u.id
      WHERE strftime('%Y-%m', a.created_at, '+8 hours') = '${monthStr}'
        AND (u.id IS NULL OR (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS})))
    ) GROUP BY userName HAVING total > 0
  `).all();
  // 不参与评选的专业（咨询）排除：避免咨询被列为月冠军（与其不参评口径一致）
  const consultNames = new Set(conn.prepare("SELECT real_name FROM users WHERE division='咨询'").all().map(r => r.real_name));
  const rows2 = rows.filter(r => !consultNames.has(r.userName));
  if (!rows2.length) {
    // 上月无人产生小红花，仍写入一条「空结算」占位以避免每月重复扫描（status='empty'）
    conn.prepare("INSERT INTO month_champions (month, user_name, flower_count, status, type) VALUES (?, '', 0, 'empty', 'month')").run(monthStr);
    return { settled: true, month: monthStr, winners: [], empty: true };
  }
  const max = Math.max(...rows2.map(r => r.total));
  const winners = rows2.filter(r => r.total === max);
  const ins = conn.prepare("INSERT INTO month_champions (month, user_name, flower_count, type) VALUES (?, ?, ?, 'month')");
  const out = [];
  for (const w of winners) {
    ins.run(monthStr, w.userName, w.total);
    out.push({ user_name: w.userName, flower_count: w.total });
  }
  return { settled: true, month: monthStr, winners: out };
}

/**
 * 结算「质量双月冠军」：仅当本次结算的是 10 月（即每年 11 月 1 日触发）时生效。
 * 统计当年 9 月 + 10 月小红花月度总数（含质量工作奖惩）最高的 eligible 用户，
 * 写入 month_champions（type='bimonth', status='settled'）。
 * 与「10 月月冠军」是两条独立记录：同一人若同时是 10 月月冠军与双月冠军，累计 +2 朵👑。
 * 幂等：该年双月已结算则跳过。返回 { settled, skipped, month, winners }。
 */
function settleBimonthChampion(database) {
  const conn = database || db;
  // 特性开关：仅当院级配置开启「质量双月冠军」时才结算（其他院可关，避免无意义的占位记录）。
  // 本院 production 默认开启（qualityCycle.bimonthChampion=true）。
  if (!(institute.qualityCycle && institute.qualityCycle.bimonthChampion)) {
    return { settled: false, skipped: true, reason: 'disabled', month: null, winners: [] };
  }
  // 仅在「上一月 = 10 月」时触发（=11 月 1 日结算 10 月）；其余月份跳过
  const prev = conn.prepare("SELECT strftime('%Y-%m','now','+8 hours','-1 month') AS ym, strftime('%m','now','+8 hours','-1 month') AS m, strftime('%Y','now','+8 hours','-1 month') AS y").get();
  if (prev.m !== '10') return { settled: false, skipped: true, reason: 'not-october', month: null, winners: [] };
  const monthStr = prev.ym; // 'YYYY-10'，关联到 10 月结算月
  const year = prev.y;
  const existing = conn.prepare("SELECT month FROM month_champions WHERE month=? AND type='bimonth'").get(monthStr);
  if (existing) return { settled: false, skipped: true, month: monthStr, winners: [] };
  const EXCLUDE = FLOWER_EXCLUDE_ROLES;
  const ELIGIBLE_IDS = [...FLOWER_ELIGIBLE_IDS].join(',');
  const rows = conn.prepare(`
    SELECT userName, SUM(total) AS total FROM (
      SELECT rf.user_name AS userName, rf.amount AS total
      FROM red_flowers rf
      LEFT JOIN users u ON (rf.user_id = u.id OR rf.user_name = u.real_name)
      WHERE strftime('%Y', rf.created_at, '+8 hours') = '${year}'
        AND strftime('%m', rf.created_at, '+8 hours') IN ('09','10')
        AND (u.id IS NULL OR (u.username != 'admin' AND (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS}))))
      UNION ALL
      SELECT a.target_name AS userName, a.delta AS total
      FROM flower_adjustments a
      LEFT JOIN users u ON a.target_user_id = u.id
      WHERE strftime('%Y', a.created_at, '+8 hours') = '${year}'
        AND strftime('%m', a.created_at, '+8 hours') IN ('09','10')
        AND (u.id IS NULL OR (u.role IS NULL OR u.role NOT IN (${EXCLUDE.map(r => `'${r}'`).join(',')}) OR u.id IN (${ELIGIBLE_IDS})))
    ) GROUP BY userName HAVING total > 0
  `).all();
  // 不参与评选的专业（咨询）排除：避免咨询被列为双月冠军（与其不参评口径一致）
  const consultNames = new Set(conn.prepare("SELECT real_name FROM users WHERE division='咨询'").all().map(r => r.real_name));
  const rows2 = rows.filter(r => !consultNames.has(r.userName));
  if (!rows2.length) {
    conn.prepare("INSERT INTO month_champions (month, user_name, flower_count, status, type) VALUES (?, '', 0, 'empty', 'bimonth')").run(monthStr);
    return { settled: true, month: monthStr, winners: [], empty: true };
  }
  const max = Math.max(...rows2.map(r => r.total));
  const winners = rows2.filter(r => r.total === max);
  const ins = conn.prepare("INSERT INTO month_champions (month, user_name, flower_count, type) VALUES (?, ?, ?, 'bimonth')");
  const out = [];
  for (const w of winners) {
    ins.run(monthStr, w.userName, w.total);
    out.push({ user_name: w.userName, flower_count: w.total });
  }
  return { settled: true, month: monthStr, winners: out };
}
