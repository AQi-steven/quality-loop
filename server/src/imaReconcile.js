/**
 * IMA 同步对账（reconciliation / 自愈）
 *
 * 问题背景：
 *   质量宣贯（审核通过放出）与公告（发布）在推 IMA 时，推送逻辑被 try/catch 静默包裹，
 *   任何 IMA/COS 瞬时故障（网络抖动、临时凭证过期、并发限流等）都会导致：
 *     - 宣贯：ima_media_id 残留 NULL，但 status 已是 active（已放出），界面一切正常，
 *       唯有 IMA 知识库里缺了这条；
 *     - 公告：ima_synced 仍为 0，但已 active 放出。
 *   由于当时是「推一次就完」，失败既没重试也没记录，永久丢失同步，且无法被感知。
 *
 * 本模块：
 *   扫描「已放出但未同步 IMA」的记录，逐条重推，写回 media_id / ima_synced。
 *   每条独立 try/catch，单条失败不影响其他条，也不会让进程崩溃；
 *   下次对账（或启动对账）会继续重试，形成自愈闭环。
 *
 * 幂等性：
 *   仅对 ima_media_id 为空（宣贯）/ ima_synced=0（公告）的记录重推。
 *   一旦某次成功写回，后续对账即跳过，不会重复推（IMA 无更新接口，重复推会建副本）。
 */
const db = require('./db/connection');
const ima = require('./ima');

function safeJson(s, def = []) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : def; } catch (e) { return def; }
}

// 组装完整 PDCA 问题对象（与 routes/pdca.js 的 assembleFullProblem 同构），供 pushRenrenjiang 使用
function assembleFullProblem(p) {
  const full = { ...p };
  full.photos = db.prepare('SELECT id, photo_url FROM pdca_photos WHERE problem_id=?').all(p.id);
  full.solutions = db.prepare('SELECT * FROM pdca_solutions WHERE problem_id=? ORDER BY id').all(p.id);
  full.consults = db.prepare('SELECT * FROM pdca_consults WHERE problem_id=? ORDER BY round, id').all(p.id);
  const answers = db.prepare('SELECT * FROM pdca_answers WHERE problem_id=? ORDER BY consult_id, id').all(p.id);
  for (const c of full.consults) c.answers = answers.filter(a => a.consult_id === c.id);
  full.review = db.prepare('SELECT * FROM pdca_reviews WHERE problem_id=?').get(p.id) || null;
  let atts = [];
  try { atts = JSON.parse(p.attachments || '[]'); } catch (e) {}
  if (!Array.isArray(atts)) atts = [];
  full.attachments = atts;
  return full;
}

/**
 * 对账主入口
 * @param {{logger?: object}} [opts] 自定义日志对象（默认 console）
 * @returns {Promise<{dissem:Array,announcements:Array,errors:Array}>}
 */
