/**
 * 质量宣贯 / 质量库 路由
 *
 *  质量宣贯：首页版块，任何人可提交；设计师身份提交需经专业室主任/专总审核通过后放出，按专业室多选、可设公示期，到期自动进入质量库。
 *  质量库：统一检索视图（质量宣贯 + 人人讲），支持 分类 / 专业室 / 地区 / 发布日期 筛选。
 *
 *  GET    /                     首页可见的「质量宣贯」（active，按 viewer 的 division 过滤）
 *  GET    /library              统一质量库（质量宣贯 expired/active + 人人讲），支持筛选
 *  GET    /filters              筛选维度元数据（categories / divisions / regions）
 *  GET    /mine                 我发布的宣贯（管理用）
 *  POST   /                     提交宣贯（任何人）；管理者直接放出+IMA，设计师进入待审核
 *  GET    /pending              待审核队列（管理者）
 *  POST   /:id/approve          审核通过并放出（管理者）
 *  POST   /:id/reject          驳回（管理者）
 *  DELETE /:id                  删除（仅 系统管理员/院长/专总 可删任意；其余角色仅可撤回自己未发布的宣贯）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');
const ima = require('../ima');
const push = require('../wechat/push');
const { awardFlower, removeFlowers } = require('../flowers');
const { audit } = require('../audit');

// 列表接口单页上限：分页 limit 服务端 clamp，仅作「防 ?limit=99999 一次拉全表 OOM」的护栏。
//   2026-09-16：由 200 提到 1000。原 200 会与「关键词搜索靠前端拉全量本地过滤」的写法叠加，
//   使条数一超 200 搜索就静默漏结果。现关键词已改服务端过滤 + 分页（见 /library 的 kw 参数），
//   能否「看全」不再依赖单页上限；此值只决定单次最多取多少条，正常使用（含逐页翻到底）不会触及。
const MAX_LIST_LIMIT = 1000;
const { visibleDivisions, DIVISION_SUBS, orderDivisions } = require('../divisions');

const router = express.Router();
router.use(authMiddleware);

function me(req) {
  return db.prepare('SELECT id, role, extra_roles, division, real_name, username FROM users WHERE id = ?').get(req.user.id);
}
// 解析 users.extra_roles（库里可能为 JSON 字符串或数组，容错）
function parseExtra(u) {
  if (!u) return [];
  const ex = u.extra_roles;
  if (Array.isArray(ex)) return ex;
  try { return JSON.parse(ex || '[]'); } catch (e) { return []; }
}
// 室主任（或兼室主任）发布的宣贯只加 1 朵小红花；其余身份 3 朵。
// 判定：主 role='section_leader'，或 extra_roles 含 'section_leader'（兼室主任，如专总叠加室主任）。
function dissemFlowerAmount(publisherUserOrId) {
  let role = null, ex = [];
  if (publisherUserOrId && typeof publisherUserOrId === 'object') {
    role = publisherUserOrId.role;
    ex = parseExtra(publisherUserOrId);
  } else if (publisherUserOrId) {
    const u = db.prepare('SELECT role, extra_roles FROM users WHERE id=?').get(publisherUserOrId);
    if (u) { role = u.role; ex = parseExtra(u); }
  }
  return (role === 'section_leader' || ex.includes('section_leader')) ? 1 : 3;
}
function safeJson(s, def = []) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : def; } catch (e) { return def; }
}
// 纵深防御：净化「专业室 / 地区 / 二级专业」数组元素，剔除可构成 HTML/脚本注入的尖括号，
// 防止发布者（含室主任/专总/院长可直发）通过未转义字段存储 XSS（见 #535）。
function sanitizeStrArray(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(x => String(x).replace(/[<>]/g, ''))
    .filter(Boolean);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
// 公示期计算：自定义日期优先；否则按天数累加。2026-09-13 取消「长久（永久）」选项，默认 2 个月（60 天）。
// 'long'/'长久'/非法值一律按 60 天处理，不再生成永久不过期的帖子。
function computeExpiry(pub, durationDays, expiry_date) {
  if (expiry_date && String(expiry_date).trim()) return String(expiry_date).trim().slice(0, 10);
  const d = Number(durationDays);
  const days = (Number.isFinite(d) && d > 0) ? d : 60;
  return addDays(pub, days);
}

// 宣贯审核范围（与 GET /pending 完全一致）：
//  - 系统管理员 / 院长 / 专总（含 isSuper）→ 全范围（任何专业室 + 全员）
//  - 专业室主任（section_leader 且非院领导）→ 仅本科室（divisions 含本人 division）或 全员(空 divisions) 的宣贯
//  - 其余（设计师 / 总工 等）→ 无审核权
// 既用于待审列表过滤，也用于 approve/reject 的二次校验，杜绝"列表按科室、直调接口却可跨科室审核"。
function canReviewDissem(u, rec) {
  if (rbac.isSuper(u) || rbac.canPublishAll(u)) return true;
  if (rbac.canManage(u) && rbac.rolesOf(u).includes('section_leader') && !rbac.hasAllDivisions(u)) {
    const divs = safeJson(rec.divisions);
    const myDiv = (u.division || '').trim();
    return divs.length === 0 || (myDiv && divs.includes(myDiv));
  }
  return false;
}

// 自动归档：过期且仍 active 的宣贯 → archived（保留在质量库，仅首页不再展示）
function autoArchive() {
  db.prepare("UPDATE quality_dissem SET status='archived' WHERE status='active' AND expiry_date IS NOT NULL AND date(expiry_date) < date('now')").run();
}

// 首页可见宣贯：
//  管理者看全部 active；
//  设计师默认只看 divisions 含本人室 或 divisions 为空（全员）的 active；
//  但若主动勾选了 专业室/地区 筛选，则以筛选为准（可跨室查看，满足"只看某室/某地区"）。
//  作者本人额外可见自己提交的「待审核 / 未通过」项（便于跟踪审核状态）。
router.get('/', (req, res) => {
  autoArchive();
  const { division = '', region = '', limit = '', offset = '' } = req.query;
  const selDivs = String(division).split(',').map(s => s.trim()).filter(Boolean);
  const selRegs = String(region).split(',').map(s => s.trim()).filter(Boolean);
  // 排序口径与质量库统一（2026-09-23）：首页「最新宣贯」也按「最后一环批准时刻」降序，
  //   即 COALESCE(reviewed_at, created_at)——设计师发布的取审核通过时刻，直发（免审）的取发布时刻。
  const rows = db.prepare("SELECT * FROM quality_dissem WHERE status='active' ORDER BY COALESCE(reviewed_at, created_at) DESC, created_at DESC LIMIT 200").all();
  const u = me(req);

  let list = rows;
  // 应用主动筛选：维度内 OR，维度间 AND（不选则不过滤）
  // 「不选 = 全看」：未主动勾选任何筛选维度时，所有角色（含设计师）均可见全部 active 宣贯
  list = list.filter(r => {
    const divs = safeJson(r.divisions);
    const regs = safeJson(r.regions);
    if (selDivs.length && !divs.some(d => selDivs.includes(d))) return false;
    if (selRegs.length && !regs.some(x => selRegs.includes(x))) return false;
    return true;
  });
  // 作者本人可见自己提交的「待审核 / 未通过」项（便于跟踪状态）
  const mine = db.prepare('SELECT * FROM quality_dissem WHERE publisher_id=? AND status IN (\'pending\',\'rejected\') ORDER BY created_at DESC').all(u.id);
  for (const m of mine) if (!list.find(x => x.id === m.id)) list.push(m);
  // 可选分页：传 limit 时按 limit/offset 截断；不传则与历史行为完全一致（前台零影响）
  if (limit !== '' && Number(limit) > 0) {
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.min(Number(limit), MAX_LIST_LIMIT);
    list = list.slice(off, off + lim);
  }
  res.json(list.map(r => ({ ...r, canEdit: rbac.canEditContent(u, r) })));
});

// 统一质量库（可筛选；category/division/region 均支持逗号分隔多选：维度内 OR，维度间 AND）
router.get('/library', (req, res) => {
  autoArchive();
  const { category = '', division = '', region = '', from = '', to = '', source = '', subDivision = '', limit = '', offset = '', kw = '' } = req.query;
  const selCats = String(category).split(',').map(s => s.trim()).filter(Boolean);
  const selDivs = String(division).split(',').map(s => s.trim()).filter(Boolean);
  const selRegs = String(region).split(',').map(s => s.trim()).filter(Boolean);
  const selSubs = String(subDivision).split(',').map(s => s.trim()).filter(Boolean);
  // 同一套收集逻辑跑两遍（2026-09-15）：
  //   applyDivFilter=true  → 当前筛选结果（专业多选生效）
  //   applyDivFilter=false → 仅忽略「专业」自身多选、其余筛选照常的基准集，用于算各一级专业条数
  //   （faceted count：勾了「暖通」后，数字仍应显示每个专业各自的条数，而非只留暖通）
  // 关键词（kw）：2026-09-16 起改由服务端过滤。
  //   旧做法是「前端一次拉 limit=200 的全量再本地过滤」——条数一旦超过 200，搜索就会静默漏结果；
  //   且前端只能拿到 140 字的摘要（summary），命中面比完整正文窄。
  //   现由服务端按「完整正文」匹配，并让 kw 参与分页与 facet 计数 → 搜索结果完整、可翻页、无条数上限。
  const kwStr = String(kw || '').trim().toLowerCase();
  const hitKw = (parts) => {
    if (!kwStr) return true;
    return parts.filter(Boolean).join(' ').toLowerCase().includes(kwStr);
  };
  const collect = (applyDivFilter) => {
    const items = [];

    if (!source || source === 'dissem') {
      // 质量库统一检索：只放「已沉淀的有效宣贯」—— 排除 未通过(rejected) / 已软删(deleted) / 待审(pending)。
      //   ⚠️ 2026-09-15 修正：原先漏排 pending，导致「提交待审」的宣贯也会进质量库
      //      （且前端状态标只认 active/archived，会被误渲染成「已归档」），
      //      同时使质量库条数 > 首页「共 N」——而首页计数(/api/stats/home)与简报口径本就排除 pending。
      //      现三处口径统一为：排除 deleted / rejected / pending，含 active 与到期归档 archived。
      //   ⚠️ 同轮：去掉内层 LIMIT 200。该上限会让 total / facet 角标 / 翻页在条数超过 200 后被静默截断
      //      （宣贯到期归档后仍沉淀质量库，条数只会单调增长，长期必然越过 200），
      //      改为完全由外层 limit/offset 控制页大小（页大小仍受 MAX_LIST_LIMIT 约束）。
      const rows = db.prepare("SELECT * FROM quality_dissem WHERE status NOT IN ('rejected','deleted','pending') ORDER BY publish_date DESC, created_at DESC").all();
      for (const r of rows) {
        const divs = safeJson(r.divisions);
        const regs = safeJson(r.regions);
        const subs = safeJson(r.sub_divisions);
        if (selCats.length && !selCats.includes(r.category)) continue;
        if (applyDivFilter && selDivs.length && !divs.some(d => selDivs.includes(d))) continue;
        if (selRegs.length && !regs.some(x => selRegs.includes(x))) continue;
        if (selSubs.length && !subs.some(s => selSubs.includes(s))) continue;
        // 筛选区间与排序/展示同源（2026-09-23）：区间也按「最后一环批准时刻」切分，
        //   否则会出现「按 9 月筛选却返回显示 8 月」的口径矛盾（设计师宣贯的审核时刻常晚于发布日）。
        const pub = ((r.reviewed_at || r.created_at || '')).slice(0, 10);
        if (from && pub && pub < from) continue;
        if (to && pub && pub > to) continue;
        if (!hitKw([r.title, r.content, r.category, r.publisher, divs.join(' '), regs.join(' '), subs.join(' ')])) continue;
        items.push({
          id: r.id, source: 'dissem', title: r.title,
          summary: r.content ? r.content.slice(0, 140) : '',
          category: r.category, divisions: divs, regions: regs, subDivisions: subs,
          // 排序/展示统一取「最后一环批准时刻」（2026-09-23）：设计师发布取审核通过时间 reviewed_at，
          //   专总/室主任/院长直发（免审）本列为 NULL → 兜底取发布时间 created_at（发布即生效）。
          publisher: r.publisher, publishDate: r.reviewed_at || r.created_at,
          status: r.status, imaUrl: r.ima_url,
          requireAck: (r.require_ack === 0 || r.require_ack === false) ? 0 : 1,
          managerNote: r.manager_note || '',
          managerNoteBy: r.manager_note_by || '',
          managerNoteAt: r.manager_note_at || '',
        });
      }
    }

    if (!source || source === 'renrenjiang') {
      // 人人讲 = 已闭环的 PDCA 问题（复盘贴 IMA 后自动闭环，即"人人讲"）。
      // 院选(rrj_selected=1)的帖由管理者在院选时调整过专业/地区/类型/备注，其 curated 字段已直接写回
      // pdca_problems，故此处读取即"用院选版替换原版"（一条问题仅一行，天然去重）。
      // closed_at：人人讲的「最后一环批准」时刻（2026-09-23 起质量库排序/展示统一按闭环时间）
      const rows = db.prepare("SELECT id,title,description,reporter,created_at,closed_at,category,division,region,sub_division,divisions,sub_divisions,manager_note,manager_note_by,manager_note_at,rrj_selected,ima_media_id,ima_selected_media_id FROM pdca_problems WHERE status='closed' ORDER BY created_at DESC").all();
      for (const r of rows) {
        const rcat = r.category || '质量人人讲';
        const divs = safeJson(r.divisions).length ? safeJson(r.divisions) : ((r.division || '').trim() ? [r.division.trim()] : []);
        const rreg = (r.region || '').trim();
        const subs = safeJson(r.sub_divisions).length ? safeJson(r.sub_divisions) : ((r.sub_division || '').trim() ? [r.sub_division.trim()] : []);
        if (selCats.length && !selCats.includes(rcat)) continue;
        if (applyDivFilter && selDivs.length && !divs.some(d => selDivs.includes(d))) continue;
        if (selRegs.length && !(rreg && selRegs.includes(rreg))) continue;
        if (selSubs.length && !subs.some(s => selSubs.includes(s))) continue;
        // 筛选区间与排序/展示同源（2026-09-23）：人人讲按「闭环时间」切分（与 publishDate 一致）
        const pub = ((r.closed_at || r.created_at || '')).slice(0, 10);
        if (from && pub && pub < from) continue;
        if (to && pub && pub > to) continue;
        if (!hitKw([r.title, r.description, rcat, r.reporter, divs.join(' '), rreg, subs.join(' ')])) continue;
        items.push({
          id: r.id, source: 'renrenjiang', title: r.title,
          summary: r.description ? r.description.slice(0, 140) : '',
          category: rcat, divisions: divs, regions: rreg ? [rreg] : [],
          subDivisions: subs,
          // 人人讲统一按「闭环时间」排序/展示（2026-09-23 用户裁定：不区分是否院选）
          publisher: r.reporter, publishDate: r.closed_at || r.created_at,
          status: 'active', imaUrl: '',
          requireAck: (r.require_ack === 0 || r.require_ack === false) ? 0 : 1,
          rrjSelected: !!r.rrj_selected,
          managerNote: r.manager_note || '',
          managerNoteBy: r.manager_note_by || '',
          managerNoteAt: r.manager_note_at || '',
          imaSelectedMediaId: r.ima_selected_media_id || '',
        });
      }
    }

    // 公告（全员 / 专业室公告）：只要生成即进入质量库，与宣贯、人人讲统一检索
    // 修复：排除已软删(status='deleted')的公告——在首页删除后，质量库同步消失（与宣贯段口径一致）；
    //       归档(archived)仍沉淀在质量库（首页隐藏、质量库可见，保留历史）。
    if (!source || source === 'announcement') {
      const rows = db.prepare("SELECT * FROM announcements WHERE status != 'deleted' ORDER BY created_at DESC").all();
      for (const r of rows) {
        const divs = r.division ? [r.division] : [];
        const regs = [];
        if (selCats.length && !selCats.includes('公告')) continue;
        if (applyDivFilter && selDivs.length && !divs.some(d => selDivs.includes(d))) continue;
        if (selRegs.length && !regs.some(x => selRegs.includes(x))) continue;
        const pub = (r.created_at || '').slice(0, 10);
        if (from && pub && pub < from) continue;
        if (to && pub && pub > to) continue;
        if (!hitKw([r.title, r.content, '公告', r.publisher, divs.join(' ')])) continue;
        items.push({
          id: r.id, source: 'announcement', title: r.title,
          summary: r.content ? r.content.slice(0, 140) : '',
          category: '公告', divisions: divs, regions: regs,
          publisher: r.publisher, publishDate: r.created_at,
          status: r.status || 'active', imaUrl: '', imaSynced: !!r.ima_synced,
          requireAck: (r.require_ack === 0 || r.require_ack === false) ? 0 : 1,
        });
      }
    }

    return items;
  };

  const items = collect(true);
  // 各一级专业条数（仅当选中专业时才需要另一份基准；未选专业时两份结果集完全相同）
  const facetBase = selDivs.length ? collect(false) : items;
  const divisionCounts = {};
  let noDivisionCount = 0;
  for (const it of facetBase) {
    const ds = it.divisions || [];
    if (!ds.length) { noDivisionCount++; continue; }
    // 一条内容挂多个专业时，每个专业各计 1（与筛选「维度内 OR」语义一致，故各专业之和 ≥ 总条数）
    for (const d of ds) divisionCounts[d] = (divisionCounts[d] || 0) + 1;
  }

  items.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
  // 可选分页：传 limit 时返回 {items,total,hasMore}（前台"加载更多"用）；不传则返回纯数组（历史兼容，前台零影响）
  if (limit !== '' && Number(limit) > 0) {
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.min(Number(limit), MAX_LIST_LIMIT);
    const paged = items.slice(off, off + lim);
    return res.json({ items: paged, total: items.length, hasMore: off + lim < items.length, limit: lim, offset: off,
      divisionCounts, noDivisionCount, facetTotal: facetBase.length });
  }
  res.json(items);
});

// 筛选维度元数据（与发布表单选项保持一致）
const QC_CATS = ['标准规范', '质量要求', '优秀经验', '惨痛教训', '质量问答'];
const QC_REGS = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
router.get('/filters', (req, res) => {
  const divs = db.prepare("SELECT DISTINCT division FROM users WHERE division IS NOT NULL AND division != ''").all().map(x => x.division);
  res.json({ categories: QC_CATS, divisions: orderDivisions(divs), regions: QC_REGS, divisionSubs: DIVISION_SUBS });
});

// 我发布的
router.get('/mine', (req, res) => {
  const u = me(req);
  const rows = db.prepare('SELECT * FROM quality_dissem WHERE publisher_id=? ORDER BY created_at DESC LIMIT 200').all(u.id);
  res.json(rows);
});

// 待审核队列（管理者可见）
//  专总 / 院长 / 系统管理员(leader)：见全部待审；
//  室主任：仅见面向本人专业室 或 全院的待审项（"对应"专业室主任）。
router.get('/pending', (req, res) => {
  const u = me(req);
  if (!rbac.canManage(u)) return res.status(403).json({ error: '权限不足' });
  const rows = db.prepare('SELECT * FROM quality_dissem WHERE status=\'pending\' ORDER BY created_at DESC LIMIT 200').all();
  // 与 approve/reject 共用同一审核范围判定（专业室主任仅本科室 + 全员）
  const list = rows.filter(r => canReviewDissem(u, r));
  res.json(list.map(r => ({ ...r, divisions: safeJson(r.divisions), regions: safeJson(r.regions) })));
});

// 发布（所有人可提交；设计师提交进入待审核，管理者直接放出）
router.post('/', async (req, res) => {
  const { title, content, category = '通用', divisions = [], regions = [], subDivisions = [], durationDays = 60, publish_date = '', expiry_date = '', attachments = [], photos = [], require_ack = 1 } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: '标题和内容为必填' });
  const u = me(req);
  // publish_date 默认取北京时间日期（strftime '+8 hours'），避免 UTC toISOString 在
  // 北京凌晨 0–8 点发帖时把日期算成前一天，导致公示期/质量库日期筛选跨日偏差。
  const pub = (publish_date || '').slice(0, 10) || db.prepare("SELECT strftime('%Y-%m-%d','now','+8 hours') t").get().t;
  const exp = computeExpiry(pub, durationDays, expiry_date);
  const divArr = sanitizeStrArray(divisions);
  const regArr = sanitizeStrArray(regions);
  const subArr = sanitizeStrArray(subDivisions);
  const atts = Array.isArray(attachments) ? attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' })) : [];
  const phs = Array.isArray(photos) ? photos.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' })) : [];
  const isDirect = rbac.canPublishDissem(u); // 院长 / 专总 / 室主任 直接放出；设计师提交需审核
  const status = isDirect ? 'active' : 'pending';
  const info = db.prepare(
    `INSERT INTO quality_dissem (title, content, publisher, publisher_id, publisher_role, category, divisions, regions, sub_divisions, publish_date, expiry_date, status, attachments, photos, require_ack)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title.trim(), content.trim(), u.real_name, u.id, u.role, category, JSON.stringify(divArr), JSON.stringify(regArr), JSON.stringify(subArr), pub, exp, status, JSON.stringify(atts), JSON.stringify(phs), (require_ack === 0 || require_ack === false) ? 0 : 1);
  const id = info.lastInsertRowid;

  let imaUrl = '', imaMedia = '';
  let flower = 0;
  if (isDirect) {
    // 直接放出才同步 IMA 千里行质量库；待审核项审核通过后再同步
    try {
      const r = await ima.pushQualityDissem({
        id, title: title.trim(), content: content.trim(), category,
        divisions: divArr, regions: regArr, subDivisions: subArr, publisher: u.real_name, publishDate: pub, expiryDate: exp,
        attachments: atts,
      });
      imaUrl = r.url || ''; imaMedia = r.media_id || '';
      db.prepare('UPDATE quality_dissem SET ima_media_id=?, ima_url=? WHERE id=?').run(imaMedia, imaUrl, id);
      if (r.folderId) db.prepare('UPDATE quality_dissem SET ima_folder_id=? WHERE id=?').run(r.folderId, id);
    } catch (e) {
      console.error('[质量宣贯] IMA 推送失败：', e.message);
    }
    // 直接发布也发放小红花：室主任（或兼室主任）只加 1 朵，其余 3 朵
    const dissemAmt = dissemFlowerAmount(u);
    if (awardFlower({ kind: 'dissem', refId: id, userName: u.real_name, userId: u.id, title: title.trim(), awardedBy: u.real_name, amount: dissemAmt })) flower = dissemAmt;
  }
  const imaSynced = !!imaMedia;
  // 待审核：通知所有具审核权的在岗用户（室主任/专总/院长），提示有新宣贯待审核
  if (!isDirect) {
    try {
      const reviewers = db.prepare(
        `SELECT id, serverchan_key, role, extra_roles, division FROM users WHERE is_active=1 AND role IN ('section_leader','chief','dean')`
      ).all();
      for (const rv of reviewers) {
        if (rv.id === u.id) continue; // 不通知提交者本人
        // 纯室主任（非兼专总）仅通知本科室或全员(divisions 为空)宣贯
        if (rv.role === 'section_leader') {
          let er = [];
          try { er = JSON.parse(rv.extra_roles || '[]'); } catch (e) { er = []; }
          if (!er.includes('chief')) {
            const rvDiv = (rv.division || '').trim();
            const matchAll = divArr.length === 0;
            const matchDiv = rvDiv && divArr.includes(rvDiv);
            if (!matchAll && !matchDiv) continue;
          }
        }
        if (rv.serverchan_key) {
          push.pushToUser(rv, '宣贯审核提醒', `【质量千里行】有新宣贯待你审核：${title.trim()}\n提交人：${u.real_name}`).catch(() => {});
        }
      }
    } catch (e) { console.error('[宣贯] 微信审核提醒失败：', e.message); }
  }
  res.json({ id, status, message: isDirect ? '已发布' : '已提交，待专业室主任 / 专总审核通过后放出', imaSynced, flower });
});

// 删除权限：
//   系统管理员(admin/leader) / 院长 / 专总 → 可删除任意宣贯（含自己与他人、任何状态）。
//   其余角色（室主任 / 设计师等）→ 不能删他人；也不能删自己「已发布(active)」的宣贯；
//   仅可撤回自己尚未发布(pending / rejected)的宣贯。
// 删除为「软删」：置 status='deleted'（不进质量库、不进首页），保留记录便于审计追溯；IMA 旧副本不自动清理。
router.delete('/:id', (req, res) => {
  const u = me(req);
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  const privileged = rbac.isSuper(u) || rbac.canPublishAll(u) || rbac.isSuperAdmin(u); // admin / leader / dean / chief / 超级管理员
  if (!privileged) {
    const isOwner = r.publisher_id === u.id;
    if (!isOwner) return res.status(403).json({ error: '无权限删除他人内容' });
    if (r.status === 'active') return res.status(403).json({ error: '已发布的内容不可删除' });
  }
  db.prepare("UPDATE quality_dissem SET status='deleted' WHERE id=?").run(req.params.id);
  // 删除=未真正发布，回撤该宣贯曾发放的小红花（删除条目须减去对应数量，避免测试条目虚增花数）
  removeFlowers('dissem', req.params.id);
  audit({ actor: u.real_name, actorRole: u.role, action: 'dissem_delete', targetType: 'quality_dissem', targetId: r.id, detail: `${u.real_name} 软删宣贯#${r.id}「${r.title}」（原状态 ${r.status}）` });
  res.json({ message: '已删除（软删，不进入质量库）' });
});

// 审核通过并放出（管理者）
router.post('/:id/approve', async (req, res) => {
  const u = me(req);
  if (!rbac.canManage(u)) return res.status(403).json({ error: '权限不足' });
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  // 与待审列表一致的审核范围：专业室主任仅可审核本科室/全员宣贯，不可跨科室直调接口审核
  if (!canReviewDissem(u, r)) return res.status(403).json({ error: '无权审核该专业室宣贯' });
  if (r.status === 'active') return res.json({ message: '已是放出状态' });
  // reviewed_at = 「审核通过」这一批准时刻（2026-09-23）：质量库按"最后一环批准时间"排序/展示时，
  //   设计师发布的宣贯取本列；专总/室主任/院长直发的宣贯本列为 NULL，兜底取 created_at。
  //   与 created_at / audit_log.created_at 同为 UTC（CURRENT_TIMESTAMP），口径一致可直接比对。
  db.prepare("UPDATE quality_dissem SET status='active', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(me(req).real_name, r.id);
  // 审批时附带的批注（非专总/室主任发布的宣贯均可）：随审批一并保存，展示在宣贯条下、全员可见
  const note = (req.body.note || '').toString().trim();
  if (note) db.prepare('UPDATE quality_dissem SET manager_note=?, manager_note_by=?, manager_note_at=CURRENT_TIMESTAMP WHERE id=?').run(note, me(req).real_name, r.id);
  let imaUrl = r.ima_url || '', imaMedia = '';
  try {
    const divs = safeJson(r.divisions), regs = safeJson(r.regions);
    const rr = await ima.pushQualityDissem({
      id: r.id, title: r.title, content: r.content, category: r.category,
      divisions: divs, regions: regs, subDivisions: safeJson(r.sub_divisions), publisher: r.publisher, publishDate: r.publish_date, expiryDate: r.expiry_date,
      attachments: safeJson(r.attachments),
      existingFolderId: r.ima_folder_id,
    });
    imaUrl = rr.url || '';
    imaMedia = rr.media_id || '';
    if (imaMedia) {
      db.prepare('UPDATE quality_dissem SET ima_media_id=?, ima_url=? WHERE id=?').run(imaMedia, imaUrl, r.id);
      if (rr.folderId) db.prepare('UPDATE quality_dissem SET ima_folder_id=? WHERE id=?').run(rr.folderId, r.id);
    }
  } catch (e) { console.error('[质量宣贯] IMA 推送失败：', e.message); }
  // 闭环激励：审核通过发布 → 发布人得花（室主任/兼室主任 1 朵，其余 3 朵）
  let flower = 0;
  const dissemAmt = dissemFlowerAmount(r.publisher_id);
  if (awardFlower({ kind: 'dissem', refId: r.id, userName: r.publisher, userId: r.publisher_id, title: r.title, awardedBy: me(req).real_name, amount: dissemAmt })) flower = dissemAmt;
  const imaSynced = !!imaMedia;
  audit({ actor: me(req).real_name, actorRole: me(req).role, action: 'dissem_approve', targetType: 'quality_dissem', targetId: r.id, detail: `${me(req).real_name} 审核通过并放出宣贯#${r.id}「${r.title}」` });
  res.json({ message: '已审核通过并放出', imaUrl, flower, imaSynced });
});

// 驳回（管理者；提交人可见"未通过"）
router.post('/:id/reject', (req, res) => {
  const u = me(req);
  if (!rbac.canManage(u)) return res.status(403).json({ error: '权限不足' });
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  if (!canReviewDissem(u, r)) return res.status(403).json({ error: '无权审核该专业室宣贯' });
  db.prepare("UPDATE quality_dissem SET status='rejected', reviewed_by=? WHERE id=?").run(me(req).real_name, r.id);
  audit({ actor: me(req).real_name, actorRole: me(req).role, action: 'dissem_reject', targetType: 'quality_dissem', targetId: r.id, detail: `${me(req).real_name} 驳回宣贯#${r.id}「${r.title}」` });
  res.json({ message: '已驳回' });
});

// 管理者备注（室主任/专总/院长/超管 对宣贯帖加审批批注）
//   2026-09-17：与审批流对齐 —— 凡「非专总/室主任发布」的宣贯均可加/改批注；
//   专总/室主任自己发布的宣贯无需他人批注（返回 403）。原实现仅放行 designer 发布，范围偏窄。
router.put('/:id/note', (req, res) => {
  if (!rbac.canManage(req.user)) return res.status(403).json({ error: '权限不足' });
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  const pubRole = (r.publisher_role || '');
  if (pubRole === 'chief' || pubRole === 'section_leader') return res.status(403).json({ error: '专总/室主任发布的宣贯无需他人批注' });
  const note = (req.body.note || '').toString().trim();
  db.prepare('UPDATE quality_dissem SET manager_note=?, manager_note_by=?, manager_note_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(note, me(req).real_name, r.id);
  const nr = db.prepare('SELECT manager_note, manager_note_by, manager_note_at FROM quality_dissem WHERE id=?').get(r.id);
  res.json({ message: note ? '已保存管理者备注' : '已清空备注', ...nr });
});

// 单条详情（质量库详情弹窗用，含完整内容）
// 可见性过滤（与列表 GET / 一致，修复 A1 越权直读）：
//   待审核(pending) / 未通过(rejected) 仅发布者本人或具审核权者(canReviewDissem)可见，
//   防止任意登录用户凭 ID 枚举未审核 / 跨室宣贯全文（active / archived 已发布内容对全员可见，与列表、质量库一致）。
router.get('/:id', (req, res) => {
  const u = me(req);
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  if (r.status === 'deleted') return res.status(404).json({ error: '该宣贯已被删除' });
  if (r.status === 'pending' || r.status === 'rejected') {
    const isOwner = r.publisher_id === u.id;
    if (!isOwner && !canReviewDissem(u, r)) return res.status(404).json({ error: '该宣贯不可见' });
  }
  res.json({ ...r, divisions: safeJson(r.divisions), regions: safeJson(r.regions), subDivisions: safeJson(r.sub_divisions), attachments: safeJson(r.attachments), photos: safeJson(r.photos), canEdit: rbac.canEditContent(u, r) });
});

// 编辑（已发布内容修订：修正错别字、调整分类/专业室/地区等）
// 权限：canEditContent —— 院长改全部；专总/室主任改自己+设计师发的；设计师不能改已发布。
// 注意：编辑「公示期」只改 expiry_date，不动 status（pending 仍需正式审核才放出；见 2026-07-29 需求调整）。
// 小红花发放仅发生在直接发布 / 审核通过两种正式放出动作（见上方创建/审核分支）。
// 注意：本地修订生效，IMA「01千里行质量宣贯」中的旧副本不会自动同步（IMA 无更新接口，重推会重复）。
router.put('/:id', (req, res) => {
  const u = me(req);
  const r = db.prepare('SELECT * FROM quality_dissem WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '不存在' });
  if (!rbac.canEditContent(u, r)) return res.status(403).json({ error: '无权限修改该宣贯' });
  const { title, content, category, divisions, regions, subDivisions, attachments, photos, durationDays, expiry_date } = req.body || {};
  const set = [];
  const vals = [];
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ error: '标题不能为空' });
    set.push('title=?'); vals.push(String(title).trim());
  }
  if (content !== undefined) {
    if (!String(content).trim()) return res.status(400).json({ error: '内容不能为空' });
    set.push('content=?'); vals.push(String(content).trim());
  }
  if (category !== undefined) { set.push('category=?'); vals.push(String(category).trim()); }
  if (Array.isArray(divisions)) { set.push('divisions=?'); vals.push(JSON.stringify(sanitizeStrArray(divisions))); }
  if (Array.isArray(regions)) { set.push('regions=?'); vals.push(JSON.stringify(sanitizeStrArray(regions))); }
  if (Array.isArray(subDivisions)) { set.push('sub_divisions=?'); vals.push(JSON.stringify(sanitizeStrArray(subDivisions))); }
  if (Array.isArray(attachments)) {
    const atts = attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }));
    set.push('attachments=?'); vals.push(JSON.stringify(atts));
  }
  if (Array.isArray(photos)) {
    const phs = photos.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' }));
    set.push('photos=?'); vals.push(JSON.stringify(phs));
  }
  // 允许修改公示期：自定义日期优先；否则按天数（1周/1月/2月/3月），不再支持「长久（永久）」。
  // 注意：编辑公示期【不动 status】——pending 仍为 pending，须走正式审核（/review）才放出；
  // active 过期归档由列表加载时的定时清理处理。故编辑路径不再发花（发放只挂在直接发布 / 审核通过）。
  if (durationDays !== undefined || expiry_date !== undefined) {
    const pub = (r.publish_date || r.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const exp = computeExpiry(pub, durationDays, expiry_date);
    set.push('expiry_date=?'); vals.push(exp);
  }
  if (!set.length) return res.status(400).json({ error: '没有可修改的字段' });
  vals.push(r.id);
  db.prepare(`UPDATE quality_dissem SET ${set.join(', ')} WHERE id=?`).run(...vals);
  res.json({ message: '已保存修改' });
});

module.exports = router;
