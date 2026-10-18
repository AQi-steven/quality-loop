/**
 * PDCA 质量改进闭环路由
 *
 * 三栏：发现问题 / 解决问题 / 回顾问题
 *   POST   /pdca/problems           发现问题（个人 or 部门推送）
 *   GET    /pdca/problems          列表（status / mine / scope=dept）
 *   GET    /pdca/problems/:id      详情（照片+方案+专家多轮+复盘）
 *   POST   /pdca/problems/:id/solution   拟设解决方案 + 请教专家
 *   POST   /pdca/problems/:id/consult    多轮追问（提问）
 *   POST   /pdca/problems/:id/answer     多轮追问（专家作答）
 *   POST   /pdca/problems/:id/resolve     标记已解决 → 进入回顾
 *   POST   /pdca/problems/:id/review      复盘 + 发起提醒
 *   PUT    /pdca/problems/:id/close       管理者关闭（部门问题仅管理者可关）
 *   POST   /pdca/problems/:id/renrenjiang  人人讲标记开关（设计师回顾/管理人回答均可设）
 *   GET    /pdca/experts           被请教专家候选库（role='expert' + 资深总工；2026-07-27m 起专家已与室主任/专总/院长解耦）
 *   GET    /pdca/expert-tasks      专家「被请教提醒」面板数据（本人被请教且未闭环的问题 + 是否已答复）
 *   POST   /pdca/problems/:id/participants  追问阶段移除未答复的参与者（共议/专家，专家至少留 1）
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const manageMiddleware = require('../middleware/manage');
const rbac = require('../rbac');
const { pushRenrenjiang } = require('../ima');
const { awardFlower, removeFlowers } = require('../flowers');
const { audit } = require('../audit');
const { HIDDEN_DIVISIONS, splitSubKey } = require('../divisions');
const push = require('../wechat/push');

function safeJsonArr(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string' && x) { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  return [];
}

// 规整多专业数组：优先用前端传的 divisions/subDivisions 数组，旧单值 division/subDivision 兜底；
// 同时推导单值首位 div/subDiv 供遗留查询兼容。
function normDivisions(body) {
  const divisions = Array.isArray(body.divisions) ? body.divisions.map(s => String(s).trim()).filter(Boolean) : [];
  const subDivisions = Array.isArray(body.subDivisions) ? body.subDivisions.map(s => String(s).trim()).filter(Boolean) : [];
  if (!divisions.length && (body.division || '').trim()) divisions.push((body.division || '').trim());
  if (!subDivisions.length && (body.subDivision || '').trim()) subDivisions.push((body.subDivision || '').trim());
  const div = divisions[0] || (subDivisions[0] ? splitSubKey(subDivisions[0]).major : '');
  const subDiv = subDivisions[0] || '';
  return { divisions, subDivisions, div, subDiv };
}

// 问题是否归属某科室：单一 division 字段 或 divisions(JSON 数组) 任一命中
function problemInDivision(rec, myDiv) {
  if (!myDiv) return false;
  if ((rec.division || '') === myDiv) return true;
  try {
    const arr = JSON.parse(rec.divisions || '[]');
    if (Array.isArray(arr) && arr.includes(myDiv)) return true;
  } catch (e) {}
  return false;
}

// 室主任（单一科室的管理者）按本科室范围查看/清理；院领导(hasAllDivisions)/超管(isSuper)看全部
function isDivisionScopedManager(u) {
  if (!rbac.canManage(u)) return false;
  if (rbac.hasAllDivisions(u) || rbac.isSuper(u)) return false; // 院领导/超管不受限
  return rbac.rolesOf(u).includes('section_leader');
}

// 修订 #2：上报人匹配优先按 reporter_user_id（稳定），id 缺失时回退 real_name（过渡期兼容旧数据）
function reporterMatches(p, u) {
  if (!u) return false;
  if (p.reporter_user_id != null) return p.reporter_user_id === u.id;
  return p.reporter === u.realName;
}

// ── 共议设计师关联表维护（#223 正规化）──
// 把问题的最终共议设计师名单同步进 pdca_consultants（一行一设计师），
// 与 pdca_problems.consult_designers JSON 列保持一致，供 related=1「与我相关」精确 JOIN。
function setConsultants(problemId, designers) {
  const arr = Array.isArray(designers) ? designers.map(String).filter(Boolean) : [];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM pdca_consultants WHERE problem_id=?').run(problemId);
    const ins = db.prepare('INSERT OR IGNORE INTO pdca_consultants (problem_id, designer) VALUES (?, ?)');
    for (const d of arr) ins.run(problemId, d);
  });
  tx();
}

const router = express.Router();
router.use(authMiddleware);

function canManage(u) { return rbac.canManage(u); }

// 组装完整问题对象（含照片 / 方案 / 问答 / 复盘 / 附件），供 IMA 推送复用
function assembleFullProblem(p) {
  const full = { ...p };
  full.photos = db.prepare('SELECT id, photo_url FROM pdca_photos WHERE problem_id=?').all(p.id);
  full.solutions = db.prepare('SELECT * FROM pdca_solutions WHERE problem_id=? ORDER BY id').all(p.id);
  full.consults = db.prepare('SELECT * FROM pdca_consults WHERE problem_id=? ORDER BY round, id').all(p.id);
  // 关键：把每条追问的多条答复（专家 / 共议设计师）挂到对应 consult 上，
  // 否则 IMA 推送的「专家问答」章节会因缺少 answers 而空白（前端详情接口有此 JOIN，推送用的本函数先前漏了）。
  const answers = db.prepare('SELECT * FROM pdca_answers WHERE problem_id=? ORDER BY consult_id, id').all(p.id);
  for (const c of full.consults) c.answers = answers.filter(a => a.consult_id === c.id);
  full.review = db.prepare('SELECT * FROM pdca_reviews WHERE problem_id=?').get(p.id) || null;
  let atts = [];
  try { atts = JSON.parse(p.attachments || '[]'); } catch (e) {}
  if (!Array.isArray(atts)) atts = [];
  full.attachments = atts;
  return full;
}

// 向某用户（按姓名）发一条提醒（用于请教专家 / 专家答复 / 部门人人讲通知），失败静默
function notifyExpert(senderName, recipientName, type, title, content, problemId) {
  // 护栏：自己不给自己发提醒（避免自问自答时给自己产生一条 PDCA 待办）
  if (recipientName && recipientName === senderName) return;
  try {
    const u = db.prepare('SELECT id, real_name, serverchan_key FROM users WHERE real_name=? AND is_active=1').get(recipientName);
    if (!u) return;
    const sender = db.prepare('SELECT id, real_name FROM users WHERE real_name=?').get(senderName) || { id: 0, real_name: senderName };
    db.prepare(`INSERT INTO reminders (sender_id, sender_name, recipient_id, recipient_name, type, title, content, state, related_problem_id)
      VALUES (?,?,?,?,?,?,?,'pending',?)`)
      .run(sender.id, sender.real_name, u.id, u.real_name, type, title, content, problemId || null);
    // 微信提醒（员工已绑定 Server酱 才推，失败静默）
    if (u.serverchan_key) {
      push.pushToUser(u, `质量千里行·${type}`, `【质量千里行·${type}】${title}\n${content}`).catch(() => {});
    }
  } catch (e) { /* 通知失败不影响主流程 */ }
}

function genCode() {
  const now = new Date();
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const cnt = db.prepare('SELECT COUNT(*) c FROM pdca_problems WHERE code LIKE ?').get(`PDCA${d}%`).c;
  return `PDCA${d}${String(cnt + 1).padStart(3, '0')}`;
}

// 列表字段精简 + 计数/标志（单条，供个别场景兜底）
function enrich(p) {
  p.photoCount = db.prepare('SELECT COUNT(*) c FROM pdca_photos WHERE problem_id=?').get(p.id).c;
  p.solutionCount = db.prepare('SELECT COUNT(*) c FROM pdca_solutions WHERE problem_id=?').get(p.id).c;
  p.consultCount = db.prepare('SELECT COUNT(*) c FROM pdca_consults WHERE problem_id=?').get(p.id).c;
  const rev = db.prepare('SELECT * FROM pdca_reviews WHERE problem_id=?').get(p.id);
  p.hasReview = !!rev;
  p.is_reminder = rev ? rev.is_reminder : 0;
  p.is_renrenjiang = rev ? rev.is_renrenjiang : 0;
  const ru = db.prepare('SELECT role FROM users WHERE real_name=?').get(p.reporter);
  p.reporterRole = ru ? ru.role : '';
  return p;
}