async function reconcileIma({ logger = console } = {}) {
  const report = { dissem: [], announcements: [], memos: [], pdca: [], pdcaSelected: [], errors: [] };

  // ── 1) 质量宣贯：active 但 ima_media_id 为空 ──
  const diss = db.prepare(
    "SELECT * FROM quality_dissem WHERE status='active' AND (ima_media_id IS NULL OR ima_media_id='')"
  ).all();
  for (const r of diss) {
    try {
      const rr = await ima.pushQualityDissem({
        id: r.id, title: r.title, content: r.content, category: r.category,
        divisions: safeJson(r.divisions), regions: safeJson(r.regions),
        subDivisions: safeJson(r.sub_divisions), publisher: r.publisher,
        publishDate: r.publish_date, expiryDate: r.expiry_date,
        attachments: safeJson(r.attachments),
        existingFolderId: r.ima_folder_id,
      });
      const media = rr.media_id || '';
      if (media) {
        db.prepare(
          'UPDATE quality_dissem SET ima_media_id=?, ima_url=?, ima_folder_id=? WHERE id=?'
        ).run(media, rr.url || '', rr.folderId || r.ima_folder_id || '', r.id);
        report.dissem.push({ id: r.id, title: r.title, media_id: media });
        logger.log(`[IMA对账] 宣贯#${r.id}「${r.title}」已补推 IMA`);
      } else {
        // 推送逻辑没抛异常但返回空 media_id（docx/附件上传在 ima.js 内部被 catch）→ 待下次重试
        report.errors.push({ type: 'dissem', id: r.id, reason: 'IMA 返回空 media_id（docx/附件上传失败，待重试）' });
        logger.error(`[IMA对账] 宣贯#${r.id}「${r.title}」IMA 返回空 media_id，待下次重试`);
      }
    } catch (e) {
      report.errors.push({ type: 'dissem', id: r.id, reason: e && e.message });
      logger.error('[IMA对账] 宣贯#' + r.id + ' 重推失败：', e && e.message);
    }
  }

  // ── 2) 公告：ima_synced=0 且 active ──
  const anns = db.prepare(
    "SELECT * FROM announcements WHERE ima_synced=0 AND status='active'"
  ).all();
  for (const r of anns) {
    try {
      const rr = await ima.pushAnnouncement({
        id: r.id, title: r.title, content: r.content, publisher: r.publisher,
        scope: r.scope, division: r.division, attachments: safeJson(r.attachments),
        created_at: r.created_at, existingFolderId: null, publishDate: r.publish_date, expiryDate: r.expiry_date,
      });
      const media = rr.media_id || '';
      if (media) {
        db.prepare('UPDATE announcements SET ima_synced=1, ima_folder_id=? WHERE id=?')
          .run(rr.folderId || r.ima_folder_id || '', r.id);
        report.announcements.push({ id: r.id, title: r.title, media_id: media });
        logger.log(`[IMA对账] 公告#${r.id}「${r.title}」已补推 IMA`);
      } else {
        report.errors.push({ type: 'announcement', id: r.id, reason: 'IMA 返回空 media_id（待重试）' });
        logger.error(`[IMA对账] 公告#${r.id}「${r.title}」IMA 返回空 media_id，待下次重试`);
      }
    } catch (e) {
      report.errors.push({ type: 'announcement', id: r.id, reason: e && e.message });
      logger.error('[IMA对账] 公告#' + r.id + ' 重推失败：', e && e.message);
    }
  }

  // ── 3) 项目备忘：已发布且 ima_media_id 为空者补推（按项目名自动建文件夹，平铺进该项目文件夹；仅已发布，草稿绝不入 IMA）──
  let memos = [];
  try {
    memos = db.prepare("SELECT * FROM project_memos WHERE status='published' AND (ima_media_id IS NULL OR ima_media_id='')").all();
  } catch (e) { memos = []; }
  for (const r of memos) {
    try {
      const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(r.project_id) || {};
      const recArg = {
        id: r.id, title: r.title, content: r.content, location: r.location, scenario: r.scenario,
        author_name: r.author_name, published_at: r.published_at, created_at: r.created_at,
        photos: safeJson(r.photos), attachments: safeJson(r.attachments),
      };
      const newFid = await ima.ensureProjectFolder(project.name);
      if (project.id && !project.ima_new_folder_id) {
        db.prepare('UPDATE project_memo_projects SET ima_new_folder_id=? WHERE id=?').run(newFid, project.id);
      }
      const rr = await ima.pushMemo(recArg, project, newFid);
      const media = rr.media_id || '';
      if (media) {
        db.prepare('UPDATE project_memos SET ima_media_id=?, ima_url=?, ima_folder_id=? WHERE id=?')
          .run(media, rr.url || '', rr.folderId || '', r.id);
        report.memos.push({ id: r.id, media_id: media });
        logger.log(`[IMA对账] 项目备忘#${r.id} 已补推 IMA（项目文件夹 ${newFid}）`);
      } else {
        report.errors.push({ type: 'memo', id: r.id, reason: 'IMA 返回空 media_id（待重试）' });
        logger.error(`[IMA对账] 项目备忘#${r.id} IMA 返回空 media_id，待下次重试`);
      }
    } catch (e) {
      report.errors.push({ type: 'memo', id: r.id, reason: e && e.message });
      logger.error('[IMA对账] 项目备忘#' + r.id + ' 对账失败：', e && e.message);
    }
  }

  // ── 4) PDCA 人人讲：已闭环且 ima_media_id 为空者补推（与 pdca.js 闭环推送同构）──
  const probs = db.prepare("SELECT * FROM pdca_problems WHERE status='closed' AND (ima_media_id IS NULL OR ima_media_id='')").all();
  for (const p of probs) {
    try {
      const full = assembleFullProblem(p);
      full.existingFolderId = p.ima_folder_id;
      const r = await ima.pushRenrenjiang(full, {});
      const media = r.media_id || '';
      if (media) {
        db.prepare('UPDATE pdca_problems SET ima_media_id=?, ima_folder_id=? WHERE id=?').run(media, r.folderId || p.ima_folder_id || '', p.id);
        report.pdca.push({ id: p.id, title: p.title, media_id: media });
        logger.log(`[IMA对账] PDCA#${p.id}「${p.title}」已补推 IMA 人人讲`);
      } else {
        report.errors.push({ type: 'pdca', id: p.id, reason: 'IMA 返回空 media_id（待重试）' });
        logger.error(`[IMA对账] PDCA#${p.id}「${p.title}」IMA 返回空 media_id，待下次重试`);
      }
    } catch (e) {
      report.errors.push({ type: 'pdca', id: p.id, reason: e && e.message });
      logger.error('[IMA对账] PDCA#' + p.id + ' 重推失败：', e && e.message);
    }
  }

  // ── 5) PDCA 院选：rrj_selected=1 且 ima_selected_media_id 为空者补推（进「03人人讲院选」）──
  const sel = db.prepare("SELECT * FROM pdca_problems WHERE rrj_selected=1 AND (ima_selected_media_id IS NULL OR ima_selected_media_id='')").all();
  for (const p of sel) {
    try {
      const full = assembleFullProblem(p);
      full.existingFolderId = p.ima_folder_id;
      const r = await ima.pushRenrenjiang(full, { selected: true });
      const media = r.media_id || '';
      if (media) {
        db.prepare('UPDATE pdca_problems SET ima_selected_media_id=? WHERE id=?').run(media, p.id);
        report.pdcaSelected.push({ id: p.id, title: p.title, media_id: media });
        logger.log(`[IMA对账] PDCA院选#${p.id}「${p.title}」已补推 IMA 人人讲院选`);
      } else {
        report.errors.push({ type: 'pdcaSelected', id: p.id, reason: 'IMA 返回空 media_id（待重试）' });
        logger.error(`[IMA对账] PDCA院选#${p.id}「${p.title}」IMA 返回空 media_id，待下次重试`);
      }
    } catch (e) {
      report.errors.push({ type: 'pdcaSelected', id: p.id, reason: e && e.message });
      logger.error('[IMA对账] PDCA院选#' + p.id + ' 重推失败：', e && e.message);
    }
  }

  logger.log(`[IMA对账] 完成：宣贯补推 ${report.dissem.length} 条，公告补推 ${report.announcements.length} 条，项目备忘补推 ${report.memos.length} 条，PDCA 补推 ${report.pdca.length} 条，PDCA院选补推 ${report.pdcaSelected.length} 条，失败/待重试 ${report.errors.length} 条`);
  return report;
}

module.exports = { reconcileIma };
