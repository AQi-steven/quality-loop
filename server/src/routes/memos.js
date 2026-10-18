/**
 * 项目备忘（📝项目备忘）
 *
 * 用途：多名设计师围绕「同一个项目」分头记录项目信息（标题/地点/场景/重点信息/图片/文件），
 *       第一个记录的人开立项目，后续同名自动归并；以「参与人」为单位互通内容。
 *
 * 记录结构（去掉了旧「类别」字段）：
 *   标题 / 地点 / 场景 / 重点信息传递(文字) / 图片 / 文件 / 谁可见(多选) / 存草稿 or 发布
 *
 * 可见范围（发布后）：
 *   - 作者本人
 *   - 本项目「参与记录人」= 在该项目发布过记录的所有人（自动互看）
 *   - 作者在「谁可见」里显式勾选的人（可把项目外的人拉进来）
 *   - 专总(role chief) 与 超级管理员(superadmin/超级管理员) 强制可见（院级 oversight，只读）
 * 草稿：仅作者本人可见，可再次打开修改 / 发布。
 *
 * 权限：全部需登录；游客（isGuest）一律 403（本功能对游客隐藏）。
 *       记录仅作者本人可编辑（专总 / 超级管理员 仅可见、不可改；杜绝「后面人改前面人记录」）。
 *       删除：仅超级管理员（superadmin / 真实姓名超级管理员）可删，集中管控，杜绝他人误删 / 抹除项目历史。
 *
 * 附件：前端先走 POST /api/upload 拿 urls，再随 JSON 提交（本路由不碰 multipart）。
 */
const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');
const ima = require('../ima');

const router = express.Router();

// 本功能对游客默认隐藏：统一要求登录；游客（isGuest）一律 403，
// 例外（2026-09-11 用户裁定 guest1/guest2；2026-09-13 追加 guest9）：这些游客只读放开 —— 仅放行 GET（项目列表 / 记录查看），
// 一切写操作（首开项目、发记录、回复、提醒关闭等 POST/PUT/DELETE）仍 403。
//   · guest9 = 院领导(院长)视野游客，与超级管理员视野统一、仅只读。
router.use(authMiddleware);
const GUEST_MEMO_READ = ['guest1', 'guest2', 'guest9'];
router.use((req, res, next) => {
  if (req.user && req.user.isGuest) {
    // 只读放开：白名单游客 + 可考试只读游客（EXAMGUEST1~EXAMGUEST9；JWT 已带 canExam）。
    // 一切写操作（开立项目 / 发记录 / 回复 / 成员维护 / 删除）仍 403。
    const ro = req.method === 'GET' && (GUEST_MEMO_READ.includes(req.user.username) || req.user.canExam);
    if (!ro) return res.status(403).json({ error: '游客无权访问项目信息传递' });
  }
  next();
});

function safeJson(s, def = []) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : def; } catch (e) { return def; }
}

// 收集某条记录的全部后代（楼中楼回复）id，含自身。用于删除时连同整条回复链一并清除。
function collectMemoDescendantIds(rootId) {
  const result = [rootId];
  const seen = new Set(result);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    const children = db.prepare('SELECT id FROM project_memos WHERE parent_id=?').all(cur);
    for (const c of children) {
      if (!seen.has(c.id)) { seen.add(c.id); result.push(c.id); stack.push(c.id); }
    }
  }
  return result;
}

// 项目备忘 IMA：每个项目在「SHARE-知识库」KB 根目录按项目名自动建一个文件夹，
// 首次用时创建并回写 project_memo_projects.ima_new_folder_id；后续记录平铺进该项目文件夹。
// 注：IMA OpenAPI 无法嵌套子文件夹（create_folder 忽略 parent，落到 KB 根），故项目文件夹与「质量信息总库」同级，
// 由用户在 IMA 桌面端按需归整进对应层级。
async function ensureProjectMemoFolder(project) {
  if (project && project.ima_new_folder_id) return project.ima_new_folder_id;
  const fid = await ima.ensureProjectFolder(project.name);
  if (project && project.id) {
    db.prepare('UPDATE project_memo_projects SET ima_new_folder_id=? WHERE id=?').run(fid, project.id);
  }
  if (project) project.ima_new_folder_id = fid;
  return fid;
}