// ── N+1 优化（#224）：把「每问题多次 SELECT 计数」改为 1 条 GROUP BY 聚合 ──
// 一次拉取所有问题的 photo/solution/consult 计数、review 标志、reporter 角色映射，
// 再回填到内存对象，避免列表 N 行 → 5N 次查询。
function enrichList(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const cntMap = (tbl, col) => {
    const m = {};
    const rs = db.prepare(`SELECT ${col} AS k, COUNT(*) c FROM ${tbl} WHERE ${col} IN (${ph}) GROUP BY ${col}`).all(...ids);
    for (const x of rs) m[x.k] = x.c;
    return m;
  };
  const photoMap = cntMap('pdca_photos', 'problem_id');
  const solMap = cntMap('pdca_solutions', 'problem_id');
  const consultMap = cntMap('pdca_consults', 'problem_id');
  const reviews = db.prepare(`SELECT * FROM pdca_reviews WHERE problem_id IN (${ph})`).all(...ids);
  const revMap = {};
  for (const r of reviews) revMap[r.problem_id] = r;
  // reporter 角色：一次性取所有去重姓名
  const names = [...new Set(rows.map(r => r.reporter).filter(Boolean))];
  const roleMap = {};
  if (names.length) {
    const nrs = db.prepare(`SELECT real_name, role FROM users WHERE real_name IN (${names.map(() => '?').join(',')})`).all(...names);
    for (const u of nrs) roleMap[u.real_name] = u.role;
  }
  for (const p of rows) {
    p.photoCount = photoMap[p.id] || 0;
    p.solutionCount = solMap[p.id] || 0;
    p.consultCount = consultMap[p.id] || 0;
    const rev = revMap[p.id];
    p.hasReview = !!rev;
    p.is_reminder = rev ? rev.is_reminder : 0;
    p.is_renrenjiang = rev ? rev.is_renrenjiang : 0;
    p.reporterRole = roleMap[p.reporter] || '';
  }
  return rows;
}

// ── 草稿箱（发现问题「存档」暂存，仅本人可见）──
router.get('/drafts', (req, res) => {
  // 超级管理员（超级用户）可见全部草稿并可删任意；其余人仅见本人草稿
  const list = rbac.isSuperAdmin(req.user)
    ? db.prepare('SELECT * FROM pdca_drafts ORDER BY saved_at DESC').all()
    : db.prepare('SELECT * FROM pdca_drafts WHERE (user_id=? OR (user_id IS NULL AND user_name=?)) ORDER BY saved_at DESC').all(req.user.id, req.user.realName);
  res.json(list.map(d => ({ ...d, photos: JSON.parse(d.photos || '[]'), attachments: safeJsonArr(d.attachments), experts: safeJsonArr(d.experts), designers: safeJsonArr(d.designers) })));
});

router.post('/drafts', (req, res) => {
  const { title = '', description = '', urgency = 'normal', photos = [], category = '标准规范', region = '', attachments = [], experts = [], designers = [] } = req.body;
  const { divisions, subDivisions, div, subDiv } = normDivisions(req.body);
  const info = db.prepare(
    'INSERT INTO pdca_drafts (user_id, user_name, title, description, urgency, photos, category, division, region, sub_division, divisions, sub_divisions, attachments, experts, designers, saved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)'
  ).run(req.user.id, req.user.realName, (title || '').trim(), (description || '').trim(), urgency === 'urgent' ? 'urgent' : 'normal', JSON.stringify(photos || []), category, div, (region || '').trim(), subDiv, JSON.stringify(divisions), JSON.stringify(subDivisions), JSON.stringify(attachments || []), JSON.stringify(experts || []), JSON.stringify(designers || []));
  res.json({ id: info.lastInsertRowid, message: '已存入草稿箱' });
});

router.get('/drafts/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM pdca_drafts WHERE id=? AND (user_id=? OR (user_id IS NULL AND user_name=?))').get(req.params.id, req.user.id, req.user.realName);
  if (!d) return res.status(404).json({ error: '草稿不存在' });
  d.photos = JSON.parse(d.photos || '[]');
  d.attachments = safeJsonArr(d.attachments);
  d.experts = safeJsonArr(d.experts);
  d.designers = safeJsonArr(d.designers);
  res.json(d);
});

router.put('/drafts/:id', (req, res) => {
  const { title, description, urgency, photos, category, region, attachments, experts, designers } = req.body;
  const d = db.prepare('SELECT * FROM pdca_drafts WHERE id=? AND (user_id=? OR (user_id IS NULL AND user_name=?))').get(req.params.id, req.user.id, req.user.realName);
  if (!d) return res.status(404).json({ error: '草稿不存在' });
  const newPhotos = photos !== undefined ? JSON.stringify(photos) : d.photos;
  const newAtts = attachments !== undefined ? JSON.stringify(attachments) : d.attachments;
  const newExperts = experts !== undefined ? JSON.stringify(experts) : d.experts;
  const newDesigners = designers !== undefined ? JSON.stringify(designers) : d.designers;
  const nd = normDivisions(req.body);
  const effDiv = nd.div;
  const newSub = nd.subDiv;
  db.prepare('UPDATE pdca_drafts SET title=?, description=?, urgency=?, photos=?, category=?, division=?, region=?, sub_division=?, divisions=?, sub_divisions=?, attachments=?, experts=?, designers=?, saved_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(
      (title !== undefined ? title : d.title).trim(),
      (description !== undefined ? description : d.description).trim(),
      (urgency !== undefined ? urgency : d.urgency) === 'urgent' ? 'urgent' : 'normal',
      newPhotos,
      category !== undefined ? category : (d.category || '标准规范'),
      effDiv,
      region !== undefined ? region : (d.region || ''),
      newSub,
      JSON.stringify(nd.divisions),
      JSON.stringify(nd.subDivisions),
      newAtts,
      newExperts,
      newDesigners,
      req.params.id
    );
  res.json({ message: '草稿已更新' });
});

router.delete('/drafts/:id', (req, res) => {
  if (rbac.isSuperAdmin(req.user)) {
    db.prepare('DELETE FROM pdca_drafts WHERE id=?').run(req.params.id);
    return res.json({ message: '草稿已删除' });
  }
  const d = db.prepare('SELECT * FROM pdca_drafts WHERE id=? AND (user_id=? OR (user_id IS NULL AND user_name=?))').get(req.params.id, req.user.id, req.user.realName);
  if (!d) return res.status(404).json({ error: '草稿不存在' });
  db.prepare('DELETE FROM pdca_drafts WHERE id=?').run(req.params.id);
  res.json({ message: '草稿已删除' });
});

// 删除已入库问题（质量库/人人讲）：admin/院长/专总/室主任(本科室) 可删任意；室主任可清理本科室他人误报；其余仅可删自己未闭环的问题
router.delete('/problems/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  const privileged = rbac.isSuperAdmin(req.user) || rbac.isSuper(req.user) || (canManage(req.user) && ['admin', 'leader', 'dean', 'chief'].includes(req.user.role));
  if (!privileged) {
    // 室主任（单一科室管理者）：可清理本科室他人误报的未闭环问题；其余人仅可删自己未闭环的问题
    const myDiv = (req.user.division || '').trim();
    const canDeleteOther = rbac.rolesOf(req.user).includes('section_leader') && myDiv && problemInDivision(p, myDiv);
    if (!reporterMatches(p, req.user) && !canDeleteOther) {
      return res.status(403).json({ error: '无权限删除他人内容' });
    }
    if (p.status === 'closed' || p.status === 'solved') {
      return res.status(403).json({ error: '已闭环/已解决的问题不可删除' });
    }
  }
  const delProblem = db.transaction(() => {
    db.prepare('DELETE FROM pdca_answers WHERE problem_id=?').run(p.id);
    db.prepare('DELETE FROM pdca_consults WHERE problem_id=?').run(p.id);
    db.prepare('DELETE FROM pdca_problems WHERE id=?').run(p.id);
    // 级联删除：该问题对全部相关人（被请教专家/被邀设计师/院选确认人/上报人）的站内提醒，避免孤儿提醒
    db.prepare('DELETE FROM reminders WHERE related_problem_id=?').run(p.id);
    // 级联回收：删除问题须同步回撤其闭环/院选小红花，避免「已删问题仍计花」造成虚增（与质量宣贯删除一致）
    // removeFlowers 按 (kind,ref_id) 删除，无对应花时为安全空操作
    removeFlowers('pdca', p.id);
    removeFlowers('rrj', p.id);
  });
  delProblem();
  res.json({ message: '已删除', ima_media_id: p.ima_media_id || null });
});


