/**
 * 项目工期 数据种子
 *
 * 解析 18 份「建筑-项目梳理_姓名.csv」（腾讯文档导出），
 * 提取每个 (设计师 / 项目 / 阶段) 的里程碑日期，写入 project_tasks 表。
 *
 * 设计要点：
 *   - 读-only：不写回腾讯文档，仅本地同步查看（用户已确认 A 方案）。
 *   - 幂等：每次同步先 DELETE 再 INSERT，可重复执行。
 *   - 日期映射：单元格值为 M.D / M.D-M.D / 暂估X.Y / X.Y（备注），
 *     统一映射为 2026 年（文档为 2026 建筑专业工期梳理）。
 *   - 多行引号/换行安全的 CSV 解析（项目名含换行）。
 */

// 18 位建筑设计师 → 腾讯文档 file_id（统一从 owners.js 取，避免重复维护）
const { OWNER_FILES } = require('../owners');

// ── 引号安全的 CSV 解析（支持字段内换行/逗号）─────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── 解析单元格中的里程碑日期 ───────────────────────
function parseDateCell(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const est = /暂估/.test(s);
  const ms = s.match(/\d{1,2}\.\d{1,2}/g);
  if (!ms || !ms.length) return null;
  const [m, d] = ms[0].split('.').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const noteM = s.match(/（(.+?)）/);
  const note = noteM ? noteM[1] : '';
  return { date, est, note };
}

// ── 主函数：解析全部 CSV 并写入 DB ─────────────────
function seedSchedule(db) {
  const fs = require('fs');
  const path = require('path');
  const rawDir = path.join(__dirname, '..', '..', 'data', 'raw');

  const files = fs.readdirSync(rawDir)
    .filter(f => f.endsWith('.csv') && f !== 'header.csv')
    .sort();

  const insert = db.prepare(`INSERT INTO project_tasks
    (owner_name, source_file, seq, manager, project_name, design_stage, project_type,
     feature, location, work_ratio, outsourced, remark, adjust_coeff,
     milestone_week, milestone_date, milestone_raw, is_estimated, milestone_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const clear = db.prepare('DELETE FROM project_tasks');
  const upsert = db.prepare(`INSERT INTO sync_status (doc_id, last_sync_at, last_sync_rows, sync_type)
    VALUES (?, CURRENT_TIMESTAMP, ?, 'schedule')
    ON CONFLICT(doc_id) DO UPDATE SET last_sync_at=CURRENT_TIMESTAMP, last_sync_rows=excluded.last_sync_rows, sync_type='schedule'`);

  let total = 0;

  const tx = db.transaction(() => {
    clear.run();
    for (const f of files) {
      const owner = f.replace(/\.csv$/, '');
      const text = fs.readFileSync(path.join(rawDir, f), 'utf8');
      const rows = parseCSV(text);
      if (!rows.length) continue;
      // 周轴表头行：含 "M.D-M.D" 的单元格；找不到则视为「无表头」——
      // 模板固定 11 列（序号/设总/项目/阶段/类型/特征/地点/分工/外委/备注/系数，索引 0..10），周列从第 11 列起。
      let header = null, headerIdx = -1, weekIdx = 11;
      for (let ri = 0; ri < rows.length; ri++) {
        const hi = rows[ri].findIndex(h => /^\d{1,2}\.\d{1,2}-\d{1,2}\.\d{1,2}$/.test((h || '').trim()));
        if (hi >= 0) { header = rows[ri]; headerIdx = ri; weekIdx = hi; break; }
      }
      const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;

      let fileCount = 0;
      for (let r = dataStart; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length <= 2) continue;
        const project = (row[2] || '').trim();
        if (!project) continue; // 模板空行
        const manager = (row[1] || '').trim();
        const stage = (row[3] || '').trim();
        const type = (row[4] || '').trim();
        const feature = (row[5] || '').trim();
        const location = (row[6] || '').trim();
        const ratio = (row[7] || '').trim();
        const outsourced = (row[8] || '').trim();
        const remark = (row[9] || '').trim();
        const coeff = (row[10] || '').trim();
        const seq = parseInt(row[0], 10) || 0;

        for (let j = weekIdx; j < row.length; j++) {
          const cell = (row[j] || '').trim();
          if (!cell) continue;
          const pd = parseDateCell(cell);
          if (!pd) continue;
          const hw = header ? (header[j] || '') : '';
          insert.run(owner, f, seq, manager, project, stage, type, feature,
            location, ratio, outsourced, remark, coeff, hw, pd.date, cell, pd.est ? 1 : 0, pd.note);
          fileCount++; total++;
        }
      }
      const fid = OWNER_FILES[owner] || '';
      if (fid) upsert.run(fid, fileCount);
    }
  });

  tx();
  return total;
}

module.exports = { seedSchedule, parseCSV, parseDateCell, OWNER_FILES };