// 生成「信息沟通人邀请」提醒：当开立人/参与者把某人拉入本项目信息沟通人时，向被邀请人发一条提醒，
// 供其个人中心「项目备忘提醒」收件箱展示 → 一键跳回原帖。重复邀请（已存在成员）由 INSERT 语义自然幂等（不重复打扰）。
function notifyMemoInvite(project, sender, newMemberIds) {
  if (!project || !newMemberIds || !newMemberIds.length) return;
  const ins = db.prepare(
    `INSERT INTO reminders (sender_id, sender_name, recipient_id, recipient_name, type, title, content, related_memo_project_id, created_at)
     VALUES (?,?,?,?, '信息沟通人邀请', ?, '', ?, datetime('now'))`
  );
  for (const rid of newMemberIds) {
    if (rid === sender.id) continue;
    const u = db.prepare('SELECT id, real_name FROM users WHERE id=?').get(rid);
    if (!u) continue;
    const title = `${sender.realName || sender.username} 邀请你加入「${project.name}」的信息沟通人`;
    ins.run(sender.id, sender.realName || sender.username, u.id, u.real_name, title, project.id);
  }
}

// 人员名单（所有在职真实用户，供「谁可见」多选）；排除游客账户
// 2026-08-02：排除总工(chief_engineer) —— 三位总工不进入「信息沟通人」可邀请目录，
// 只有 专总/院长 在解决问题(PDCA)时才可邀请总工（见 rbac.canInviteChiefEngineer）。
router.get('/personnel', (req, res) => {
  const users = db.prepare(
    "SELECT id, real_name, role FROM users WHERE is_active=1 AND COALESCE(is_guest,0)=0 AND role != 'chief_engineer' AND COALESCE(title_tag,'') <> '体验账号' ORDER BY role ASC, real_name ASC"
  ).all();
  res.json(users);
});

// 「项目备忘提醒」收件箱：当前用户被开立人/参与者邀请加入某项目「信息沟通人」时收到的提醒，
// 供个人中心卡片展示，点击 → 跳回原项目（闭环缺口1重做：由「按 viewers 共享」改为「被邀请人提醒」）。
router.get('/my-reminders', (req, res) => {
  const u = req.user;
  const rows = db.prepare(`
    SELECT r.id, r.type, r.title, r.content, r.sender_name, r.created_at,
           r.related_memo_project_id, r.related_memo_record_id,
           p.name AS project_name
    FROM reminders r
    LEFT JOIN project_memo_projects p ON p.id = r.related_memo_project_id
    WHERE r.recipient_id = ? AND r.recipient_deleted = 0
      AND r.type = '信息沟通人邀请'
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 50
  `).all(u.id);
  res.json(rows);
});

// 关闭「项目备忘提醒」：仅收件人本人可关闭自己的「信息沟通人邀请」类提醒（软隐藏 recipient_deleted=1）。
// 关闭后该条不再出现在个人卡片/弹窗，但「发送给对方」的发起侧视角不受影响（对方仍可在项目内看到你）。
// 2026-08-02 新增：对标其他提醒的「可关闭」按钮，避免提醒永远留在框里。
router.post('/my-reminders/:id/dismiss', (req, res) => {
  const u = req.user;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的提醒 ID' });
  const r = db.prepare("SELECT id, recipient_id, type FROM reminders WHERE id = ? AND type = '信息沟通人邀请'").get(id);
  if (!r) return res.status(404).json({ error: '提醒不存在' });
  if (r.recipient_id !== u.id) return res.status(403).json({ error: '只能关闭自己收到的提醒' });
  db.prepare("UPDATE reminders SET recipient_deleted = 1 WHERE id = ?").run(id);
  res.json({ ok: true });
});