// ── 专家库（被请教专家候选）──
// 直接读 users 表，保证与真实账号一致；字段对齐前端 {name,title,role,level}
// 候选 = 显式专家（role='expert' 或 extra_roles 含 expert）+ 室主任（section_leader）+ 专总（chief）
//   （2026-07-29 晚修正：此前 2026-07-27m「解耦」把专家收窄为独立角色，室主任/专总从候选池消失，仅剩 3 名显式专家；
//   现按用户口径恢复 室主任/专总 为可被请教的专家，除暂不参与程序的综管/综能/节能三室）。
// 资深专家（总工 chief_engineer）更高一级，仅当当前用户是 专总/院长/超管 时才出现在候选中
//   （设计师/室主任看不见、也不能邀请）。
// 排除暂不参与程序的科室（综管室 / 综能室 / 节能室，见 HIDDEN_DIVISIONS）。
router.get('/experts', (req, res) => {
  const mayInviteSenior = rbac.canInviteChiefEngineer(req.user);
  const roles = mayInviteSenior
    ? ['expert', 'section_leader', 'chief', 'chief_engineer']
    : ['expert', 'section_leader', 'chief'];
  // 专家候选 = 主 role 含于 roles（含 expert / section_leader / chief / chief_engineer），
  //   或 extra_roles 附加含 expert/chief_engineer（设计师/室主任等本职岗位叠加专家职能，保留本职身份与能力）。
  // 2026-07-29 修复：此前只认主 role='expert'，导致设计师+专家被漏选；2026-07-29 晚修正：补回室主任/专总。
  // 注意：roles 用字面值拼入 SQL（不用 ? 参数绑定），因 node:sqlite 对中文参数匹配有异常（实测参数化
  //   导致 role IN (?,?,?) 大量漏行）；roles 均为代码常量，无注入风险。
  const roleLiterals = roles.map(r => `'${r.replace(/'/g, "''")}'`).join(',');
  const extraLike = roles.map(r => `extra_roles LIKE '%"${r}"%'`).join(' OR ');
  // 2026-08-31：新增王苏北为专家候选，并把王苏北/×××/×××/×××/×××固定排在最前。
  const pinnedExperts = ['王苏北', '×××', '×××', '×××', '×××'];
  const pinnedLiterals = pinnedExperts.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
  const list = db.prepare(
    `SELECT id, real_name AS name, title_tag AS title, department, role
     FROM users WHERE is_active=1
     AND COALESCE(is_guest,0)=0
     AND COALESCE(title_tag,'') <> '体验账号'   -- 2026-10-10 内部体验账号不进专家候选
     AND COALESCE(division,'') NOT IN (${HIDDEN_DIVISIONS.map(() => '?').join(',')})
     AND (role IN (${roleLiterals}) OR ${extraLike} OR real_name IN (${pinnedLiterals}))
     ORDER BY id`
  ).all(...HIDDEN_DIVISIONS);
  // 资深专家（总工）仅在 canInviteChiefEngineer 用户（专总/院长）候选中可见；
  // 设计师/室主任即便某总工以 extra_roles 叠加了专家职能，也不得在「邀请专家」候选中出现（选项里看不到）。
  let visible = mayInviteSenior ? list : list.filter(e => e.role !== 'chief_engineer');
  // 固定排序：指定专家按 pinnedExperts 顺序排在最前，其余保持 id 顺序。
  const rank = name => {
    const idx = pinnedExperts.indexOf(name);
    return idx === -1 ? pinnedExperts.length + 1000000 : idx;
  };
  visible.sort((a, b) => rank(a.name) - rank(b.name) || a.id - b.id);
  res.json(visible.map(e => ({ name: e.name, title: e.title, department: e.department, role: e.role, level: e.role === 'chief_engineer' ? 'senior' : 'normal' })));
});


// 校验 experts 名单中是否含「总工」：
//   - 当前用户可邀请总工（专总/院长/超管）→ 全部放行
//   - 否则 → 剔除总工并返回被剔除名单（调用方据此拒绝）
function splitSeniorExperts(experts, u) {
  if (!Array.isArray(experts) || !experts.length) return { allowed: [], rejected: [] };
  if (rbac.canInviteChiefEngineer(u)) return { allowed: experts, rejected: [] };
  const seniorNames = db.prepare('SELECT real_name FROM users WHERE role=? AND is_active=1').all('chief_engineer').map(r => r.real_name);
  const allowed = experts.filter(n => !seniorNames.includes(n));
  const rejected = experts.filter(n => seniorNames.includes(n));
  return { allowed, rejected };
}

// 剔除名单中的「游客」账户：游客仅只读，既不应出现在「邀请专家/共议」候选，也不得在直调 API 时写进共议/专家名单。
function stripGuestNames(names) {
  if (!Array.isArray(names) || !names.length) return [];
  const guestNames = new Set(
    db.prepare("SELECT real_name FROM users WHERE is_active=1 AND COALESCE(is_guest,0)=1").all().map(r => r.real_name)
  );
  return names.filter(n => !guestNames.has(n));
}

// ── 设计师库（共议候选：所有在职设计师 + 室主任，供下拉多选）──
// 2026-07-27m 起：共议人员包含室主任（section_leader），与专家候选解耦。
// 排除暂不参与程序的科室（综管室 / 综能室 / 节能室）。
// 2026-07-30 修正：室主任身份可能以 extra_roles=['section_leader'] 附加（如×××=专总+室主任），
//   与 /experts 一致，主角色 OR extra_roles 任一命中 designer/section_leader 即纳入候选池。
router.get('/designers', (req, res) => {
  const list = db.prepare(
    `SELECT real_name AS name, title_tag AS title, department
     FROM users WHERE is_active=1
     AND COALESCE(is_guest,0)=0
     AND COALESCE(title_tag,'') <> '体验账号'   -- 2026-10-10 内部体验账号不进共议设计师候选
     AND COALESCE(division,'') NOT IN (${HIDDEN_DIVISIONS.map(() => '?').join(',')})
     AND (role IN ('designer','section_leader')
          OR extra_roles LIKE '%"designer"%'
          OR extra_roles LIKE '%"section_leader"%')
     ORDER BY id`
  ).all(...HIDDEN_DIVISIONS);
  res.json(list);
});

// ── 专家的「被请教提醒」面板数据 ──
// 仅专家本人（含资深总工）可见：返回「曾被请教（consult_experts 含本人）且尚未闭环」的问题，
// 标注本人是否已作答（answered），便于专家在管理界面集中处理未答的请教。
// 用 LIKE 粗筛后再按 JSON 精确校验，避免同名串扰。
router.get('/expert-tasks', (req, res) => {
  // 认「主 role 或 extra_roles」含 expert/chief_engineer 的用户（设计师叠加专家职能时也应看到被请教提醒）
  if (!rbac.rolesOf(req.user).some(r => rbac.EXPERT.includes(r))) return res.json([]);
  const rows = db.prepare(
    `SELECT id, code, title, status, urgency, reporter, created_at, updated_at, consult_experts
     FROM pdca_problems WHERE consult_experts LIKE ? AND status NOT IN ('closed')
     ORDER BY updated_at DESC`
  ).all('%' + req.user.realName + '%');
  const result = [];
  for (const p of rows) {
    let es = [];
    try { es = JSON.parse(p.consult_experts || '[]'); } catch (e) { es = []; }
    if (!es.includes(req.user.realName)) continue; // LIKE 命中但 JSON 中不含本人（同名串扰防护）
    const answered = db.prepare("SELECT COUNT(*) c FROM pdca_answers WHERE problem_id=? AND expert_name=?").get(p.id, req.user.realName).c > 0;
    result.push({
      id: p.id, code: p.code, title: p.title, status: p.status, urgency: p.urgency,
      reporter: p.reporter, created_at: p.created_at, updated_at: p.updated_at, answered,
    });
  }
  res.json(result);
});

