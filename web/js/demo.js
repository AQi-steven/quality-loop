/**
 * DEMO 模式 - 内存模拟数据与请求处理
 *
 * 用于无后端时的完整功能演示。数据存在内存+localStorage，刷新保留。
 * 真实部署时 window.DEMO_MODE=false，走真实 API。
 */

const DEMO = (() => {
  const KEY = 'qc_demo_db';

  function seed() {
    return {
      users: [
        { id: 1, username: 'admin', password: 'ChangeMe123!', real_name: '陈静', role: 'leader', title_tag: '副院长', department: '管理部', must_change_pwd: 0, is_active: 1 },
        { id: 2, username: 'user2', password: 'ChangeMe123!', real_name: '冯远', role: 'admin', title_tag: '专总', department: '建筑室', must_change_pwd: 0, is_active: 1 },
        { id: 3, username: 'user3', password: 'ChangeMe123!', real_name: '黄山', role: 'admin', title_tag: '室主任', department: '暖通室', must_change_pwd: 0, is_active: 1 },
        { id: 4, username: 'user4', password: 'ChangeMe123!', real_name: '周涛', role: 'designer', title_tag: '', department: '建筑室', must_change_pwd: 0, is_active: 1 },
        { id: 5, username: 'user5', password: 'ChangeMe123!', real_name: '吴昊', role: 'designer', title_tag: '', department: '结构室', must_change_pwd: 1, is_active: 1 },
      ],
      goals: [
        { id: 1, title: '2026年施工图差错率控制在0.5‰以内', content: '各专业室强化两级校审，卷册出图前必须完成校对、审核、审定三级签字。重点关注提资会签的完整性。', category: '年度目标', period: '2026全年', status: 'active', priority: 2, published_by: '陈静', published_at: '2026-06-01 09:00' },
        { id: 2, title: '7月质量月活动：现场问题随手拍', content: '鼓励全员在项目现场发现质量问题随手拍照上报，月底评选"金眼睛奖"。', category: '质量月', period: '2026-07', status: 'active', priority: 1, published_by: '冯远', published_at: '2026-07-01 10:30' },
      ],
      issues: [
        { id: 1, ticket_no: 'QC20260710001', project_name: '某城市绿建咨询项目', volume_code: 'JN-JZ-01', volume_name: '建筑总说明', volume_owner: '周涛', reporter: '周涛', issue_type: '图纸表达及成品显示', severity: 'high', description: '总平面图指北针方向与消防登高面标注冲突，现场核对后发现图纸方向标错。', status: 'assigned', assigned_to: '冯远', resolved_note: '', created_at: '2026-07-10 14:20' },
        { id: 2, ticket_no: 'QC20260712001', project_name: '桂林站BIPV项目', volume_code: 'GL-DQ-03', volume_name: '光伏配电系统图', volume_owner: '吴昊', reporter: '吴昊', issue_type: '提资会签', severity: 'normal', description: '暖通提资的屋面设备荷载未在结构图中体现，需补充会签。', status: 'submitted', assigned_to: '', created_at: '2026-07-12 09:15' },
        { id: 3, ticket_no: 'QC20260708001', project_name: '某城市绿建咨询项目', volume_code: 'JN-NT-02', volume_name: '空调水系统图', volume_owner: '黄山', reporter: '周涛', issue_type: '设计深度及完整度', severity: 'normal', description: '冷冻水管管径未标注，末端设备接管做法缺大样。', status: 'closed', assigned_to: '黄山', resolved_note: '已补充管径标注及接管大样，重新出图。', resolved_by: '黄山', closed_by: '陈静', created_at: '2026-07-08 11:00' },
      ],
      photos: {
        1: ['https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=400&q=60'],
        3: ['https://images.unsplash.com/photo-1541888946425-d81bb19240f5?w=400&q=60'],
      },
      logs: {
        QC20260710001: [
          { action: '上报', from_status: null, to_status: 'submitted', operator: '周涛', comment: '总平面图指北针方向标错', created_at: '2026-07-10 14:20' },
          { action: '分配', from_status: 'submitted', to_status: 'assigned', operator: '陈静', comment: '分配给 冯远 核实', created_at: '2026-07-10 15:05' },
        ],
        QC20260712001: [
          { action: '上报', from_status: null, to_status: 'submitted', operator: '吴昊', comment: '屋面设备荷载未会签', created_at: '2026-07-12 09:15' },
        ],
        QC20260708001: [
          { action: '上报', from_status: null, to_status: 'submitted', operator: '周涛', comment: '冷冻水管管径未标注', created_at: '2026-07-08 11:00' },
          { action: '分配', from_status: 'submitted', to_status: 'assigned', operator: '冯远', comment: '分配给 黄山', created_at: '2026-07-08 13:30' },
          { action: '开始处理', from_status: 'assigned', to_status: 'processing', operator: '黄山', comment: '', created_at: '2026-07-08 14:00' },
          { action: '提交处理结果', from_status: 'processing', to_status: 'resolved', operator: '黄山', comment: '已补充管径标注及接管大样', created_at: '2026-07-09 10:20' },
          { action: '验证关闭', from_status: 'resolved', to_status: 'closed', operator: '陈静', comment: '验证通过', created_at: '2026-07-09 16:00' },
        ],
      },
      ideas: [
        { id: 1, author: '周涛', category: '工艺改进', title: '建立标准详图库', content: '把常用的节点大样、标准做法整理成图块库，新人直接调用，减少低级错误。', likes: 8, status: 'adopted', adopted_by: '陈静', created_at: '2026-07-05 10:00', liked: false },
        { id: 2, author: '吴昊', category: '流程优化', title: '提资会签线上化', content: '各专业提资在这个APP里走线上流程，谁提的、谁签的、什么时候签的全程留痕，避免扯皮。', likes: 12, status: 'active', created_at: '2026-07-06 15:30', liked: true },
        { id: 3, author: '黄山', category: '经验分享', title: '出图前自检清单', content: '每个专业整理一份出图前自检清单（图框、比例、标注、会签、分级），出图前逐项打勾。', likes: 5, status: 'active', created_at: '2026-07-08 09:00', liked: false },
      ],
      seq: { issue: 4, idea: 4, goal: 3, user: 6, pdca: 4, memo: 1 },
      schedule: buildSchedule(),
      experts: [
        { id: 1, name: '赵雷', title: '原设总', department: '小型基建' },
        { id: 2, name: '孙琳', title: '设总', department: '建筑' },
        { id: 3, name: '陈静', title: '副院长', department: '质量管理部门' },
        { id: 4, name: '钱进', title: '主任工程师', department: '结构' },
        { id: 5, name: '贺明', title: '专总', department: '暖通' },
      ],
      announcements: [
        { id: 1, title: '欢迎使用质量千里行', content: '这里是院质量管理的统一入口：PDCA 跟踪现场质量问题，质量工作里记录个人备忘与查看项目工期。', publisher: '陈静', created_at: '2026-07-01 09:00' },
        { id: 2, title: '7月质量月活动启动', content: '本月开展「现场问题随手拍」，月底评选「金眼睛奖」，欢迎踊跃上报。', publisher: '冯远', created_at: '2026-07-05 10:00' },
      ],
      memo_entries: [
        { id: 1, user_id: 4, user_name: '周涛', title: '周五前交校审', content: '济南项目总图校审退回修改', reminder_time: '2026-07-20T09:00', reminded: 0, created_at: '2026-07-12 09:00' },
      ],
      pdca: [
        { id: 1, code: 'PDCA20260710-001', title: '济南项目总图指北针方向标错', description: '总平面图指北针与消防登高面标注冲突，现场核对后确认方向标反。', urgency: 'urgent', source: 'personal', reporter: '周涛', owner: '周涛', status: 'solving', memo: '待冯远复核对图', created_at: '2026-07-10 14:20' },
        { id: 2, code: 'PDCA20260712-001', title: '桂林项目屋面荷载未会签', description: '暖通提资的屋面设备荷载未在结构图中体现。', urgency: 'normal', source: 'dept', reporter: '陈静', owner: '吴昊', status: 'found', memo: '', created_at: '2026-07-12 09:15' },
        { id: 3, code: 'PDCA20260708-001', title: '冷冻水管管径未标注', description: '末端设备接管做法缺大样。', urgency: 'normal', source: 'personal', reporter: '周涛', owner: '黄山', status: 'reviewed', memo: '', created_at: '2026-07-08 11:00' },
      ],
      pdca_photos: { 1: ['https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=400&q=60'] },
      pdca_solutions: [
        { id: 1, problem_id: 1, content: '已联系冯远重新核对总图指北针，按消防审核意见更正方向。', experts: '冯远,孙琳', created_by: '周涛', created_at: '2026-07-11 10:00' },
      ],
      pdca_consults: [
        { id: 1, problem_id: 1, round: 1, question: '指北针方向以哪个为准？', question_by: '周涛', answer: '以总平面定位坐标为准，已更正。', answer_by: '冯远', created_at: '2026-07-11 14:00' },
      ],
      pdca_reviews: {
        3: { id: 1, problem_id: 3, content: '已补充管径标注及接管大样，出图前加入自检清单。', is_reminder: 0, reminder_at: '', is_renrenjiang: 1 },
      },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    } catch (e) {}
    const s = seed();
    save(s);
    return s;
  }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  let db = load();

  // 重置演示数据
  function reset() { db = seed(); save(db); }

  // 项目工期演示数据（建筑专业若干设计师的里程碑）
  function mk(id, owner, project, stage, type, loc, date, est, note, mgr) {
    const [, mm, dd] = date.split('-');
    const md = `${+mm}.${+dd}`;
    return {
      id, owner_name: owner, source_file: '', seq: id, manager: mgr || '',
      project_name: project, design_stage: stage, project_type: type, feature: '',
      location: loc, work_ratio: '100%', outsourced: '否', remark: '', adjust_coeff: '1.0',
      milestone_week: '', milestone_date: date, milestone_raw: est ? '暂估' + md : md,
      is_estimated: est ? 1 : 0, milestone_note: note || '', created_at: '2026-06-01 00:00',
    };
  }
  function buildSchedule() {
    return [
      mk(1, '周涛', '某城市绿建咨询项目', '施工图', '110新建', '济南', '2026-03-15', false, '', '陈静'),
      mk(2, '周涛', '某城市绿建咨询项目', '竣工图', '110新建', '济南', '2026-08-10', false, '', '陈静'),
      mk(3, '周涛', '某山地光伏项目', '方案', '新能源', '桂林', '2026-04-01', false, '', '赵雷'),
      mk(4, '周涛', '某山地光伏项目', '施工图', '新能源', '桂林', '2026-09-15', true, '初版', '赵雷'),
      mk(5, '吴昊', '某市区改造项目', '投标', '110新建', '上海', '2026-02-28', false, '', '孙琳'),
      mk(6, '吴昊', '某市区改造项目', '初设', '110新建', '上海', '2026-06-05', false, '', '孙琳'),
      mk(7, '吴昊', '某市区改造项目', '施工图', '110新建', '上海', '2026-07-30', false, '', '孙琳'),
      mk(8, '吴昊', '某港区风电储能项目', '方案', '新能源', '上海', '2026-10-20', true, '', '赵雷'),
      mk(9, '冯远', '院标准图集修编', '校审', '标准化', '上海', '2026-05-10', false, '', '冯远'),
      mk(10, '冯远', '院标准图集修编', '发布', '标准化', '上海', '2026-07-18', false, '', '冯远'),
      mk(11, '冯远', '某产业园区零碳规划', '方案', '咨询', '外地', '2026-11-30', true, '暂估', '陈静'),
      mk(12, '郑爽', '某高原光伏升压站', '初设', '新能源', '青海', '2026-06-25', false, '', '赵雷'),
      mk(13, '郑爽', '某高原光伏升压站', '施工图', '新能源', '青海', '2026-08-22', false, '', '赵雷'),
      mk(14, '郑爽', '某农光互补项目', '可研', '新能源', '西藏', '2026-12-10', true, '暂估', '赵雷'),
    ];
  }

  let currentUser = null;

  const ISSUE_TYPES = ['设计深度及完整度', '提资会签', '图纸表达及成品显示', '图纸分级', '卷册图纸命名', '校审要点', '图框及信息是否准确', '其他'];
  const IDEA_CATS = ['工艺改进', '流程优化', '工具建议', '经验分享', '其他'];

  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function genTicketNo() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const prefix = `QC${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`;
    const cnt = db.issues.filter(i => i.ticket_no.startsWith(prefix)).length;
    return prefix + String(cnt+1).padStart(3, '0');
  }
  function decodeToken(t) { return db.users.find(u => 'demo-token-' + u.id === t); }

  async function handle(method, path, body) {
    await new Promise(r => setTimeout(r, 150)); // 模拟网络延迟
    const token = API.getToken();
    if (token) currentUser = decodeToken(token);
    const p = path.split('?')[0];
    const qs = new URLSearchParams(path.split('?')[1] || '');

    // ── 认证 ──
    if (p === '/api/auth/login' && method === 'POST') {
      const u = db.users.find(x => x.username === body.username && x.is_active);
      if (!u || u.password !== body.password) throw new Error('用户名或密码错误');
      return { token: 'demo-token-' + u.id, mustChangePwd: !!u.must_change_pwd, user: pubUser(u) };
    }
    if (p === '/api/auth/me' && method === 'GET') {
      if (!currentUser) throw new Error('未登录');
      return { ...pubUser(currentUser), mustChangePwd: !!currentUser.must_change_pwd };
    }
    if (p === '/api/auth/change-pwd' && method === 'POST') {
      if (currentUser.password !== body.oldPassword) throw new Error('旧密码错误');
      currentUser.password = body.newPassword; currentUser.must_change_pwd = 0; save(db);
      return { message: '密码修改成功' };
    }

    // ── 目标 ──
    if (p === '/api/goals' && method === 'GET') {
      const status = qs.get('status') || 'active';
      return db.goals.filter(g => status === 'all' || g.status === status)
        .sort((a,b) => b.priority - a.priority);
    }
    if (p === '/api/goals' && method === 'POST') {
      requireAdmin();
      const g = { id: db.seq.goal++, ...body, status: 'active', published_by: currentUser.real_name, published_at: nowStr() };
      db.goals.unshift(g); save(db); return { id: g.id, message: '发布成功' };
    }

    // ── 问题/工单 ──
    if (p === '/api/issues' && method === 'GET') {
      let list = [...db.issues];
      if (qs.get('status')) list = list.filter(i => i.status === qs.get('status'));
      if (qs.get('mine') === '1') list = list.filter(i => i.reporter === currentUser.real_name);
      if (qs.get('assignedToMe') === '1') list = list.filter(i => i.assigned_to === currentUser.real_name);
      list.sort((a,b) => b.created_at.localeCompare(a.created_at));
      return list.map(i => ({ ...i, photoCount: (db.photos[i.id]||[]).length }));
    }
    if (p === '/api/issues' && method === 'POST') {
      const ticketNo = genTicketNo();
      const id = db.seq.issue++;
      const issue = { id, ticket_no: ticketNo, project_name: body.projectName||'', volume_code: body.volumeCode||'', volume_name: body.volumeName||'', volume_owner: body.volumeOwner||'', reporter: currentUser.real_name, issue_type: body.issueType, severity: body.severity||'normal', description: body.description, status: 'submitted', assigned_to: '', created_at: nowStr() };
      db.issues.unshift(issue);
      if (body.photos && body.photos.length) db.photos[id] = body.photos;
      db.logs[ticketNo] = [{ action: '上报', from_status: null, to_status: 'submitted', operator: currentUser.real_name, comment: body.description.slice(0,50), created_at: nowStr() }];
      save(db); return { id, ticketNo, message: '上报成功' };
    }
    const mIssue = p.match(/^\/api\/issues\/([\w]+)$/);
    if (mIssue && method === 'GET') {
      const issue = db.issues.find(i => i.ticket_no === mIssue[1]);
      if (!issue) throw new Error('工单不存在');
      return { ...issue, photos: (db.photos[issue.id]||[]).map((u,idx)=>({id:idx, photo_url:u})), logs: db.logs[issue.ticket_no]||[] };
    }

    // ── 工单流转 ──
    const mTicket = p.match(/^\/api\/tickets\/([\w]+)\/(\w+)$/);
    if (mTicket && (method === 'PUT' || method === 'POST')) {
      const [_, tno, action] = mTicket;
      const issue = db.issues.find(i => i.ticket_no === tno);
      if (!issue) throw new Error('工单不存在');
      const log = (act, to, comment) => { db.logs[tno] = db.logs[tno]||[]; db.logs[tno].push({ action: act, from_status: issue.status, to_status: to, operator: currentUser.real_name, comment: comment||'', created_at: nowStr() }); };

      if (action === 'assign') { requireAdmin(); log('分配','assigned',`分配给 ${body.assignedTo}`); issue.status='assigned'; issue.assigned_to=body.assignedTo; }
      else if (action === 'process') { log('开始处理','processing',body.comment); issue.status='processing'; }
      else if (action === 'resolve') { log('提交处理结果','resolved',body.resolvedNote); issue.status='resolved'; issue.resolved_note=body.resolvedNote; issue.resolved_by=currentUser.real_name; }
      else if (action === 'close') { requireAdmin(); log('验证关闭','closed',body.comment||'验证通过'); issue.status='closed'; issue.closed_by=currentUser.real_name; }
      else if (action === 'reject') { requireAdmin(); log('打回','assigned',body.comment); issue.status='assigned'; }
      else if (action === 'comment') { log('评论',issue.status,body.comment); }
      save(db); return { message: '操作成功' };
    }

    // ── 点子 ──
    if (p === '/api/ideas' && method === 'GET') {
      const sort = qs.get('sort') || 'time';
      let list = db.ideas.filter(i => i.status !== 'deleted');
      list.sort((a,b) => sort === 'likes' ? b.likes - a.likes : b.created_at.localeCompare(a.created_at));
      return list;
    }
    if (p === '/api/ideas' && method === 'POST') {
      const idea = { id: db.seq.idea++, author: currentUser.real_name, category: body.category||'经验分享', title: body.title, content: body.content, likes: 0, status: 'active', created_at: nowStr(), liked: false };
      db.ideas.unshift(idea); save(db); return { id: idea.id, message: '发布成功' };
    }
    const mLike = p.match(/^\/api\/ideas\/(\d+)\/like$/);
    if (mLike && method === 'POST') {
      const idea = db.ideas.find(i => i.id == mLike[1]);
      idea.liked = !idea.liked; idea.likes += idea.liked ? 1 : -1; save(db);
      return { liked: idea.liked, likes: idea.likes };
    }
    const mAdopt = p.match(/^\/api\/ideas\/(\d+)\/adopt$/);
    if (mAdopt && method === 'PUT') {
      requireAdmin();
      const idea = db.ideas.find(i => i.id == mAdopt[1]);
      idea.status = 'adopted'; idea.adopted_by = currentUser.real_name; save(db);
      return { message: '已标记采纳' };
    }

    // ── 管理员：用户管理 ──
    if (p === '/api/admin/users' && method === 'GET') {
      requireAdmin();
      return db.users.map(pubUser);
    }
    if (p === '/api/admin/users' && method === 'POST') {
      requireAdmin();
      const created = [], errors = [];
      for (const u of body.users) {
        if (db.users.find(x => x.username === u.username)) { errors.push({username:u.username, error:'用户名已存在'}); continue; }
        const nu = { id: db.seq.user++, username: u.username, password: 'ChangeMe123!', real_name: u.realName, role: u.role||'designer', title_tag: u.titleTag||'', department: u.department||'', must_change_pwd: 1, is_active: 1 };
        db.users.push(nu); created.push({ id: nu.id, username: nu.username, realName: nu.real_name });
      }
      save(db); return { created, errors, defaultPassword: 'ChangeMe123!' };
    }
    const mUserToggle = p.match(/^\/api\/admin\/users\/(\d+)\/toggle-active$/);
    if (mUserToggle && method === 'PUT') {
      requireAdmin();
      const u = db.users.find(x => x.id == mUserToggle[1]);
      u.is_active = u.is_active ? 0 : 1; save(db);
      return { message: u.is_active ? '已启用' : '已禁用', isActive: !!u.is_active };
    }
    const mUserReset = p.match(/^\/api\/admin\/users\/(\d+)\/reset-pwd$/);
    if (mUserReset && method === 'PUT') {
      requireAdmin();
      const u = db.users.find(x => x.id == mUserReset[1]);
      u.password = 'ChangeMe123!'; u.must_change_pwd = 1; save(db);
      return { message: '密码已重置', newPassword: 'ChangeMe123!' };
    }

    // ── 项目工期（演示：腾讯文档直达）──
    if (p === '/api/schedule/owners' && method === 'GET') {
      const OWNERS = ['张伟','王芳','刘强','陈静','赵雷','孙琳','周涛','吴昊','郑爽','冯远','褚健','卫东','林远','黄山','杨柳','秦明','尤文','许三'];
      const FIDS = ['feZmSlEGRRgm','fpXPRyvzwKTQ','fpThzuVxAEst','fLuXSYgKXGFG','fnzkzmwobYNs','fCbczNTViGVp','fhwclmVvcVwT','fqflGAWqbdmH','fdGXWndRYCon','fgCEHfcagAgj','fCXKLIMQFyPq','flNMgmGKRIzU','fMIYpBfwEGXG','fDmegTpeXIEY','fhWCJYyGKHdR','fnvFsKGqglVG','fBXkabqqxOkV','foGxXWENKnvZ'];
      return OWNERS.map((o, i) => ({ owner: o, fileId: FIDS[i], docUrl: `https://docs.qq.com/sheet/${FIDS[i]}` }));
    }

    // ── 公告（演示）──
    if (p === '/api/announcements' && method === 'GET') return db.announcements || [];

    // ── 个人备忘（演示：多条目）──
    if (p === '/api/memos' && method === 'GET') return db.memo_entries.filter(m => m.user_name === currentUser.real_name);
    if (p === '/api/memos' && method === 'POST') {
      const id = db.seq.memo++;
      const m = { id, user_id: currentUser.id, user_name: currentUser.real_name, title: body.title || '', content: body.content || '', reminder_time: body.reminder_time || '', reminded: 0, created_at: nowStr() };
      db.memo_entries.push(m); save(db); return { id, message: '已保存' };
    }
    const mMemo = p.match(/^\/api\/memos\/(\d+)$/);
    if (mMemo && method === 'PUT') {
      const m = db.memo_entries.find(x => x.id == mMemo[1] && x.user_name === currentUser.real_name);
      if (m) { m.title = body.title || ''; m.content = body.content || ''; m.reminder_time = body.reminder_time || ''; save(db); }
      return { message: '已更新' };
    }
    if (mMemo && method === 'DELETE') {
      db.memo_entries = db.memo_entries.filter(x => !(x.id == mMemo[1] && x.user_name === currentUser.real_name)); save(db); return { message: '已删除' };
    }
    const mMemoR = p.match(/^\/api\/memos\/(\d+)\/remind$/);
    if (mMemoR && method === 'PUT') {
      const m = db.memo_entries.find(x => x.id == mMemoR[1] && x.user_name === currentUser.real_name);
      if (m) { m.reminded = 1; save(db); }
      return { message: 'ok' };
    }

    // ── PDCA 质量改进闭环（演示）──
    function enrichPdca(x) {
      const photos = db.pdca_photos[x.id] || [];
      const sols = db.pdca_solutions.filter(s => s.problem_id === x.id);
      const cons = db.pdca_consults.filter(c => c.problem_id === x.id);
      const rev = db.pdca_reviews[x.id];
      return {
        ...x,
        photoCount: photos.length, solutionCount: sols.length, consultCount: cons.length,
        hasReview: !!rev, is_reminder: rev ? rev.is_reminder : 0, is_renrenjiang: rev ? rev.is_renrenjiang : 0,
        is_pending: x.is_pending !== 0 ? 1 : 0,
      };
    }
    if (p === '/api/pdca/experts' && method === 'GET') return db.experts;
    if (p === '/api/pdca/memo' && method === 'GET') return { content: (db.memos ? (db.memos[currentUser.real_name] || '') : '') };
    if (p === '/api/pdca/memo' && method === 'PUT') { db.memos = db.memos || {}; db.memos[currentUser.real_name] = body.content || ''; save(db); return { message: '已保存' }; }
    if (p === '/api/pdca/problems' && method === 'GET') {
      let list = [...db.pdca];
      const status = qs.get('status');
      if (status) list = list.filter(x => x.status === status);
      if (!App.caps.canManage) list = list.filter(x => x.reporter === currentUser.real_name);
      else if (qs.get('mine') === '1') list = list.filter(x => x.reporter === currentUser.real_name);
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return list.map(enrichPdca);
    }
    if (p === '/api/pdca/problems' && method === 'POST') {
      const id = db.seq.pdca++;
      const d = new Date(); const pfx = `PDCA${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
      const cnt = db.pdca.filter(x => x.code.startsWith(pfx)).length;
      const code = pfx + String(cnt + 1).padStart(3, '0');
      const np = { id, code, title: body.title, description: body.description, urgency: body.urgency === 'urgent' ? 'urgent' : 'normal', source: (body.source === 'dept' && App.caps.canManage) ? 'dept' : 'personal', reporter: currentUser.real_name, owner: currentUser.real_name, status: 'found', is_pending: body.is_pending ? 1 : 0, created_at: nowStr() };
      db.pdca.unshift(np);
      if (body.photos && body.photos.length) db.pdca_photos[id] = body.photos;
      save(db); return { id, message: '已记录' };
    }
    const mPdca = p.match(/^\/api\/pdca\/problems\/(\d+)$/);
    if (mPdca && method === 'GET') {
      const x = db.pdca.find(i => i.id == mPdca[1]);
      if (!x) throw new Error('问题不存在');
      return { ...enrichPdca(x), photos: (db.pdca_photos[x.id] || []).map((u, idx) => ({ id: idx, photo_url: u })), solutions: db.pdca_solutions.filter(s => s.problem_id === x.id), consults: db.pdca_consults.filter(c => c.problem_id === x.id), review: db.pdca_reviews[x.id] || null };
    }
    const mSol = p.match(/^\/api\/pdca\/problems\/(\d+)\/solution$/);
    if (mSol && method === 'POST') {
      const id = +mSol[1];
      db.pdca_solutions.push({ id: db.seq.pdca * 100 + db.pdca_solutions.length, problem_id: id, content: body.content, experts: (body.experts || []).join(','), created_by: currentUser.real_name, created_at: nowStr() });
      const x = db.pdca.find(i => i.id === id); if (x && x.status === 'found') x.status = 'solving';
      save(db); return { message: '方案已提交' };
    }
    const mCon = p.match(/^\/api\/pdca\/problems\/(\d+)\/consult$/);
    if (mCon && method === 'POST') {
      const id = +mCon[1];
      const round = db.pdca_consults.filter(c => c.problem_id === id).length + 1;
      db.pdca_consults.push({ id: db.seq.pdca * 100 + db.pdca_consults.length, problem_id: id, round, question: body.question, question_by: currentUser.real_name, answer: '', answer_by: '', created_at: nowStr() });
      save(db); return { message: '已追问' };
    }
    const mAns = p.match(/^\/api\/pdca\/problems\/(\d+)\/answer$/);
    if (mAns && method === 'POST') {
      const c = db.pdca_consults.find(c => c.id == body.consultId && c.problem_id == mAns[1]);
      if (!c) throw new Error('追问记录不存在');
      c.answer = body.answer; c.answer_by = currentUser.real_name; save(db); return { message: '已答复' };
    }
    const mRev = p.match(/^\/api\/pdca\/problems\/(\d+)\/resolve$/);
    if (mRev && method === 'POST') { const x = db.pdca.find(i => i.id == mRev[1]); if (!x) throw new Error('问题不存在'); x.status = 'solved'; save(db); return { message: '已标记解决' }; }
    const mRv = p.match(/^\/api\/pdca\/problems\/(\d+)\/review$/);
    if (mRv && method === 'POST') {
      const id = +mRv[1];
      db.pdca_reviews[id] = { id, problem_id: id, content: body.content || '', is_reminder: body.is_reminder ? 1 : 0, reminder_at: body.reminder_at || '', is_renrenjiang: body.is_renrenjiang ? 1 : 0, reminder_target: body.reminder_target || '' };
      const x = db.pdca.find(i => i.id === id); if (x) x.status = 'reviewed';
      save(db); return { message: '复盘已保存' };
    }
    const mClose = p.match(/^\/api\/pdca\/problems\/(\d+)\/close$/);
    if (mClose && method === 'PUT') { requireAdmin(); const x = db.pdca.find(i => i.id == mClose[1]); if (!x) throw new Error('问题不存在'); x.status = 'closed'; x.closed_by = currentUser.real_name; save(db); return { message: '已闭环' }; }

    throw new Error('DEMO未实现: ' + method + ' ' + p);
  }

  function pubUser(u) { return { id: u.id, username: u.username, realName: u.real_name, role: u.role, titleTag: u.title_tag, department: u.department, isActive: u.is_active, mustChangePwd: u.must_change_pwd }; }
  function requireAdmin() { if (!currentUser || (currentUser.role !== 'leader' && currentUser.role !== 'admin')) throw new Error('权限不足'); }

  return { handle, reset, ISSUE_TYPES, IDEA_CATS };
})();