// 项目列表（含发布记录数 + 参与记录人 + 最近时间），按最近时间倒序；?kw= 模糊过滤
router.get('/projects', (req, res) => {
  const kw = String(req.query.kw || '').trim();
  let sql = `
    SELECT p.id, p.name, p.code, p.region, p.opened_by, p.opened_by_name, p.opened_at,
           (SELECT COUNT(*) FROM project_memos m WHERE m.project_id = p.id AND m.status='published') AS record_count,
           (SELECT COUNT(DISTINCT m.author_id) FROM project_memos m WHERE m.project_id = p.id AND m.status='published') AS contributor_count,
           (SELECT GROUP_CONCAT(DISTINCT m.author_name) FROM project_memos m WHERE m.project_id = p.id AND m.status='published') AS contributor_names,
           (SELECT MAX(COALESCE(m.published_at, m.created_at)) FROM project_memos m WHERE m.project_id = p.id) AS last_at
    FROM project_memo_projects p
  `;
  const args = [];
  if (kw) {
    sql += ' WHERE p.name LIKE ? OR p.code LIKE ? OR p.region LIKE ?';
    const like = `%${kw}%`;
    args.push(like, like, like);
  }
  sql += ' ORDER BY (last_at IS NULL), last_at DESC, p.id DESC';
  res.json(db.prepare(sql).all(...args));
});

// 首开项目（name 全局唯一；同名自动归并返回已存在项目，幂等）
router.post('/projects', (req, res) => {
  const u = req.user;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写项目名称' });
  const code = String(req.body.code || '').trim();
  const region = String(req.body.region || '').trim();
  const participants = Array.isArray(req.body.participants) ? req.body.participants.map(Number).filter(Boolean) : [];
  const exist = db.prepare('SELECT * FROM project_memo_projects WHERE name=?').get(name);
  if (exist) return res.json({ project: exist, merged: true, message: '已存在同名项目，已自动归并' });
  const info = db.prepare(
    "INSERT INTO project_memo_projects (name, code, region, opened_by, opened_by_name, opened_at) VALUES (?,?,?,?,?, datetime('now'))"
  ).run(name, code, region, u.id, u.realName);
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(info.lastInsertRowid);
  // 开立人自身 + 受邀参与人写入成员表（驱动可见性与可参与性）
  const insMember = db.prepare('INSERT OR IGNORE INTO project_memo_members (project_id, user_id, invited_by, joined_at) VALUES (?,?,?,datetime(\'now\'))');
  insMember.run(project.id, u.id, u.id);
  const addedParticipants = [];
  for (const pid of participants) { if (pid && pid !== u.id) { insMember.run(project.id, pid, u.id); addedParticipants.push(pid); } }
  // 开立时勾选的参与人 = 被开立人邀请加入信息沟通人 → 发提醒
  if (addedParticipants.length) notifyMemoInvite(project, u, addedParticipants);
  res.json({ project, merged: false });
});