// ── 追问阶段移除未答复的参与者（共议设计师 / 被请教专家）──
// 仅「提问者」（问题上报人或管理者，与追问 /ask 同权限）可操作。
// 规则：仅可移除「尚未答复」的参与者（按 expert_name 判定，无论其作答 role）；
//   移除专家后至少须保留 1 位专家；移除后同步 pdca_consultants 并清理该参与者在本问题的待办提醒。
router.post('/problems/:id/participants', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  if (!reporterMatches(p, req.user) && !canManage(req.user)) {
    return res.status(403).json({ error: '仅问题上报人或管理者可移除参与者' });
  }
  const { type, name } = req.body;
  if (!name) return res.status(400).json({ error: '请指定要移除的参与者' });
  if (type !== 'expert' && type !== 'designer') {
    return res.status(400).json({ error: 'type 须为 expert 或 designer' });
  }
  const roleCol = type === 'expert' ? 'consult_experts' : 'consult_designers';
  const arr = (() => { try { return p[roleCol] ? JSON.parse(p[roleCol]) : []; } catch (e) { return []; } })();
  if (!arr.includes(name)) {
    return res.status(400).json({ error: '该参与者不在当前名单中' });
  }
  // 是否已答复：按 expert_name 判定（一个人无论以何种 role 作答都算已答复）
  const ansCount = db.prepare('SELECT COUNT(*) c FROM pdca_answers WHERE problem_id=? AND expert_name=?').get(p.id, name).c;
  if (ansCount > 0) {
    return res.status(403).json({ error: '该参与者已答复，不可移除' });
  }
  // 专家至少保留 1 位
  if (type === 'expert' && arr.length <= 1) {
    return res.status(403).json({ error: '至少须保留 1 位专家' });
  }
  const newArr = arr.filter(n => n !== name);
  // 注意：不可在外层再包 db.transaction —— setConsultants 内部已自带事务，
  // node:sqlite 不支持嵌套事务（会报 "cannot start a transaction within a transaction"）。
  // 故此处直接顺序执行三条简单语句（非事务包裹），setConsultants 各自独立提交。
  db.prepare(`UPDATE pdca_problems SET ${roleCol}=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(JSON.stringify(newArr), p.id);
  if (type === 'designer') setConsultants(p.id, newArr);
  // 清理该参与者在本问题的待办提醒（请教/追问/邀请共议类），避免其仍看到已不属于自己的待办
  db.prepare("UPDATE reminders SET state='done', done_at=CURRENT_TIMESTAMP WHERE recipient_name=? AND related_problem_id=? AND state<>'done'")
    .run(name, p.id);
  res.json({ message: '已移除参与者：' + name, [type === 'expert' ? 'experts' : 'designers']: newArr });
});

// ── 发现问题（B 请教专家：带 experts → 标记「已请教」并通知专家；designers 为共议设计师）──
router.post('/problems', (req, res) => {
  let { title, description, urgency = 'normal', is_pending = 1, photos = [], experts = [], designers = [], category = '标准规范', region = '', attachments = [] } = req.body;
  designers = stripGuestNames(designers);
  if (!title || !description) return res.status(400).json({ error: '问题名称和描述为必填' });

  // 部门问题仅管理者可推送
  let source = 'personal';
  if (req.body.source === 'dept') {
    if (!canManage(req.user)) return res.status(403).json({ error: '仅管理者可推送部门问题' });
    source = 'dept';
  }
  // 多专业：divisions/subDivisions 数组（优先），旧单值兜底；div/subDiv 取首位供遗留兼容
  const { divisions, subDivisions, div, subDiv } = normDivisions(req.body);
  const reporter = req.user.realName;
  // 设计师不得直接请教总工：仅专总/院长/超管可邀请；含总工则拒绝
  const { allowed: allowedExperts, rejected: rejectedExperts } = splitSeniorExperts(experts, req.user);
  if (rejectedExperts.length) {
    return res.status(403).json({ error: '总工为资深专家，仅可由专总或院长邀请；请先请教专总 / 院长，由其邀请总工参加。' });
  }
  const safeExperts = stripGuestNames(allowedExperts);
  const askExperts = Array.isArray(safeExperts) && safeExperts.length > 0;
  const askDesigners = Array.isArray(designers) && designers.length > 0;
  const status = askExperts ? 'consulted' : 'recorded';
  const atts = Array.isArray(attachments) ? attachments.filter((a) => a && a.url).map((a) => ({ url: a.url, name: a.name || '' })) : [];

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO pdca_problems (code, title, description, urgency, source, reporter, reporter_user_id, owner, status, is_pending, consult_experts, consult_designers, category, division, region, sub_division, divisions, sub_divisions, attachments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genCode(), title.trim(), description.trim(), urgency === 'urgent' ? 'urgent' : 'normal', source, reporter, req.user.id, reporter, status, is_pending ? 1 : 0, askExperts ? JSON.stringify(allowedExperts) : null, askDesigners ? JSON.stringify(designers) : null, category, div, (region || '').trim(), subDiv, JSON.stringify(divisions), JSON.stringify(subDivisions), JSON.stringify(atts));

    if (Array.isArray(photos)) {
      const ins = db.prepare('INSERT INTO pdca_photos (problem_id, photo_url) VALUES (?, ?)');
      for (const url of photos) ins.run(info.lastInsertRowid, url);
    }
    if (askExperts) {
      db.prepare('INSERT INTO pdca_consults (problem_id, round, question, question_by) VALUES (?, 1, ?, ?)')
        .run(info.lastInsertRowid, description.trim(), reporter);
      for (const ex of safeExperts) {
        notifyExpert(reporter, ex, '通用', '请教：' + title.trim(), '就「' + title.trim() + '」向你请教，请打开 PDCA 问题库处理。', info.lastInsertRowid);
      }
    }
    if (askDesigners) {
      for (const d of designers) {
        notifyExpert(reporter, d, '通用', '邀请共议：' + title.trim(), '就「' + title.trim() + '」邀请你参与共议，请在 PDCA 问题库中回复你的见解。', info.lastInsertRowid);
      }
    }
    return info.lastInsertRowid;
  });
  const id = tx();
  if (Array.isArray(designers) && designers.length) setConsultants(id, designers);
  res.json({ id, message: askExperts ? '已请教专家' : (askDesigners ? '已记录并邀请共议' : '已记录'), status });
});

// ── 已记录 / 已请教 问题，向专家请教（首轮或追加轮）；可同时追加共议设计师 ──
router.post('/problems/:id/ask', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // 已到总工：无需再请教专家 / 邀请设计师共议
  { const _ce = (() => { try { return p.consult_experts ? JSON.parse(p.consult_experts) : []; } catch (e) { return []; } })();
    const _senior = db.prepare("SELECT real_name FROM users WHERE role='chief_engineer' AND is_active=1").all().map(r => r.real_name);
    if (_ce.some(n => _senior.includes(n))) return res.status(403).json({ error: '已到总工，无需再请教专家 / 邀请设计师共议' }); }
  // P3⑨ 角色门：请教专家仅上报人或管理者可发起（前端按钮已隐藏，此处兜底防直调；splitSeniorExperts 仍拦总工）
  if (!reporterMatches(p, req.user) && !canManage(req.user)) {
    return res.status(403).json({ error: '仅问题上报人或管理者可请教专家' });
  }
  let { experts = [], designers = [], question } = req.body;
  designers = stripGuestNames(designers);
  if (!Array.isArray(experts) || !experts.length) return res.status(400).json({ error: '请至少选择一位专家' });
  // 设计师不得直接邀请总工；含总工则拒绝（仅专总/院长/超管可）
  const { allowed: allowedExperts, rejected: rejectedExperts } = splitSeniorExperts(experts, req.user);
  if (rejectedExperts.length) {
    return res.status(403).json({ error: '总工为资深专家，仅可由专总或院长邀请；请由专总 / 院长邀请总工参加本话题。' });
  }
  const safeExperts = stripGuestNames(allowedExperts);
  const q = (question || p.description || '').trim();
  const last = db.prepare('SELECT MAX(round) r FROM pdca_consults WHERE problem_id=?').get(p.id).r || 0;
  // 合并共议设计师（已有 + 新邀请，去重）
  const existingDs = p.consult_designers ? JSON.parse(p.consult_designers) : [];
  const mergedDs = Array.from(new Set([...existingDs, ...(Array.isArray(designers) ? designers : [])]));
  // 2026-07-26 修复 P1④：合并请教专家（已有 + 本次，去重），防止覆盖式写清空历史专家列表
  const existingEs = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  const mergedEs = Array.from(new Set([...existingEs, ...safeExperts]));
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO pdca_consults (problem_id, round, question, question_by) VALUES (?, ?, ?, ?)')
      .run(p.id, last + 1, q, req.user.realName);
    db.prepare("UPDATE pdca_problems SET status='consulted', consult_experts=?, consult_designers=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(mergedEs), JSON.stringify(mergedDs), p.id);
    for (const ex of safeExperts) {
      if (!existingEs.includes(ex)) {  // 仅通知本次新追加的专家，避免重复打扰已在列专家
        notifyExpert(req.user.realName, ex, '通用', '请教：' + p.title, '就「' + p.title + '」向你请教，请打开 PDCA 问题库处理。', p.id);
      }
    }
    for (const d of mergedDs) {
      if (!existingDs.includes(d)) {
        notifyExpert(req.user.realName, d, '通用', '邀请共议：' + p.title, '就「' + p.title + '」邀请你参与共议，请在 PDCA 问题库中回复你的见解。', p.id);
      }
    }
  });
  tx();
  setConsultants(p.id, mergedDs);
  res.json({ message: '已请教专家', designers: mergedDs });
});

// ── 列表 ──────────────────────────────────────
// 可选分页响应：传 limit 时返回 {items,total,hasMore}（前台"加载更多"用）；不传则返回纯数组（历史兼容，前台零影响）
function sendList(req, res, list) {
  const { limit = '', offset = '' } = req.query;
  if (limit !== '' && Number(limit) > 0) {
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Number(limit);
    const paged = list.slice(off, off + lim);
    return res.json({ items: paged, total: list.length, hasMore: off + lim < list.length, limit: lim, offset: off });
  }
  return res.json(list);
}

router.get('/problems', (req, res) => {
  const { status, mine, scope, is_renrenjiang, phase, related, subDivision } = req.query;
  const u = req.user;

  // 人人讲筛选：全员可见（作为首页提醒/管理中枢的学习案例）。
  // 新规则：问题「闭环」即自动作为人人讲，故此处改为返回已闭环的问题（不再依赖 review.is_renrenjiang 勾选标记）
  if (is_renrenjiang === '1') {
    const ids = db.prepare("SELECT id FROM pdca_problems WHERE status='closed'").all().map(r => r.id);
    if (!ids.length) return res.json([]);
    let list = enrichList(db.prepare(`SELECT * FROM pdca_problems WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...ids));
    // 仅看"与我相关"（我发起 / 我被邀请共议）：管理者不受影响，仍看全部
    if (related === '1' && !canManage(u)) {
      const myConsultIds = new Set(db.prepare('SELECT problem_id FROM pdca_consultants WHERE designer=?').all(u.realName).map(r => r.problem_id));
      list = list.filter(p => reporterMatches(p, u) || myConsultIds.has(p.id));
    }
    // 室主任（单一科室管理者）按本科室范围查看人人讲，与宣贯 pending 范围一致；院领导/超管看全部
    if (isDivisionScopedManager(u)) {
      const myDiv = (u.division || '').trim();
      list = list.filter(p => problemInDivision(p, myDiv));
    }
    return sendList(req, res, list);
  }

  // 人人讲「院选」筛选：首页人人讲版块 = 已闭环 + 被专总/院长精选，全员可见
  if (req.query.rrj_selected === '1') {
    const list = enrichList(db.prepare("SELECT * FROM pdca_problems WHERE rrj_selected=1 AND status='closed' ORDER BY created_at DESC").all());
    return sendList(req, res, list);
  }

  let sql = 'SELECT * FROM pdca_problems WHERE 1=1';
  const p = [];
  if (status) { sql += ' AND status=?'; p.push(status); }
  else if (phase === 'open') { sql += " AND status IN ('found','solving','recorded','consulted')"; }
  else if (phase === 'review') { sql += " AND status IN ('solved','reviewed')"; }
  if (scope === 'dept') { sql += ' AND source=?'; p.push('dept'); }
  const selSubs = String(subDivision || '').split(',').map(s => s.trim()).filter(Boolean);
  if (selSubs.length) { sql += ` AND sub_division IN (${selSubs.map(() => '?').join(',')})`; p.push(...selSubs); }
  if (!canManage(u)) {
    if (phase === 'open' || phase === 'review') {
      // P1①：未闭环 / 已解决待复盘 全院公开可见（含游客只读），不放 reporter 隔离
    } else if (related === '1') {
      // 我发起 或 我被邀请共议：用 pdca_consultants 关联表精确 JOIN（取代 LIKE + JS 二次过滤，避免同名串扰）
      // 修订 #2：上报人隔离优先 reporter_user_id，缺失回退 real_name
      sql += ' AND (reporter_user_id=? OR (reporter_user_id IS NULL AND reporter=?) OR id IN (SELECT problem_id FROM pdca_consultants WHERE designer=?))';
      p.push(u.id);
      p.push(u.realName);
      p.push(u.realName);
    } else {
      sql += ' AND (reporter_user_id=? OR (reporter_user_id IS NULL AND reporter=?))'; p.push(u.id); p.push(u.realName);
    }
  }
  else if (mine === '1') { sql += ' AND (reporter_user_id=? OR (reporter_user_id IS NULL AND reporter=?))'; p.push(u.id); p.push(u.realName); }
  sql += ' ORDER BY created_at DESC';
  let list = enrichList(db.prepare(sql).all(...p));
  // 室主任（单一科室管理者）按本科室范围查看（未闭环/待办/院选候选），与宣贯 pending 范围一致；院领导/超管看全部
  if (isDivisionScopedManager(u)) {
    const myDiv = (u.division || '').trim();
    list = list.filter(r => problemInDivision(r, myDiv));
  }
  sendList(req, res, list);
});