// 项目详情：参与记录人名单（全员可见）+ 记录列表（按可见性裁剪，不可见仅返回占位）
router.get('/projects/:id/records', (req, res) => {
  const u = req.user;
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });

  // 参与记录人（在该项目发布过记录的所有人，去重；at=首次发布时间）—— 全员可见
  const contributors = db.prepare(`
    SELECT author_id, author_name,
           MIN(COALESCE(published_at, created_at)) AS at
    FROM project_memos
    WHERE project_id=? AND status='published'
    GROUP BY author_id, author_name
    ORDER BY at ASC, author_id ASC
  `).all(project.id);

  // 项目参与人（显式成员表：开立人 + 被邀请人 + 所有发布记录人；全员可见其名单）
  const members = db.prepare(`
    SELECT mm.user_id AS user_id, u.real_name AS real_name, mm.invited_by AS invited_by,
           (SELECT real_name FROM users WHERE id = mm.invited_by) AS invited_by_name,
           mm.joined_at AS joined_at
    FROM project_memo_members mm
    LEFT JOIN users u ON u.id = mm.user_id
    WHERE mm.project_id = ?
    ORDER BY mm.joined_at ASC, mm.user_id ASC
  `).all(project.id);

  // 本项目成员集合（参与人互看 / 被邀请人可见全部）
  const memberIds = new Set(members.map(m => m.user_id));
  const oversight = rbac.isOversight(u);
  // 仅超级管理员（superadmin / 真实姓名超级管理员）可删除项目备忘（集中管控，杜绝他人误删/抹除项目历史）
  const isSuperAdmin = rbac.isSuperAdmin(u);

  const rows = db.prepare(
    `SELECT * FROM project_memos WHERE project_id=? ORDER BY COALESCE(published_at, created_at) ASC, id ASC`
  ).all(project.id);

  const records = rows.map(r => {
    const isDraft = r.status === 'draft';
    // 草稿：仅作者可见
    if (isDraft) {
      if (r.author_id !== u.id) return null; // 非作者看不到这条草稿
      return {
        id: r.id, status: 'draft', isDraft: true, mine: true, canEdit: true, canDelete: isSuperAdmin, locked: false, canConvert: false,
        author_id: r.author_id, author_name: r.author_name,
        title: r.title, location: r.location, scenario: r.scenario, content: r.content,
        photos: safeJson(r.photos), attachments: safeJson(r.attachments), viewers: safeJson(r.viewers),
        created_at: r.created_at, updated_at: r.updated_at,
      };
    }
    // 发布记录：计算可见性（参与人自动互看 = 当前用户是否在本项目发布过记录）
    const mine = r.author_id === u.id;
    const canSee = mine || memberIds.has(u.id) || safeJson(r.viewers).includes(u.id) || oversight;
      if (!canSee) {
      // 仅返回占位（作者名 + 时间），内容对当前用户不可见
      return {
        id: r.id, status: 'published', isDraft: false, mine: false, canEdit: false, canDelete: false, locked: true, canConvert: false,
        author_id: r.author_id, author_name: r.author_name,
        parent_id: r.parent_id,
        created_at: r.created_at,
        published_at: r.published_at,
      };
    }
    return {
      id: r.id, status: 'published', isDraft: false, mine, canEdit: mine, canDelete: isSuperAdmin, locked: false, canConvert: true,
      author_id: r.author_id, author_name: r.author_name,
      parent_id: r.parent_id,
      title: r.title, location: r.location, scenario: r.scenario, content: r.content,
      photos: safeJson(r.photos), attachments: safeJson(r.attachments), viewers: safeJson(r.viewers),
      created_at: r.created_at, updated_at: r.updated_at, published_at: r.published_at,
      ima_media_id: r.ima_media_id, ima_url: r.ima_url || '', ima_folder_id: r.ima_folder_id || '',
      projectName: project.name,
    };
  }).filter(Boolean);

  // 受保护成员（开立人 + 已发布记录作者）：前端管理成员时显示为不可移除
  const publishedAuthorIds = db.prepare(
    "SELECT DISTINCT author_id FROM project_memos WHERE project_id=? AND status='published'"
  ).all(project.id).map(x => x.author_id);
  const protectedIds = [project.opened_by, ...publishedAuthorIds];

  res.json({ project, contributors, members, records, protectedIds });
});

// 管理「信息沟通人」：仅本项目开立人本人可调（增删名单）。
// 受保护成员永远保留：① 开立人本人（不可移除自己）；② 在本项目发布过记录的人（贡献了内容，避免误删导致可见性异常）。
// 系统管理员账号一律不进入信息沟通人名单。
// body.userIds = 开立人期望的「信息沟通人」完整名单（不含开立人与受保护作者，他们始终保留）。
router.put('/projects/:id/members', (req, res) => {
  const u = req.user;
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (project.opened_by !== u.id) return res.status(403).json({ error: '仅项目开立人本人可管理信息沟通人' });

  const adminIds = new Set(db.prepare("SELECT id FROM users WHERE role='admin'").all().map(x => x.id));
  let input = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
  input = input.filter(id => id !== u.id && !adminIds.has(id));
  // 剔除游客：游客仅 GET 只读，不应被加为「信息沟通人」从而获得项目记录的读权限
  const guestIds = new Set(db.prepare("SELECT id FROM users WHERE COALESCE(is_guest,0)=1").all().map(x => x.id));
  input = input.filter(id => !guestIds.has(id));

  // 受保护：开立人 + 本项目已发布记录作者（自动加入、贡献了内容）
  const publishedAuthorIds = db.prepare(
    "SELECT DISTINCT author_id FROM project_memos WHERE project_id=? AND status='published'"
  ).all(project.id).map(x => x.author_id);
  const protectedIds = new Set([project.opened_by, ...publishedAuthorIds]);

  const desired = new Set([...protectedIds, ...input]);
  const current = db.prepare('SELECT user_id FROM project_memo_members WHERE project_id=?').all(project.id).map(x => x.user_id);

  const removed = current.filter(cid => !desired.has(cid));
  const delMember = db.prepare('DELETE FROM project_memo_members WHERE project_id=? AND user_id=?');
  for (const cid of removed) { delMember.run(project.id, cid); }

  // 被移出信息沟通人 → 其「信息沟通人邀请」提醒从他视角隐藏（软删，不影响对方）
  if (removed.length) {
    const hideRem = db.prepare(
      "UPDATE reminders SET recipient_deleted=1 WHERE recipient_id=? AND type='信息沟通人邀请' AND related_memo_project_id=? AND recipient_deleted=0"
    );
    for (const rid of removed) hideRem.run(rid, project.id);
  }

  const insMember = db.prepare('INSERT OR IGNORE INTO project_memo_members (project_id, user_id, invited_by, joined_at) VALUES (?,?,?,datetime(\'now\'))');
  const added = [];
  for (const did of desired) { if (!current.includes(did)) { insMember.run(project.id, did, u.id); added.push(did); } }
  // 新被邀请加入信息沟通人 → 发提醒（收件箱展示，一键跳回原帖）
  if (added.length) notifyMemoInvite(project, u, added);

  const members = db.prepare(`
    SELECT mm.user_id AS user_id, u.real_name AS real_name, mm.invited_by AS invited_by,
           (SELECT real_name FROM users WHERE id = mm.invited_by) AS invited_by_name,
           mm.joined_at AS joined_at
    FROM project_memo_members mm
    LEFT JOIN users u ON u.id = mm.user_id
    WHERE mm.project_id = ?
    ORDER BY mm.joined_at ASC, mm.user_id ASC
  `).all(project.id);
  res.json({ members, protectedIds: [...protectedIds] });
});

// 删除整个项目（含其全部记录与成员）：仅超级管理员（superadmin / 真实姓名超级管理员）可操作，集中管控。
router.delete('/projects/:id', (req, res) => {
  const u = req.user;
  if (!rbac.isSuperAdmin(u)) return res.status(403).json({ error: '仅超级管理员可删除项目' });
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  // project_memos 的外键未设级联，须先清记录，成员表有级联可省略，但显式清理更稳妥
  // 包事务：任一语句中途失败不应残留半删项目
  const delProject = db.transaction(() => {
    db.prepare('DELETE FROM project_memos WHERE project_id=?').run(project.id);
    db.prepare('DELETE FROM project_memo_members WHERE project_id=?').run(project.id);
    db.prepare('DELETE FROM project_memo_projects WHERE id=?').run(project.id);
    // 级联删除：该项目对全体信息沟通人的「信息沟通人邀请」站内提醒，避免孤儿提醒
    db.prepare('DELETE FROM reminders WHERE related_memo_project_id=?').run(project.id);
  });
  delProject();
  res.json({ message: '已删除项目', deletedId: project.id });
});