// ── 详情 ──────────────────────────────────────
router.get('/problems/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // P3 可见性：公开阶段（未闭环 / 已解决 / 人人讲）全院可见（含游客）；非公开仅上报人 / 管理者 / 共议人可见
  const PDCA_PUBLIC = new Set(['found', 'solving', 'recorded', 'consulted', 'solved', 'reviewed', 'closed']);
  if (!PDCA_PUBLIC.has(p.status) && !canManage(req.user)) {
    const isSelf = reporterMatches(p, req.user);
    const isConsult = req.user.realName && db.prepare('SELECT 1 FROM pdca_consultants WHERE problem_id=? AND designer=?').get(p.id, req.user.realName);
    if (!isSelf && !isConsult) return res.status(403).json({ error: '无权查看该问题' });
  }
  try { p.consult_designers = p.consult_designers ? JSON.parse(p.consult_designers) : []; } catch (e) { p.consult_designers = []; }
  // 是否已到总工：请教专家名单中含 total_engineer（资深专家）→ 无需再追问 / 邀请设计师共议
  const _ce = (() => { try { return p.consult_experts ? JSON.parse(p.consult_experts) : []; } catch (e) { return []; } })();
  const _senior = db.prepare("SELECT real_name FROM users WHERE role='chief_engineer' AND is_active=1").all().map(r => r.real_name);
  p.reachedChief = _ce.some(n => _senior.includes(n));
  p.photos = db.prepare('SELECT id, photo_url FROM pdca_photos WHERE problem_id=?').all(p.id);
  p.solutions = db.prepare('SELECT * FROM pdca_solutions WHERE problem_id=? ORDER BY id').all(p.id).map(s => ({
    ...s,
    photos: safeJsonArr(s.photos),
    attachments: safeJsonArr(s.attachments),
  }));
  p.consults = db.prepare('SELECT * FROM pdca_consults WHERE problem_id=? ORDER BY round, id').all(p.id);
  // 每位专家一条独立答复，挂到对应 consult 轮次下（多专家可同时可见）
  const answers = db.prepare('SELECT * FROM pdca_answers WHERE problem_id=? ORDER BY consult_id, id').all(p.id);
  for (const c of p.consults) c.answers = answers.filter(a => a.consult_id === c.id);
  p.review = db.prepare('SELECT * FROM pdca_reviews WHERE problem_id=?').get(p.id) || null;
  const ru = db.prepare('SELECT role FROM users WHERE real_name=?').get(p.reporter);
  p.reporterRole = ru ? ru.role : '';
  // 参与者「是否已答复」标志（按专家/共议两类分别列出姓名），供前端追问阶段移除未答复参与者时判定
  const answeredRows = db.prepare('SELECT DISTINCT expert_name, role FROM pdca_answers WHERE problem_id=?').all(p.id);
  p.answeredExperts = answeredRows.filter(a => a.role === 'expert').map(a => a.expert_name);
  p.answeredDesigners = answeredRows.filter(a => a.role === 'designer').map(a => a.expert_name);
  res.json(p);
});

// ── 拟设方案 + 请教专家 ───────────────────────
router.post('/problems/:id/solution', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // P3⑨ 角色门：拟设解决方案仅上报人或管理者可写（前端按钮已隐藏，此处兜底防直调）
  if (!reporterMatches(p, req.user) && !canManage(req.user)) {
    return res.status(403).json({ error: '仅问题上报人或管理者可拟设解决方案' });
  }
  const { content, experts = [], photos = [], attachments = [] } = req.body;
  if (!content) return res.status(400).json({ error: '请填写拟设方案' });
  const photosArr = Array.isArray(photos) ? photos.filter(Boolean) : [];
  const attArr = Array.isArray(attachments) ? attachments.filter(a => a && a.url) : [];

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO pdca_solutions (problem_id, content, experts, created_by, photos, attachments) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.id, content.trim(), Array.isArray(experts) ? experts.join(',') : '', req.user.realName, JSON.stringify(photosArr), JSON.stringify(attArr));
    if (p.status === 'found') db.prepare("UPDATE pdca_problems SET status='solving', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  });
  tx();
  res.json({ message: '方案已提交' });
});

// ── 多轮追问：提问（重新通知已请教专家）──────────
router.post('/problems/:id/consult', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // P0 兜底：多轮追问仅上报人或管理者可发起（防任意用户向他人问题注入追问并骚扰专家）
  if (!reporterMatches(p, req.user) && !canManage(req.user)) {
    return res.status(403).json({ error: '仅问题上报人或管理者可追问' });
  }
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: '请填写追问内容' });
  const last = db.prepare('SELECT MAX(round) r FROM pdca_consults WHERE problem_id=?').get(p.id).r || 0;
  const experts = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO pdca_consults (problem_id, round, question, question_by) VALUES (?, ?, ?, ?)')
      .run(p.id, last + 1, question.trim(), req.user.realName);
    db.prepare("UPDATE pdca_problems SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
    for (const ex of experts) {
      notifyExpert(req.user.realName, ex, '通用', '追问：' + p.title, question.trim(), p.id);
    }
  });
  tx();
  res.json({ message: '已追问' });
});

// ── 邀请设计师共议（上报人、管理者、被请教专家、已被邀请共议的设计师，均可随时追加）──
router.post('/problems/:id/invite-designers', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // 已到总工：无需再请教专家 / 邀请设计师共议
  { const _ce = (() => { try { return p.consult_experts ? JSON.parse(p.consult_experts) : []; } catch (e) { return []; } })();
    const _senior = db.prepare("SELECT real_name FROM users WHERE role='chief_engineer' AND is_active=1").all().map(r => r.real_name);
    if (_ce.some(n => _senior.includes(n))) return res.status(403).json({ error: '已到总工，无需再请教专家 / 邀请设计师共议' }); }
  let { designers: inviteList = [] } = req.body;
  inviteList = stripGuestNames(inviteList);
  if (!Array.isArray(inviteList) || !inviteList.length) return res.status(400).json({ error: '请选择要邀请的设计师' });
  const existing = p.consult_designers ? JSON.parse(p.consult_designers) : [];
  const experts = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  const isExpertInvited = experts.includes(req.user.realName);
  const isDesignerInvited = existing.includes(req.user.realName);
  if (!canManage(req.user) && !reporterMatches(p, req.user) && !isExpertInvited && !isDesignerInvited) {
    return res.status(403).json({ error: '仅上报人、管理者、被请教专家或被邀请共议的设计师可邀请设计师共议' });
  }
  const added = inviteList.filter(d => !existing.includes(d));
  if (!added.length) return res.json({ message: '这些设计师已在共议名单中', designers: existing });
  const merged = Array.from(new Set([...existing, ...inviteList]));
  db.prepare('UPDATE pdca_problems SET consult_designers=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(merged), p.id);
  setConsultants(p.id, merged);
  for (const d of added) {
    notifyExpert(req.user.realName, d, '通用', '邀请共议：' + p.title, '就「' + p.title + '」邀请你参与共议，请在 PDCA 问题库中回复你的见解。', p.id);
  }
  res.json({ message: '已邀请设计师共议', designers: merged });
});

// ── 多轮追问：作答（专家 / 共议设计师均可回复，通知上报人）───────────────
// 每位专家各写一条独立答复（pdca_answers），不再覆盖同一 consult 的 answer 字段，
// 解决「框选多位专家时只能看到最后一位回复」的问题。
// role 区分：受邀专家 / 管理者答复记为 expert；被邀请共议的设计师记为 designer（共议）。
router.post('/problems/:id/answer', (req, res) => {
  const { consultId, answer, attachments, parentId } = req.body;
  if (!answer) return res.status(400).json({ error: '请填写答复' });
  const c = db.prepare('SELECT * FROM pdca_consults WHERE id=? AND problem_id=?').get(consultId, req.params.id);
  if (!c) return res.status(404).json({ error: '追问记录不存在' });
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  const experts = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  const designers = p.consult_designers ? JSON.parse(p.consult_designers) : [];
  const isExpert = experts.includes(req.user.realName);
  const isDesignerInvited = designers.includes(req.user.realName);
  if (!canManage(req.user) && !isExpert && !isDesignerInvited) {
    return res.status(403).json({ error: '仅被邀请的专家或被邀请共议的设计师可答复' });
  }
  // 楼中楼回复：parentId 必须指向同一问题下存在的答复，否则忽略（防空指针孤儿）
  let pid = null;
  if (parentId) {
    const pa = db.prepare('SELECT * FROM pdca_answers WHERE id=? AND problem_id=?').get(parentId, p.id);
    if (pa) pid = pa.id;
  }
  const role = (isExpert || canManage(req.user)) ? 'expert' : 'designer';
  // 专家答复可多次，每条独立成行；答复可附带照片 / 文件
  let attJson = null;
  if (Array.isArray(attachments) && attachments.length) {
    attJson = JSON.stringify(attachments.filter(a => a && a.url));
  }
  const info = db.prepare('INSERT INTO pdca_answers (consult_id, problem_id, expert_name, answer, answer_by, role, attachments, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(consultId, p.id, req.user.realName, answer.trim(), req.user.realName, role, attJson, pid);
  const prefix = role === 'designer' ? '共议回复：' : '专家已答复：';
  if (p) notifyExpert(req.user.realName, p.reporter, '通用', prefix + p.title, answer.trim(), p.id);
  res.json({ message: '已答复', role, id: info.lastInsertRowid, parentId: pid });
});

// ── 删除自己的发言（PDCA 答复）──────────────
// 仅本人可删；若该发言已被他人回复（存在 parent_id 指向它的子回复），则锁定不可删，
// 保证讨论链不断（"自己的发言被回答之后就不能删了"）。
router.delete('/answers/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM pdca_answers WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '发言不存在' });
  const isSuperAdmin = rbac.isSuperAdmin(req.user);
  if (!isSuperAdmin && a.answer_by !== req.user.realName) {
    return res.status(403).json({ error: '仅可删除自己的发言' });
  }
  const kids = db.prepare('SELECT COUNT(*) c FROM pdca_answers WHERE parent_id=?').get(a.id).c;
  if (!isSuperAdmin && kids > 0) {
    return res.status(403).json({ error: '该发言已被他人回复，不可删除' });
  }
  if (kids > 0) {
    // 超级管理员强制删除：把子回复的 parent_id 提升一级（指向祖父或置空），避免孤儿回复断链
    db.prepare('UPDATE pdca_answers SET parent_id=? WHERE parent_id=?').run(a.parent_id, a.id);
  }
  db.prepare('DELETE FROM pdca_answers WHERE id=?').run(a.id);
  res.json({ message: isSuperAdmin ? '已删除（管理员强制删除，子回复已提升一级）' : '已删除你的发言' });
});

// ── 标记已解决 → 进入回顾 ─────────────────────
router.post('/problems/:id/resolve', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // P0 兜底：标记已解决仅上报人或管理者可操作（防任意用户强制推进他人问题生命周期）
  if (!canManage(req.user) && !reporterMatches(p, req.user)) {
    return res.status(403).json({ error: '仅问题上报人或管理者可标记为已解决' });
  }
  // 已请教专家的问题，须有至少一条专家(expert)回复方可结束
  const experts = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  if (experts.length > 0) {
    const ea = db.prepare("SELECT COUNT(*) c FROM pdca_answers WHERE problem_id=? AND role='expert'").get(p.id).c;
    if (ea === 0) return res.status(403).json({ error: '该问题已请教专家，需专家至少回复一条后方可结束' });
  }
  db.prepare("UPDATE pdca_problems SET status='solved', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  res.json({ message: '已标记为已解决' });
});