// 新增记录（author 由服务端盖章）
//   body: title(必填), location, scenario, content, photos[], attachments[], viewers[](用户id), status('draft'|'published')
router.post('/projects/:id/records', async (req, res) => {
  const u = req.user;
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '请填写标题' });
  const status = req.body.status === 'draft' ? 'draft' : 'published';
  const content = String(req.body.content || '').trim();
  const location = String(req.body.location || '').trim();
  const scenario = String(req.body.scenario || '').trim();
  const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments.filter(a => a && a.url) : [];
  const viewers = Array.isArray(req.body.viewers) ? req.body.viewers.map(Number).filter(Boolean) : [];
  const invitees = Array.isArray(req.body.invitees) ? req.body.invitees.map(Number).filter(Boolean) : [];
  // 发布必须有实质内容（标题 + 文字/图片/文件 任一）
  if (status === 'published' && !content && !photos.length && !attachments.length) {
    return res.status(400).json({ error: '发布需至少填写重点信息或上传图片/文件' });
  }
  const publishedAt = status === 'published' ? "datetime('now')" : null;
  const info = db.prepare(
    `INSERT INTO project_memos (project_id, author_id, author_name, title, location, scenario, content, photos, attachments, viewers, status, published_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,${publishedAt ? publishedAt : 'NULL'})`
  ).run(project.id, u.id, u.realName, title, location, scenario, content, JSON.stringify(photos), JSON.stringify(attachments), JSON.stringify(viewers), status);
  const rec = db.prepare('SELECT * FROM project_memos WHERE id=?').get(info.lastInsertRowid);
  // 记录人自动成为项目参与人；被邀请的新人也加入成员表（驱动可见性：成员可看项目全部记录）
  const insMember = db.prepare('INSERT OR IGNORE INTO project_memo_members (project_id, user_id, invited_by, joined_at) VALUES (?,?,?,datetime(\'now\'))');
  insMember.run(project.id, u.id, u.id);
  for (const iid of invitees) { if (iid && iid !== u.id) insMember.run(project.id, iid, u.id); }
  // 发布时归档 IMA（best-effort，草稿不归档；失败由 imaReconcile 兜底补推）
  if (status === 'published') {
    try {
      const newFid = await ensureProjectMemoFolder(project);
      const rr = await ima.pushMemo(rec, project, newFid);
      if (rr && rr.media_id) {
        db.prepare('UPDATE project_memos SET ima_media_id=?, ima_url=?, ima_folder_id=? WHERE id=?')
          .run(rr.media_id, rr.url || '', rr.folderId || '', rec.id);
        rec.ima_media_id = rr.media_id; rec.ima_url = rr.url || '';
      }
    } catch (e) { console.error('[项目备忘] IMA 推送失败（已记录，待对账补推）：', e && e.message); }
  }
  rec.photos = photos; rec.attachments = attachments; rec.viewers = viewers;
  res.json({ record: rec });
});

// 信息回复/追加：在「信息沟通人都可见」的已发布记录下，任何人（自己或他人）可追加一层回复。
// 回复继承原记录的额外共享人（viewers），使同一可见范围内的成员都能看到这条回复，串起楼中楼。
// 回复仅入库（不推送 IMA，避免配额消耗与父子归档歧义）；始终是已发布状态，无草稿概念。
router.post('/records/:id/reply', (req, res) => {
  const u = req.user;
  const parent = db.prepare('SELECT * FROM project_memos WHERE id=?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: '原记录不存在' });
  if (parent.status !== 'published') return res.status(400).json({ error: '仅已发布的记录可回复' });
  // 可见性：当前用户必须能看见原记录，才允许回复（与「信息沟通人都可见的记录」一致）
  const memberIds = new Set(db.prepare('SELECT user_id FROM project_memo_members WHERE project_id=?').all(parent.project_id).map(x => x.user_id));
  const oversight = rbac.isOversight(u);
  const canSee = parent.author_id === u.id || memberIds.has(u.id) || safeJson(parent.viewers).includes(u.id) || oversight;
  if (!canSee) return res.status(403).json({ error: '你无权回复该记录' });
  const content = String(req.body.content || '').trim();
  const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : [];
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments.filter(a => a && a.url) : [];
  if (!content && !photos.length && !attachments.length) {
    return res.status(400).json({ error: '请填写回复内容或上传图片/文件' });
  }
  // 继承原记录的额外共享人，串起楼中楼可见性
  const viewers = safeJson(parent.viewers);
  const info = db.prepare(
    `INSERT INTO project_memos (project_id, author_id, author_name, title, location, scenario, content, photos, attachments, viewers, status, published_at, parent_id)
     VALUES (?,?,?, '', '', '', ?, ?, ?, ?, 'published', datetime('now'), ?)`
  ).run(parent.project_id, u.id, u.realName, content, JSON.stringify(photos), JSON.stringify(attachments), JSON.stringify(viewers), parent.id);
  const rec = db.prepare('SELECT * FROM project_memos WHERE id=?').get(info.lastInsertRowid);
  rec.photos = photos; rec.attachments = attachments; rec.viewers = viewers; rec.parent_id = parent.id;
  res.json({ record: rec });
});

// 编辑记录（仅作者本人；草稿→发布 时补 published_at 并推 IMA；已发布编辑不重推，避免 IMA 重复副本）
router.put('/records/:id', async (req, res) => {
  const u = req.user;
  const rec = db.prepare('SELECT * FROM project_memos WHERE id=?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: '记录不存在' });
  if (rec.status === 'published') return res.status(403).json({ error: '已发布备忘不可修改，如需更正请另起一条' });
  if (rec.author_id !== u.id) return res.status(403).json({ error: '仅记录人本人可编辑（专总/超级管理员仅可见，不可改）' });
  const title = req.body.title != null ? String(req.body.title).trim() : rec.title;
  if (!title) return res.status(400).json({ error: '请填写标题' });
  const content = req.body.content != null ? String(req.body.content).trim() : rec.content;
  const location = req.body.location != null ? String(req.body.location).trim() : rec.location;
  const scenario = req.body.scenario != null ? String(req.body.scenario).trim() : rec.scenario;
  const photos = Array.isArray(req.body.photos) ? req.body.photos.filter(Boolean) : safeJson(rec.photos);
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments.filter(a => a && a.url) : safeJson(rec.attachments);
  const viewers = Array.isArray(req.body.viewers) ? req.body.viewers.map(Number).filter(Boolean) : safeJson(rec.viewers);
  const newStatus = req.body.status === 'draft' ? 'draft' : 'published';
  const wasDraft = rec.status === 'draft';
  const becomingPublished = wasDraft && newStatus === 'published';

  let publishedAtClause = 'published_at';
  const params = [title, location, scenario, content, JSON.stringify(photos), JSON.stringify(attachments), JSON.stringify(viewers), newStatus];
  if (becomingPublished) { publishedAtClause = "datetime('now')"; }
  params.push(rec.id);
  db.prepare(
    `UPDATE project_memos SET title=?, location=?, scenario=?, content=?, photos=?, attachments=?, viewers=?, status=?, published_at=${publishedAtClause}, updated_at=datetime('now') WHERE id=?`
  ).run(...params);

  const out = db.prepare('SELECT * FROM project_memos WHERE id=?').get(rec.id);
  if (becomingPublished) {
    try {
      const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(out.project_id) || {};
      const newFid = await ensureProjectMemoFolder(project);
      const rr = await ima.pushMemo(out, project, newFid);
      if (rr && rr.media_id) {
        db.prepare('UPDATE project_memos SET ima_media_id=?, ima_url=?, ima_folder_id=? WHERE id=?')
          .run(rr.media_id, rr.url || '', rr.folderId || '', out.id);
        out.ima_media_id = rr.media_id;
      }
    } catch (e) { console.error('[项目备忘] IMA 推送失败（已记录，待对账补推）：', e && e.message); }
  }
  out.photos = safeJson(out.photos); out.attachments = safeJson(out.attachments); out.viewers = safeJson(out.viewers);
  res.json({ record: out });
});

// 删除记录（仅超级管理员可删：集中管控，杜绝他人误删 / 抹除项目历史；草稿/发布均可删；作者本人亦不可删，需由超级管理员处理）
// 递归删除：连同该记录下的全部层级「信息回复/追加」一并清除，避免遗留孤儿回复。
router.delete('/records/:id', (req, res) => {
  const u = req.user;
  const rec = db.prepare('SELECT * FROM project_memos WHERE id=?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: '记录不存在' });
  if (!rbac.isSuperAdmin(u)) return res.status(403).json({ error: '仅超级管理员可删除项目信息传递' });
  const ids = collectMemoDescendantIds(rec.id);
  const delRec = db.prepare('DELETE FROM project_memos WHERE id=?');
  const tx = db.transaction(() => { for (const id of ids) delRec.run(id); });
  tx();
  res.json({ message: '已删除', deleted: ids.length });
});

// 一键转为「发现问题」：项目组任意成员（可见该记录者）均可转；不再直接进「解决问题」，而是写入「发现问题」草稿箱，
// 草稿归属「转换人本人」（确保他能打开并补充），是否推进到解决问题由转换人自行决定。原备忘保持不变。
router.post('/records/:id/convert-to-problem', (req, res) => {
  const u = req.user;
  const rec = db.prepare('SELECT * FROM project_memos WHERE id=?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: '记录不存在' });
  if (rec.status !== 'published') return res.status(400).json({ error: '仅已发布的备忘可转为发现问题' });
  // 可见性：与「信息沟通人都可见的记录」一致——作者本人 / 项目成员 / 额外共享人 / 监督人(超级管理员) 均可转。
  const memberIds = new Set(db.prepare('SELECT user_id FROM project_memo_members WHERE project_id=?').all(rec.project_id).map(x => x.user_id));
  const oversight = rbac.isOversight(u);
  const canSee = rec.author_id === u.id || memberIds.has(u.id) || safeJson(rec.viewers).includes(u.id) || oversight;
  if (!canSee) return res.status(403).json({ error: '你无权转换该记录（仅项目组内可见成员可转）' });
  const project = db.prepare('SELECT * FROM project_memo_projects WHERE id=?').get(rec.project_id) || {};
  const parts = [];
  if (rec.content) parts.push(rec.content);
  if (rec.location) parts.push('地点：' + rec.location);
  if (rec.scenario) parts.push('场景：' + rec.scenario);
  const description = parts.join('\n') || '（无内容）';
  let photos = [];
  try { photos = JSON.parse(rec.photos || '[]'); if (!Array.isArray(photos)) photos = []; } catch (e) {}
  let attachments = [];
  try { attachments = JSON.parse(rec.attachments || '[]'); if (!Array.isArray(attachments)) attachments = []; } catch (e) {}
  const title = rec.title || '（无标题项目信息传递）';
  // 写入「发现问题」草稿箱（user_id/user_name=转换人本人，确保只有他能打开这条草稿并跟进；原记录人不受影响）
  const info = db.prepare(
    `INSERT INTO pdca_drafts (user_id, user_name, title, description, urgency, photos, category, division, region, sub_division, divisions, sub_divisions, attachments, saved_at)
     VALUES (?,?,?,?, 'normal', ?, '标准规范', '', ?, '', '[]', '[]', ?, CURRENT_TIMESTAMP)`
  ).run(u.id, u.realName, title, description, JSON.stringify(photos), (project.region || ''), JSON.stringify(attachments));
  res.json({ draftId: info.lastInsertRowid, message: '已转入你本人的「发现问题」草稿箱，请补充后自行决定是否入库' });
});

module.exports = router;