// ── 复盘 + 提醒 ──────────────
// 权限：仅上报人可填主体复盘；管理者可填「管理备注」。二者皆非 → 403。
//   - 上报人：编辑 content / 提醒；管理者只读，仅补 manager_remark
//   - 人人讲规则：问题闭环即自动作为人人讲（不再通过勾选标记）
router.post('/problems/:id/review', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  const isReporter = reporterMatches(p, req.user);
  const isManager = canManage(req.user);
  if (!isReporter && !isManager) {
    return res.status(403).json({ error: '仅上报人或管理者可操作复盘' });
  }
  const ex = db.prepare('SELECT * FROM pdca_reviews WHERE problem_id=?').get(p.id) || {};
  // 上报人填主体（仅其本人可改）；管理者只读 + 填管理备注
  const content = isReporter ? (req.body.content || '').trim() : (ex.content || '');
  const isReminder = isReporter ? (req.body.is_reminder ? 1 : 0) : (ex.is_reminder || 0);
  const reminderAt = isReporter ? (req.body.reminder_at || null) : (ex.reminder_at || null);
  const reminderTarget = isReporter ? (req.body.reminder_target || '') : (ex.reminder_target || '');
  const managerRemark = (isManager && req.body.manager_remark !== undefined) ? (req.body.manager_remark || '').trim() : (ex.manager_remark || '');
  if (ex.id) {
    db.prepare(`UPDATE pdca_reviews SET content=?, is_reminder=?, reminder_at=?, reminder_target=?, manager_remark=? WHERE problem_id=?`)
      .run(content, isReminder, reminderAt, reminderTarget, managerRemark, p.id);
  } else {
    db.prepare(`INSERT INTO pdca_reviews (problem_id, content, is_reminder, reminder_at, reminder_target, manager_remark) VALUES (?,?,?,?,?,?)`)
      .run(p.id, content, isReminder, reminderAt, reminderTarget, managerRemark);
  }
  // 复盘状态：仅上报人填写主体后标记 reviewed（已闭环的帖不回退）
  if (isReporter && p.status !== 'closed') {
    db.prepare("UPDATE pdca_problems SET status='reviewed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  } else {
    db.prepare("UPDATE pdca_problems SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  }
  res.json({ message: '复盘已保存' });
});

// ── 关闭闭环（默认"谁开的谁关"：问题发起人可关闭，保障闭环责任归属）───────────
// P0 防死锁：发起人离职 / 长期未登录 / 遗忘时，问题会卡死无法闭环。
// 故允许管理者（专总/院长/室主任/超管）强制关闭任意问题；强制关闭需填 reason 以备审计追溯。
router.put('/problems/:id/close', async (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  // 谁开的帖子由谁关闭；管理者可强制关闭（防死锁）。
  const isReporter = reporterMatches(p, req.user);
  const forced = !isReporter && canManage(req.user);
  if (!isReporter && !canManage(req.user)) {
    return res.status(403).json({ error: '仅问题发起人或管理者可关闭该问题' });
  }
  if (forced) {
    const reason = (req.body.reason || '').toString().trim();
    if (!reason) return res.status(400).json({ error: '管理者强制关闭需填写原因（便于审计追溯）' });
  }
  // 已请教专家的问题，须有至少一条专家(expert)回复方可关闭
  const experts = p.consult_experts ? JSON.parse(p.consult_experts) : [];
  if (experts.length > 0) {
    const ea = db.prepare("SELECT COUNT(*) c FROM pdca_answers WHERE problem_id=? AND role='expert'").get(p.id).c;
    if (ea === 0) return res.status(403).json({ error: '该问题已请教专家，需专家至少回复一条后方可关闭' });
  }
  const wasClosed = p.status === 'closed';
  // 审计：强制关闭 vs 正常关闭
  if (forced) {
    audit({
      actor: req.user.realName, actorRole: req.user.role, action: 'force_close',
      targetType: 'pdca', targetId: p.id,
      detail: `管理者 ${req.user.realName} 强制关闭问题#${p.id}「${p.title}」（发起人 ${p.reporter} 未关闭），原因：${(req.body.reason || '').toString().trim()}`,
    });
  } else {
    audit({
      actor: req.user.realName, actorRole: req.user.role, action: 'close',
      targetType: 'pdca', targetId: p.id,
      detail: `发起人 ${req.user.realName} 闭环问题#${p.id}「${p.title}」`,
    });
  }
  db.prepare("UPDATE pdca_problems SET status='closed', closed_by=?, closed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(req.user.realName, p.id);
  // 闭环即把与该问题相关的「待办」（请教/共议/提醒类提醒）自动标记完成，从各相关人待办池移除
  // 注意：须放在 notifyRrjSelectors 之前，否则会误清「人人讲院选待确认」提醒（其于下方关闭后生成）
  db.prepare("UPDATE reminders SET state='done', done_at=CURRENT_TIMESTAMP WHERE related_problem_id=? AND state<>'done'").run(p.id);
  // 闭环激励：PDCA 问题闭环 → 上报人得 2 朵小红花（仅首次闭环发放；若已院选则改记人人讲 3 朵，不再叠加，防重开→重闭环造成 pdca 与 rrj 双计）
  let flower = 0;
  if (!wasClosed && !p.rrj_selected) {
    const reporterUser = p.reporter_user_id != null ? { id: p.reporter_user_id } : (db.prepare('SELECT id FROM users WHERE real_name=?').get(p.reporter) || null);
    if (awardFlower({ kind: 'pdca', refId: p.id, userName: p.reporter, userId: reporterUser ? reporterUser.id : null, title: p.title, awardedBy: req.user.realName, amount: 2 })) flower = 2;
  }

  // 闭环自动同步到 IMA「质量人人讲」：上报人闭环即推送（不再依赖人人讲标记），幂等防重复
  let imaUrl = '';
  let imaSynced = false;
  try {
    if (!p.ima_media_id) {
      const full = assembleFullProblem(p);
      full.existingFolderId = p.ima_folder_id;
      const r = await pushRenrenjiang(full, {});
      if (r.media_id) db.prepare('UPDATE pdca_problems SET ima_media_id=? WHERE id=?').run(r.media_id, p.id);
      if (r.folderId) db.prepare('UPDATE pdca_problems SET ima_folder_id=? WHERE id=?').run(r.folderId, p.id);
      imaUrl = r.url || '';
      imaSynced = !!(r && r.media_id);
    }
  } catch (e) { console.error('[人人讲] IMA 同步失败：', e.message); }

  // 闭环已同步至 IMA「质量人人讲」，通知可院选角色（室主任/专总/院长/超管）确认是否院选（仅在首次闭环时通知，避免重复）
  if (!wasClosed) {
    try {
      notifyRrjSelectors(p);
    } catch (e) { console.error('[人人讲] 院选通知失败：', e.message); }
  }

  res.json({ message: '已关闭', flower, imaUrl, imaSynced });
});

// 通知所有可院选角色（仅 专总 / 院长）去管理端确认是否院选人人讲
function notifyRrjSelectors(p) {
  // 幂等：先清理本问题已有的「人人讲院选待确认」提醒，避免 关闭→重开→再关闭 时重复群发
  try { db.prepare("DELETE FROM reminders WHERE related_problem_id=? AND title LIKE '人人讲院选待确认%'").run(p.id); } catch (e) {}
  const selectable = new Set(['chief', 'dean']);
  const users = db.prepare('SELECT id, real_name, role, extra_roles, serverchan_key FROM users WHERE is_active=1').all();
  for (const u of users) {
    let extra = [];
    try { extra = JSON.parse(u.extra_roles || '[]'); } catch (e) { extra = []; }
    const roles = [u.role, ...extra];
    if (!roles.some(r => selectable.has(r))) continue;
    notifyExpert(p.reporter, u.real_name, '通用', '人人讲院选待确认：' + p.title,
      `问题「${p.title}」已由 ${p.reporter} 闭环并同步至 IMA「质量人人讲」，请在管理端「人人讲院选」中确认是否入选院选。`, p.id);
    // 微信提醒（院选待精选，精准到专总/院长）
    if (u.serverchan_key) {
      push.pushToUser(u, '人人讲院选待确认', `【质量千里行】人人讲院选待确认：${p.title}\n问题已由 ${p.reporter} 闭环并同步至 IMA，请在管理端确认是否入选院选。`).catch(() => {});
    }
  }
}

// ── 人人讲「院选」（室主任/专总/院长/系统管理员精选，首页人人讲版块来源）──
// 仅 室主任/专总/院长/admin 可操作；仅有已闭环的问题可被精选。
// 精选：回撤该问题闭环时的 2 朵小红花，改记「人人讲院选」3 朵；
// 取消精选：删除院选花，恢复闭环花 2 朵。
router.post('/problems/:id/select-rrj', async (req, res) => {
  const roles = rbac.rolesOf(req.user);
  // 仅 专总 / 院长 可院选精选（2026-07-26 优化：收窄，不再含室主任/超管）
  const canSelect = rbac.canSelectRrj(req.user);
  if (!canSelect) return res.status(403).json({ error: '仅专总/院长可精选人人讲' });
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  const selected = req.body.selected ? 1 : 0;
  if (selected && p.status !== 'closed') {
    return res.status(400).json({ error: '仅已闭环的 PDCA 问题可被精选为人人讲' });
  }
  const reporterUser = db.prepare('SELECT id FROM users WHERE real_name=?').get(p.reporter);
  if (selected) {
    db.prepare("UPDATE pdca_problems SET rrj_selected=1, rrj_selected_by=?, rrj_rejected=0, rrj_rejected_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.realName, p.id);
    removeFlowers('pdca', p.id); // 回撤闭环的 2 朵
    awardFlower({ kind: 'rrj', refId: p.id, userName: p.reporter, userId: reporterUser ? reporterUser.id : null, title: p.title, awardedBy: req.user.realName, amount: 3 });
    audit({ actor: req.user.realName, actorRole: req.user.role, action: 'rrj_select', targetType: 'pdca', targetId: p.id, detail: `专总/院长 ${req.user.realName} 将问题#${p.id}「${p.title}」入选人人讲院选` });
    // 院选后推送到 IMA「03千里行质量人人讲院选」（幂等：已推过则跳过）
    try {
      if (!p.ima_selected_media_id) {
        const full = assembleFullProblem(p);
        full.existingFolderId = p.ima_folder_id;
        const r = await pushRenrenjiang(full, { selected: true });
        if (r.media_id) db.prepare('UPDATE pdca_problems SET ima_selected_media_id=? WHERE id=?').run(r.media_id, p.id);
      }
    } catch (e) { console.error('[人人讲] 院选 IMA 同步失败：', e.message); }
  } else {
    db.prepare("UPDATE pdca_problems SET rrj_selected=0, rrj_selected_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
    removeFlowers('rrj', p.id); // 删除院选花
    awardFlower({ kind: 'pdca', refId: p.id, userName: p.reporter, userId: reporterUser ? reporterUser.id : null, title: p.title, awardedBy: req.user.realName, amount: 2 }); // 恢复闭环花
    audit({ actor: req.user.realName, actorRole: req.user.role, action: 'rrj_cancel', targetType: 'pdca', targetId: p.id, detail: `专总/院长 ${req.user.realName} 取消问题#${p.id}「${p.title}」的人人讲院选` });
  }
  // 院选确认/取消即把该问题的「人人讲院选待确认」待办自动标记完成（决策已作出，相关管理者信息页不再显示）
  // 用 try/catch 包裹：清理失败绝不影响主流程（rrj_selected 已落库），并记录日志便于排查
  try {
    const cleared = db.prepare("UPDATE reminders SET state='done', done_at=CURRENT_TIMESTAMP WHERE related_problem_id=? AND state<>'done' AND title LIKE '人人讲院选待确认%'").run(p.id);
    if (cleared.changes) console.log(`[人人讲] 院选决策已自动清除 ${cleared.changes} 条「院选待确认」提醒，问题#${p.id}`);
  } catch (e) { console.error('[人人讲] 清除院选待确认提醒失败：', e.message); }
  const np = db.prepare('SELECT rrj_selected, rrj_selected_by FROM pdca_problems WHERE id=?').get(p.id);
  res.json({ message: selected ? '已入选人人讲（＋3 🏵️）并同步至 IMA「03千里行质量人人讲院选」' : '已取消精选（恢复闭环 2 🏵️）', rrjSelected: !!np.rrj_selected, rrjSelectedBy: np.rrj_selected_by || '' });
});

// ── 人人讲「院选」：管理者标记「不选」（该条从待选栏目消失）──────────────
// 仅 专总 / 院长 可操作；仅已闭环问题可操作。rejected=false 用于「重新考虑」撤销。
router.post('/problems/:id/rrj-reject', (req, res) => {
  if (!rbac.canSelectRrj(req.user)) return res.status(403).json({ error: '仅专总/院长可操作院选' });
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  if (p.status !== 'closed') return res.status(400).json({ error: '仅已闭环的问题可标记院选' });
  const rejected = req.body.rejected === false ? 0 : 1;
  if (rejected) {
    db.prepare("UPDATE pdca_problems SET rrj_rejected=1, rrj_rejected_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.realName, p.id);
  } else {
    db.prepare("UPDATE pdca_problems SET rrj_rejected=0, rrj_rejected_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  }
  audit({ actor: req.user.realName, actorRole: req.user.role, action: rejected ? 'rrj_reject' : 'rrj_reconsider', targetType: 'pdca', targetId: p.id, detail: `专总/院长 ${req.user.realName} ${rejected ? '标记问题#'+p.id+'「'+p.title+'」为院选不选' : '撤销问题#'+p.id+'「'+p.title+'」的院选不选'}` });
  res.json({ message: rejected ? '已标记为不选（从待选栏目移除）' : '已重新纳入候选', rrjRejected: !!rejected });
});

// ── 已闭环 PDCA 管理者调整（专业 / 地区 / 类型 + 管理者备注）──
// 仅管理者（专总/院长/室主任/超管）可操作；仅已闭环问题可调整（院选前/后均可）。
// 用于管理者纠正提问者错漏的分类、地区，并补充院选备注；调整不影响已同步 IMA 的内容。
router.put('/problems/:id/note', (req, res) => {
  if (!rbac.canManage(req.user)) return res.status(403).json({ error: '仅管理者可调整专业/地区/类型或加备注' });
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  if (p.status !== 'closed') return res.status(400).json({ error: '仅已闭环的问题可调整专业/地区/类型或加备注' });
  const body = req.body || {};
  const sets = [];
  const params = [];
  // 专业 / 子专业（管理者可重设提问者设立的分类）
  if (Array.isArray(body.divisions) || body.division !== undefined) {
    const { divisions, subDivisions, div, subDiv } = normDivisions(body);
    sets.push('divisions=?', 'sub_divisions=?', 'division=?', 'sub_division=?');
    params.push(JSON.stringify(divisions), JSON.stringify(subDivisions), div, subDiv);
  }
  if (body.region !== undefined) { sets.push('region=?'); params.push((body.region || '').toString().trim()); }
  if (body.category !== undefined) { sets.push('category=?'); params.push((body.category || '').toString().trim()); }
  const note = (body.note || '').toString().trim();
  sets.push('manager_note=?', 'manager_note_by=?', 'manager_note_at=CURRENT_TIMESTAMP', 'updated_at=CURRENT_TIMESTAMP');
  params.push(note, req.user.realName);
  params.push(p.id);
  db.prepare('UPDATE pdca_problems SET ' + sets.join(', ') + ' WHERE id=?').run(...params);
  const np = db.prepare('SELECT divisions, sub_divisions, region, category, manager_note, manager_note_by, manager_note_at FROM pdca_problems WHERE id=?').get(p.id);
  res.json({
    message: note ? '已保存调整（专业/地区/类型 + 管理者备注）' : '已保存调整（专业/地区/类型）',
    divisions: safeJsonArr(np.divisions), sub_divisions: safeJsonArr(np.sub_divisions),
    region: np.region, category: np.category,
    manager_note: np.manager_note, manager_note_by: np.manager_note_by, manager_note_at: np.manager_note_at,
  });
});

// ── 人人讲「院选」待选计数（专总/院长的红点用）──
// 仅已闭环、尚未被院选的 PDCA 问题计入；只有可院选角色（专总/院长）才返回真实数，其余返回 0。
router.get('/rrj-pending', (req, res) => {
  const canSelect = rbac.canSelectRrj(req.user);
  if (!canSelect) return res.json({ count: 0 });
  const n = db.prepare("SELECT COUNT(*) AS c FROM pdca_problems WHERE status='closed' AND rrj_selected=0 AND (rrj_rejected IS NULL OR rrj_rejected=0)").get().c;
  res.json({ count: n || 0 });
});

// ── 重新打开（已解决/已回顾 → 回到待解决，可继续追问）──
// 仅上报人或管理者可操作；回退状态：请教过专家→已请教，否则→已记录
router.put('/problems/:id/reopen', (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  if (!canManage(req.user) && !reporterMatches(p, req.user)) {
    return res.status(403).json({ error: '仅上报人或管理者可重新打开' });
  }
  const hadExperts = p.consult_experts && JSON.parse(p.consult_experts).length;
  const newStatus = hadExperts ? 'consulted' : 'recorded';
  db.prepare("UPDATE pdca_problems SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(newStatus, p.id);
  // 重开即不再闭环：回撤其闭环小红花，保证「花随闭环状态」（再闭环会幂等重发，不会漏/重计）；
  // 若已院选(rrj花)则院选花由取消院选逻辑处理，此处不动 rrj，避免与院选状态冲突
  removeFlowers('pdca', p.id);
  audit({ actor: req.user.realName, actorRole: req.user.role, action: 'reopen', targetType: 'pdca', targetId: p.id, detail: `${req.user.realName} 重新打开问题#${p.id}「${p.title}」（状态回到 ${newStatus}）` });
  res.json({ message: '已重新打开，可继续追问', status: newStatus });
});

// ── 一键加入 IMA 质量库「质量人人讲」（复盘时调用）──
// 先落库复盘，再把整条问题（docx + 照片 + 附件）推送到 IMA。
// 复盘并贴入 IMA = 已闭环：首次入 IMA 即置 status='closed'、发放闭环小红花、通知管理者院选。
// 幂等：已推送过则跳过推送；已闭环则跳过闭环副作用（避免重复发花 / 重复通知）。
router.post('/problems/:id/ima', async (req, res) => {
  const p = db.prepare('SELECT * FROM pdca_problems WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '问题不存在' });
  if (!reporterMatches(p, req.user)) {
    return res.status(403).json({ error: '仅上报人可加入 IMA 质量库' });
  }
  // 若带复盘内容，先落库（与 /review 同逻辑）
  const { content, mode = 'full' } = req.body || {};
  if (content !== undefined) {
    const existing = db.prepare('SELECT id FROM pdca_reviews WHERE problem_id=?').get(p.id);
    if (existing) {
      db.prepare('UPDATE pdca_reviews SET content=? WHERE problem_id=?')
        .run(content.trim(), p.id);
    } else {
      db.prepare('INSERT INTO pdca_reviews (problem_id, content) VALUES (?, ?)')
        .run(p.id, content.trim());
    }
    db.prepare("UPDATE pdca_problems SET status='reviewed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  }
  // 推送到 IMA「质量人人讲」：默认幂等（已推送过则跳过）；可显式 rePush 重推（内容有变时），重推标题加版本后缀。
  let imaSynced = false, imaUrl = '', mediaId = p.ima_media_id;
  const rePush = req.body.rePush === true || req.body.rePush === '1';
  const shouldPush = rePush || !p.ima_media_id;
  if (shouldPush) {
    const full = assembleFullProblem(p);
    full.existingFolderId = p.ima_folder_id;
    try {
      const r = await pushRenrenjiang(full, { reviewOnly: mode === 'review', liveReview: content, rePush });
      if (r.media_id) db.prepare('UPDATE pdca_problems SET ima_media_id=? WHERE id=?').run(r.media_id, p.id);
      if (r.folderId) db.prepare('UPDATE pdca_problems SET ima_folder_id=? WHERE id=?').run(r.folderId, p.id);
      mediaId = r.media_id;
      imaUrl = r.url || '';
      imaSynced = !!(r && r.media_id);
    } catch (e) {
      return res.status(502).json({ error: 'IMA 入库失败：' + e.message });
    }
  }
  // 闭环认可：复盘并贴入 IMA = 已闭环。首次置闭环时发放小红花 + 通知管理者院选候选（已院选则跳过，避免 pdca 与 rrj 双计）。
  let justClosed = false;
  if (p.status !== 'closed' && !p.rrj_selected) {
    db.prepare("UPDATE pdca_problems SET status='closed', closed_by=?, closed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(req.user.realName, p.id);
    const reporterUser = p.reporter_user_id != null ? { id: p.reporter_user_id } : (db.prepare('SELECT id FROM users WHERE real_name=?').get(p.reporter) || null);
    awardFlower({ kind: 'pdca', refId: p.id, userName: p.reporter, userId: reporterUser ? reporterUser.id : null, title: p.title, awardedBy: req.user.realName, amount: 2 });
    try { notifyRrjSelectors(p); } catch (e) { console.error('[人人讲] 院选通知失败：', e.message); }
    justClosed = true;
  }
  res.json({ message: '已加入 IMA 质量库「质量人人讲」' + (mode === 'review' ? '（仅复盘感悟）' : '') + (justClosed ? '，问题已闭环' : ''), media_id: mediaId, url: imaUrl, imaSynced, justClosed });
});

module.exports = router;
