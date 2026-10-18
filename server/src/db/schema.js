/**
 * 数据库 schema（幂等建表 + 默认管理员种子）
 *
 * 抽离出来，供 connection.js 在连接时自动执行（服务器启动即建表，无需单独跑 init），
 * 也供 init.js / 部署脚本单独执行。
 *
 * 设计原则（呼应世界杯项目教训）：
 *   - 绝不 DELETE / UPDATE 改写历史，工单流转只追加 ticket_logs 记录
 *   - IF NOT EXISTS 保证可重复执行（升级时不会破坏旧数据）
 */

const bcrypt = require('bcryptjs');
const config = require('../config');

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role TEXT DEFAULT 'designer',
      title_tag TEXT DEFAULT '',
      department TEXT,
      phone TEXT,
      must_change_pwd INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      extra_roles TEXT DEFAULT '[]',
      division TEXT,
      last_login_at DATETIME,
      last_active_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_guest INTEGER DEFAULT 0,
      can_exam INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_real_name ON users(real_name);
    `);

    // 兼容旧库：补齐 last_active_at（取 last_login_at 历史值，重复执行安全）
    try {
      db.exec("UPDATE users SET last_active_at = last_login_at WHERE last_active_at IS NULL AND last_login_at IS NOT NULL");
    } catch (e) {}

    db.exec(`
    CREATE TABLE IF NOT EXISTS admin_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      department TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, department)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT UNIQUE NOT NULL,
      project_name TEXT,
      volume_code TEXT,
      volume_name TEXT,
      volume_owner TEXT,
      reporter TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      severity TEXT DEFAULT 'normal',
      description TEXT NOT NULL,
      status TEXT DEFAULT 'submitted',
      assigned_to TEXT,
      resolved_note TEXT,
      resolved_by TEXT,
      resolved_at DATETIME,
      closed_by TEXT,
      closed_at DATETIME,
      sync_status TEXT DEFAULT 'pending',
      sync_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_issues_ticket_no ON issues(ticket_no);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE INDEX IF NOT EXISTS idx_issues_reporter ON issues(reporter);
    CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_issues_sync ON issues(sync_status);

    CREATE TABLE IF NOT EXISTS issue_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      photo_url TEXT NOT NULL,
      tencent_doc_image_id TEXT,
      uploaded_to_doc INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_issue_photos_issue ON issue_photos(issue_id);

    CREATE TABLE IF NOT EXISTS ticket_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      operator TEXT NOT NULL,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_no) REFERENCES issues(ticket_no) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_logs_ticket ON ticket_logs(ticket_no);

    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      likes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      adopted_by TEXT,
      adopted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
    CREATE INDEX IF NOT EXISTS idx_ideas_author ON ideas(author);

    CREATE TABLE IF NOT EXISTS idea_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE,
      UNIQUE(idea_id, user_name)
    );
    CREATE INDEX IF NOT EXISTS idx_idea_likes_idea ON idea_likes(idea_id);

    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      last_sync_at DATETIME,
      last_sync_rows INTEGER,
      sync_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_status_doc ON sync_status(doc_id);

    CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_name TEXT NOT NULL,
      source_file TEXT,
      seq INTEGER,
      manager TEXT,
      project_name TEXT NOT NULL,
      design_stage TEXT,
      project_type TEXT,
      feature TEXT,
      location TEXT,
      work_ratio TEXT,
      outsourced TEXT,
      remark TEXT,
      adjust_coeff TEXT,
      milestone_week TEXT,
      milestone_date TEXT NOT NULL,
      milestone_raw TEXT,
      is_estimated INTEGER DEFAULT 0,
      milestone_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pt_owner ON project_tasks(owner_name);
    CREATE INDEX IF NOT EXISTS idx_pt_date ON project_tasks(milestone_date);
    CREATE INDEX IF NOT EXISTS idx_pt_project ON project_tasks(owner_name, project_name);

    -- ── 腾讯文档元数据缓存（项目工期「最后更新时间」展示）────
    -- 由已连接的腾讯文档通道（MCP）定时拉取真实修改时间后写入，
    -- GET /api/schedule/owners 关联返回，前端在「📄 腾讯文档」标志旁显示。
    -- 仅缓存展示字段，不快照文档内容；file_id 为 D 格式分享链接段。
    CREATE TABLE IF NOT EXISTS doc_meta (
      file_id TEXT PRIMARY KEY,
      title TEXT,
      last_modify_time INTEGER,
      last_modify_name TEXT,
      owner_name TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── PDCA 质量改进闭环 ────────────────────────
    CREATE TABLE IF NOT EXISTS pdca_problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      urgency TEXT DEFAULT 'normal',
      source TEXT DEFAULT 'personal',
      reporter TEXT NOT NULL,
      owner TEXT,
      status TEXT DEFAULT 'found',
      memo TEXT,
      closed_by TEXT,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_status ON pdca_problems(status);
    CREATE INDEX IF NOT EXISTS idx_pdca_reporter ON pdca_problems(reporter);
    CREATE INDEX IF NOT EXISTS idx_pdca_owner ON pdca_problems(owner);

    CREATE TABLE IF NOT EXISTS pdca_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL,
      photo_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_photos ON pdca_photos(problem_id);

    CREATE TABLE IF NOT EXISTS pdca_solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      experts TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pdca_consults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL,
      round INTEGER DEFAULT 1,
      question TEXT NOT NULL,
      question_by TEXT NOT NULL,
      answer TEXT,
      answer_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_consults ON pdca_consults(problem_id);

    CREATE TABLE IF NOT EXISTS pdca_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem_id INTEGER NOT NULL,
      content TEXT,
      is_reminder INTEGER DEFAULT 0,
      reminder_at TEXT,
      is_renrenjiang INTEGER DEFAULT 0,
      is_dept_renrenjiang INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );

    -- 专家答复：每位专家一条独立记录（一对多），避免多人回复互相覆盖
    CREATE TABLE IF NOT EXISTS pdca_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consult_id INTEGER NOT NULL,
      problem_id INTEGER NOT NULL,
      expert_name TEXT NOT NULL,
      answer TEXT NOT NULL,
      answer_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (consult_id) REFERENCES pdca_consults(id) ON DELETE CASCADE,
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_answers ON pdca_answers(problem_id, consult_id);

    -- 草稿箱：发现问题「存档」暂存，可随时继续或提交（提交即进入问题库；不选专家=仅自己记录，选专家=请教并推送）
    CREATE TABLE IF NOT EXISTS pdca_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name TEXT NOT NULL,
      title TEXT,
      description TEXT,
      urgency TEXT DEFAULT 'normal',
      photos TEXT DEFAULT '[]',
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_drafts_user ON pdca_drafts(user_name);

    CREATE TABLE IF NOT EXISTS pdca_experts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      title TEXT,
      department TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_experts_name ON pdca_experts(name);

    -- 提醒（PDCA 备忘传送 / 校审·提资·要点提醒）：从一人发往另一人，带处理状态
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL,
      recipient_id INTEGER NOT NULL,
      recipient_name TEXT NOT NULL,
      type TEXT DEFAULT '通用',
      title TEXT,
      content TEXT,
      state TEXT DEFAULT 'pending',
      due_time TEXT,
      related_problem_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      done_at DATETIME,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_recipient ON reminders(recipient_id, state);
    CREATE INDEX IF NOT EXISTS idx_reminders_sender ON reminders(sender_id);

    -- 公告（首页展示，由领导/专总/室主任在管理中心发布）
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      publisher TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 审计日志（关键动作留痕：闭环 / 院选 / 强制关闭 / 宣贯审核·驳回·删除 等）
    -- 仅追加，绝不 UPDATE / DELETE。
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      actor_role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

    -- 共议设计师关联表（PDCA 正规化：从 pdca_problems.consult_designers JSON 列解耦）
    -- 一行一设计师，主用途：related=1「与我相关」列表用 JOIN 精确匹配（取代 LIKE + JS 二次过滤，避免同名串扰）。
    CREATE TABLE IF NOT EXISTS pdca_consultants (
      problem_id INTEGER NOT NULL,
      designer TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (problem_id, designer),
      FOREIGN KEY (problem_id) REFERENCES pdca_problems(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pdca_consultants_designer ON pdca_consultants(designer);
  `);

  // 公告 scope 列（升级幂等补列，不破坏旧数据）
  try { db.exec("ALTER TABLE announcements ADD COLUMN scope TEXT DEFAULT 'all'"); } catch (e) {}
  try { db.exec('ALTER TABLE announcements ADD COLUMN division TEXT'); } catch (e) {}
  // 公告发布时间周期（公示期），与质量宣贯一致：到期自动归档（首页隐藏，质量库仍可见）
  try { db.exec('ALTER TABLE announcements ADD COLUMN publish_date TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE announcements ADD COLUMN expiry_date TEXT'); } catch (e) {}
  try { db.exec("ALTER TABLE announcements ADD COLUMN status TEXT DEFAULT 'active'"); } catch (e) {}
  // 置顶（2026-09-14）：pinned=1 的公告恒排列表第一位，且「覆盖公示期」——到期归档后仍显示在主页（仅超级管理员可置顶/取消）
  try { db.exec('ALTER TABLE announcements ADD COLUMN pinned INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE announcements ADD COLUMN pinned_at DATETIME'); } catch (e) {}

  // 已阅确认开关（2026-09）：公告/宣贯/PDCA 由"评论"改为"已阅"机制；
  //   发布人可关闭是否要求已阅确认（默认开 = 要求确认）。
  try { db.exec('ALTER TABLE announcements ADD COLUMN require_ack INTEGER DEFAULT 1'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN require_ack INTEGER DEFAULT 1'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN require_ack INTEGER DEFAULT 1'); } catch (e) {}

  // 质量宣贯（首页版块，到期自动进入「质量库」）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_dissem (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        publisher TEXT,
        publisher_id INTEGER,
        publisher_role TEXT,
        category TEXT DEFAULT '通用',
        divisions TEXT DEFAULT '[]',
        regions TEXT DEFAULT '[]',
        publish_date TEXT,
        expiry_date TEXT,
        status TEXT DEFAULT 'active',
        ima_media_id TEXT,
        ima_url TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS red_flowers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT,
      kind TEXT,
      ref_id INTEGER,
      ref_title TEXT,
      awarded_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch (e) {}
  // 红花奖惩（院长/系统管理员基于额外理由授予或减扣，专总/院长/管理员不参与）：delta 正=授予、负=减扣
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS flower_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_user_id INTEGER,
      target_name TEXT,
      operator_id INTEGER,
      operator_name TEXT,
      delta INTEGER,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch (e) {}
  // 月冠军结算：每月结束后，由 settle-month 写入该月「小红花月度领先者」（status 字段预留：settled=已结算）
  // month 格式 'YYYY-MM'（自然月，按服务器 localtime）；user_name 与 red_flowers.user_name 一致；flower_count 为该月月度小红花总数
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS month_champions (
      month TEXT PRIMARY KEY,
      user_name TEXT,
      flower_count INTEGER,
      settled_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'settled'
    );
  `); } catch (e) {}
  try { db.exec("ALTER TABLE pdca_problems ADD COLUMN category TEXT DEFAULT '标准规范'"); } catch (e) {}
  try { db.exec("ALTER TABLE pdca_drafts ADD COLUMN category TEXT DEFAULT '标准规范'"); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN division TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN region TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN division TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN region TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN reviewed_by TEXT'); } catch (e) {}
  // 管理者备注（室主任/专总/院长/超管 对设计师发布的宣贯帖加的批注）
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN manager_note TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN manager_note_by TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN manager_note_at TEXT'); } catch (e) {}

  // 月冠军表增加 type 列（month=月冠军 / bimonth=双月冠军），主键改为 (month, type)。
  // 目的：① 支持并列冠军（同一 month 可有多条）；② 允许「10 月月冠军」与「双月冠军」同月共存（同一人可累计 +2 朵👑）。
  try {
    const hasType = db.prepare("PRAGMA table_info(month_champions)").all().some(c => c.name === 'type');
    if (!hasType) {
      db.exec(`
        CREATE TABLE month_champions_new (
          month TEXT,
          user_name TEXT,
          flower_count INTEGER,
          settled_at TEXT DEFAULT (datetime('now')),
          status TEXT DEFAULT 'settled',
          type TEXT DEFAULT 'month',
          PRIMARY KEY (month, type)
        );
        INSERT OR IGNORE INTO month_champions_new (month, user_name, flower_count, settled_at, status, type)
          SELECT month, user_name, flower_count, settled_at, COALESCE(status,'settled'), 'month' FROM month_champions;
        DROP TABLE month_champions;
        ALTER TABLE month_champions_new RENAME TO month_champions;
      `);
    }
  } catch (e) { console.error('[migrate month_champions type]', e && e.message); }

  // IMA 同步状态表：记录最近一次同步成功/失败时间与错误，供主动监控与前端横幅展示
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS ima_sync_status (
      id INTEGER PRIMARY KEY CHECK (id=1),
      status TEXT,
      last_success_at TEXT,
      last_check_at TEXT,
      last_error TEXT
    );
  `); } catch (e) {}

  // 注：原「质量宣贯示例」自动播种已移除（2026-07-23，用户要求正式试用前清空所有演示数据，不自动补回）。

  // 种子：质量专家库（请教专家用，可后续在管理后台扩充）
  const expertCount = db.prepare('SELECT COUNT(*) c FROM pdca_experts').get().c;
  if (expertCount === 0) {
    const seedExperts = [
      ['张伟', '总工程师', '工程管理部'],
      ['王芳', '室主任', '建筑设计'],
      ['刘强', '专总', '结构'],
      ['陈静', '副院长', '质量管理部'],
      ['赵雷', '主任工程师', '暖通'],
    ];
    const ins = db.prepare('INSERT INTO pdca_experts (name, title, department) VALUES (?, ?, ?)');
    for (const [name, title, dept] of seedExperts) ins.run(name, title, dept);
  }

  // 默认管理员账号（首次启动创建，初始密码 ChangeMe123!，强制首次改密）
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!existing) {
    const hash = bcrypt.hashSync(config.password.defaultPassword, config.password.bcryptRounds);
    db.prepare(`
      INSERT INTO users (username, password_hash, real_name, role, title_tag, department, must_change_pwd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('admin', hash, '系统管理员', 'leader', '', '管理部', 1);
  }

  // 升级兼容：给已有表补列（重复执行时列已存在会抛错，吞掉即可）
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN is_pending INTEGER DEFAULT 1'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN consult_experts TEXT'); } catch (e) {}
  // 管理者备注（室主任/专总/院长/超管 对设计师发布且已院选的人人讲帖加的批注）
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN manager_note TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN manager_note_by TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN manager_note_at TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_reviews ADD COLUMN reminder_target TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_reviews ADD COLUMN is_dept_renrenjiang INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN extra_roles TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN division TEXT'); } catch (e) {}
  // 微信提醒绑定（Server酱 / ServerChan）：用户粘贴的 SendKey，免扫码、免 App，通道稳。空表示未绑定。
  try { db.exec('ALTER TABLE users ADD COLUMN serverchan_key TEXT'); } catch (e) {}
  // 游客账户（GUEST1/GUEST2/GUEST3 等）：免密登录、纯只读、按设计师视图展示、不出现在管理类列表
  try { db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0'); } catch (e) {}
  // 可考试游客（EXAMGUEST1~EXAMGUEST9）：在「纯只读」基础上，额外放行检验池考试的 3 个考生写接口
  // （start / draft / submit）。其余任何写操作仍一律 403；仍按 is_guest 排除在评价/红花/奖金统计之外。
  try { db.exec('ALTER TABLE users ADD COLUMN can_exam INTEGER DEFAULT 0'); } catch (e) {}

  // 游客账户种子（必须在 is_guest 列补齐之后，否则既有库会报"no column named is_guest"）
  // ⚠️ 用户名统一小写（guest1/guest2/guest3/guest9），避免登录时大小写不匹配。
  // 游客一律纯只读（后端 auth 中间件对非 GET 一律 403 兜底；前端所有写按钮按 isGuest 隐藏）。
  // 各游客「视野」按角色/专业/双身份派生（与真实示例账号一致）：
  //   guest1 = 设计师全视野（designer / 建筑）
  //   guest2 = 室主任全视野（section_leader / 建筑）
  //   guest3 = 专总视野（chief + section_leader；不看评价 tab）
  //   guest9 = 院领导全视野（dean + expert；不写登录页，隐藏审计账户）
  // 既有游客库：每次启动强制刷新 role/division/extra_roles/real_name，使视野与最新配置一致（幂等安全）。
  const guestSeed = [
    { u: 'guest1', n: 'GUEST1', role: 'designer', division: '建筑', extra: '[]', canExam: 0 },
    { u: 'guest2', n: 'GUEST2', role: 'section_leader', division: '建筑', extra: '[]', canExam: 0 },
    { u: 'guest3', n: 'GUEST3', role: 'chief', division: '水工', extra: '["section_leader"]', canExam: 0 },
    { u: 'guest9', n: 'GUEST9', role: 'dean', division: null, extra: '["expert"]', canExam: 0 },
  ];
  // EXAMGUEST1~EXAMGUEST9：可考试的只读游客（设计师视野）。用途＝演示/测试：能参加「检验池」考试、看排名；
  // 除考试外纯只读（发布/评论/PDCA/红花等写入一律 403）；仍按 is_guest 排除在评价/红花/奖金统计之外。
  for (let i = 1; i <= 9; i++) {
    guestSeed.push({ u: 'ls' + i, n: 'LS' + i, role: 'designer', division: '建筑', extra: '[]', canExam: 1 });
  }
  for (const g of guestSeed) {
    // 大小写不敏感匹配既有游客（兼容旧库大写 GUEST1/GUEST2/GUEST3）
    const ex = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(g.u);
    const ce = g.canExam ? 1 : 0;
    if (!ex) {
      db.prepare(`
        INSERT INTO users (username, password_hash, real_name, role, division, extra_roles, must_change_pwd, is_guest, can_exam)
        VALUES (?, '', ?, ?, ?, ?, 0, 1, ?)
      `).run(g.u, g.n, g.role, g.division, g.extra, ce);
    } else {
      // 兼容既有库：强制刷新用户名/真实姓名/角色/专业/双身份/游客标记/可考试标记（确保视野与最新配置一致）
      db.prepare('UPDATE users SET real_name = ?, username = ?, role = ?, division = ?, extra_roles = ?, is_guest = 1, can_exam = ? WHERE id = ?')
        .run(g.n, g.u, g.role, g.division, g.extra, ce, ex.id);
    }
  }
  // 附件（公告 / 宣贯 / 人人讲 上传的文档等，JSON 数组 [{url,name}]）
  try { db.exec('ALTER TABLE announcements ADD COLUMN attachments TEXT'); } catch (e) {}
  // 公告是否已成功同步到 IMA（发布时写入，供前端展示「已同步IMA」徽标）
  try { db.exec('ALTER TABLE announcements ADD COLUMN ima_synced INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN attachments TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN attachments TEXT'); } catch (e) {}
  // 宣贯「审核通过时间」（2026-09-23 需求）：质量库排序与展示统一取"最后一环批准时刻"。
  //   设计师发布 → 审核通过时写入本列；专总/室主任/院长直发（免审）→ 本列为 NULL，
  //   排序/展示兜底取 created_at（即"发布即生效"的发布时刻）。
  //   历史上（2026-09-23 之前）的设计师宣贯，由一次性脚本从 audit_log(dissem_approve) 回溯回填。
  //   口径与 created_at 一致（UTC，CURRENT_TIMESTAMP），便于与 audit_log 直接比对。
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN reviewed_at TEXT'); } catch (e) {}
  // 专家 / 共议设计师 答复可附带照片与文件（JSON 数组 [{url,name}]）
  try { db.exec('ALTER TABLE pdca_answers ADD COLUMN attachments TEXT'); } catch (e) {}
  // 图片（公告 / 宣贯 单独上传的图片，JSON 数组 [{url,name}]，详情页直接以 <img> 展示）
  try { db.exec("ALTER TABLE announcements ADD COLUMN photos TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE quality_dissem ADD COLUMN photos TEXT DEFAULT '[]'"); } catch (e) {}
  // PDCA 已同步 IMA 的媒体 id（幂等防重复推送）
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN ima_media_id TEXT'); } catch (e) {}
  // 共议机制：区分专家答复(expert)与设计师共议(designer)；记录被邀请共议的设计师名单
  try { db.exec("ALTER TABLE pdca_answers ADD COLUMN role TEXT DEFAULT 'expert'"); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN consult_designers TEXT'); } catch (e) {}
  // IMA 子文件夹 id（多条目聚合时建的子文件夹，幂等复用，避免重复建文件夹）
  try { db.exec('ALTER TABLE announcements ADD COLUMN ima_folder_id TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN ima_folder_id TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN ima_folder_id TEXT'); } catch (e) {}
  // 二级专业分类（仅作内容标签；可见性仍按一级专业）：
  //   宣贯可打多个二级标签（JSON 数组，复合键 "暖通/空调"）；问题/人人讲为单标签（复合键）
  try { db.exec('ALTER TABLE quality_dissem ADD COLUMN sub_divisions TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN sub_division TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN sub_division TEXT'); } catch (e) {}
  // PDCA 问题 / 草稿 多专业数组列（与宣贯一致：一级 divisions + 二级 sub_divisions）
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN divisions TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN sub_divisions TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN divisions TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN sub_divisions TEXT'); } catch (e) {}
  // 草稿箱附件（与 pdca_problems.attachments 对齐）：存草稿→重开草稿→提交 不丢附件
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN attachments TEXT'); } catch (e) {}
  // 人人讲「院选」（专总/院长精选）：首页人人讲版块来源 + 小红花 3 朵
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN rrj_selected INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN rrj_selected_by TEXT'); } catch (e) {}
  // 复盘阶段管理者备注（管理者在设计师/上报人复盘时可补充的批注，区别于院选后的 manager_note）
  try { db.exec('ALTER TABLE pdca_reviews ADD COLUMN manager_remark TEXT'); } catch (e) {}
  // 院选后再推送 IMA「03千里行质量人人讲院选」的媒体 id（幂等防重复）
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN ima_selected_media_id TEXT'); } catch (e) {}
  // 小红花金额：一朵=1；宣贯通过记 3 朵 / 人人讲院选记 3 朵 / 普通 PDCA 闭环记 2 朵
  try { db.exec('ALTER TABLE red_flowers ADD COLUMN amount INTEGER DEFAULT 1'); } catch (e) {}
  // 公告发布者身份（供「编辑已发布内容」权限判定：院长改全部、专总/室主任改自己+设计师发的）
  try { db.exec('ALTER TABLE announcements ADD COLUMN publisher_id INTEGER'); } catch (e) {}
  try { db.exec("ALTER TABLE announcements ADD COLUMN publisher_role TEXT"); } catch (e) {}
  // 提醒：发送人/接收人各自可隐藏自己这侧（软删），互不影响对方视角
  try { db.exec('ALTER TABLE reminders ADD COLUMN sender_deleted INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE reminders ADD COLUMN recipient_deleted INTEGER DEFAULT 0'); } catch (e) {}
  // 提醒关联「项目备忘」：被邀请加入信息沟通人时，记录所关联的项目（及可选的具体记录），
  // 用于个人中心「项目备忘提醒」收件箱 → 一键跳回原帖。
  try { db.exec('ALTER TABLE reminders ADD COLUMN related_memo_project_id INTEGER'); } catch (e) {}
  try { db.exec('ALTER TABLE reminders ADD COLUMN related_memo_record_id INTEGER'); } catch (e) {}
  // 修订 #2：PDCA 草稿/问题改用 user_id 隔离（取代不稳定的 real_name 隔离，避免改名/重名串扰）。
  //   pdca_drafts.user_id / pdca_problems.reporter_user_id 落库，旧数据按 real_name 回填；查询与权限判定优先用 id，id 缺失时回退到 real_name。
  try { db.exec('ALTER TABLE pdca_drafts ADD COLUMN user_id INTEGER'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN reporter_user_id INTEGER'); } catch (e) {}
  try { db.exec('UPDATE pdca_drafts SET user_id = (SELECT id FROM users WHERE users.real_name = pdca_drafts.user_name) WHERE user_id IS NULL'); } catch (e) {}
  try { db.exec('UPDATE pdca_problems SET reporter_user_id = (SELECT id FROM users WHERE users.real_name = pdca_problems.reporter) WHERE reporter_user_id IS NULL'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pdca_drafts_user_id ON pdca_drafts(user_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pdca_problems_reporter_user_id ON pdca_problems(reporter_user_id)'); } catch (e) {}
  // PDCA 答复支持「楼中楼」回复：parent_id 指向被回复的答复；自己可删自己的发言，但被回复后（有子回复）不可删
  try { db.exec('ALTER TABLE pdca_answers ADD COLUMN parent_id INTEGER'); } catch (e) {}
  // 人人讲「院选」：管理者（专总/院长）对候选可标记「不选」，该条从待选栏目消失
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN rrj_rejected INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE pdca_problems ADD COLUMN rrj_rejected_by TEXT'); } catch (e) {}
  // 旧公告按发布者真实姓名回填发布者身份（一次性的数据补齐；匹配不到则留空，由院长统一可改）
  try {
    db.exec(`UPDATE announcements SET publisher_id = (SELECT id FROM users WHERE users.real_name = announcements.publisher LIMIT 1) WHERE publisher_id IS NULL AND COALESCE(publisher,'') != ''`);
    db.exec(`UPDATE announcements SET publisher_role = (SELECT role FROM users WHERE users.real_name = announcements.publisher LIMIT 1) WHERE publisher_role IS NULL AND publisher_id IS NOT NULL`);
  } catch (e) {}

  // 草稿箱补齐「请教专家 / 邀请设计师」持久化列：跨设备（服务端存储）回显需要（修复#2：草稿丢专家/设计师）
  try { db.exec("ALTER TABLE pdca_drafts ADD COLUMN experts TEXT DEFAULT '[]'"); } catch (e) {}
  try { db.exec("ALTER TABLE pdca_drafts ADD COLUMN designers TEXT DEFAULT '[]'"); } catch (e) {}

  // ── 数据规范化（幂等，每次启动执行）──────────────
  // 专业室 → 专业：去掉所有"室"字，使筛选 / 发布维度统一为"专业"
  const _stripShi = (col, tbl) => {
    try {
      // 短路：仅当确有未规范化的行时才写，避免每次启动无谓的全表 UPDATE（写放大）
      const n = db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE ${col} LIKE '%室'`).get().c;
      if (n > 0) db.exec(`UPDATE ${tbl} SET ${col} = REPLACE(${col},'室','') WHERE ${col} LIKE '%室'`);
    } catch (e) {}
  };
  _stripShi('division', 'users');
  _stripShi('division', 'announcements');
  _stripShi('division', 'pdca_problems');
  _stripShi('division', 'pdca_drafts');
  _stripShi('region', 'pdca_problems');
  _stripShi('region', 'pdca_drafts');
  // quality_dissem.divisions 为 JSON 数组，逐行去"室"
  try {
    const rows = db.prepare("SELECT id, divisions FROM quality_dissem WHERE divisions LIKE '%室%'").all();
    const upd = db.prepare('UPDATE quality_dissem SET divisions=? WHERE id=?');
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.divisions);
        if (!Array.isArray(arr)) continue;
        upd.run(JSON.stringify(arr.map(d => (typeof d === 'string' ? d.replace(/室$/, '') : d))), r.id);
      } catch (e) {}
    }
  } catch (e) {}
  // 分类重命名（技术规范→标准规范，质量宣贯→质量要求）
  try { db.exec("UPDATE quality_dissem SET category='标准规范' WHERE category='技术规范'"); } catch (e) {}
  try { db.exec("UPDATE quality_dissem SET category='质量要求' WHERE category='质量宣贯'"); } catch (e) {}
  try { db.exec("UPDATE pdca_problems SET category='标准规范' WHERE category='技术规范'"); } catch (e) {}
  try { db.exec("UPDATE pdca_drafts SET category='标准规范' WHERE category='技术规范'"); } catch (e) {}
  // PDCA 问题「五种类型」第五类更名：质量人人讲→质量问答（避免与首页大「质量人人讲」版块混淆；仅改类型名，不动人人讲版块/院选/IMA）
  try { db.exec("UPDATE pdca_problems SET category='质量问答' WHERE category='质量人人讲'"); } catch (e) {}
  try { db.exec("UPDATE pdca_drafts SET category='质量问答' WHERE category='质量人人讲'"); } catch (e) {}

  // PDCA 问题 / 草稿：旧单值 division/sub_division 并入新数组列（幂等，仅对空值执行）
  try {
    const migrate = (table) => {
      const rows = db.prepare(`SELECT id, division, sub_division FROM ${table} WHERE divisions IS NULL OR divisions='' OR sub_divisions IS NULL OR sub_divisions=''`).all();
      const up = db.prepare(`UPDATE ${table} SET divisions=?, sub_divisions=? WHERE id=?`);
      for (const r of rows) {
        const d = (r.division || '').trim();
        const s = (r.sub_division || '').trim();
        up.run(d ? JSON.stringify([d]) : '[]', s ? JSON.stringify([s]) : '[]', r.id);
      }
    };
    try { migrate('pdca_problems'); } catch (e) { console.error('[migrate pdca_problems divisions]', e && e.message); }
    try { migrate('pdca_drafts'); } catch (e) { console.error('[migrate pdca_drafts divisions]', e && e.message); }
  } catch (e) { console.error('[migrate pdca divisions]', e && e.message); }

  // 登录流水（记录每次登录时间，供院长查"最近一周登录动态"；仅追加，绝不 UPDATE/DELETE）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        real_name TEXT,
        login_at DATETIME,
        ip TEXT DEFAULT ''
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_login_log_user ON login_log(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_login_log_at ON login_log(login_at)');
    // 一次性补齐：把历史 last_login_at 作为首条登录流水（仅当该用户尚无登录流水记录时；重复执行安全，不会重复补）
    db.exec(`
      INSERT INTO login_log (user_id, username, real_name, login_at)
      SELECT id, username, real_name, last_login_at FROM users
      WHERE last_login_at IS NOT NULL AND last_login_at != ''
        AND id NOT IN (SELECT user_id FROM login_log)
    `);
  } catch (e) {}

  // ── 项目备忘（📝项目备忘子应用，2026-08-01 新增；纯增量，不影响既有表）────────────
  // 2026-08-01 重构：去掉「类别」(type)，改为结构化记录（标题/地点/场景/重点信息/图片/文件），
  //   新增 草稿(draft)/发布(published) 状态、可见人(viewers)，并支持「参与人自动互看 + 专总/超级管理员强制可见」。
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_memo_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        code TEXT DEFAULT '',
        region TEXT DEFAULT '',
        opened_by INTEGER,
        opened_by_name TEXT DEFAULT '',
        opened_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    `);
    // project_memos：幂等迁移——旧表带 type 列则改名重建；全新库则直接建新表；已是新表则跳过。
    const memoCols = (() => { try { return db.prepare("PRAGMA table_info(project_memos)").all().map(c => c.name); } catch (e) { return []; } })();
    if (memoCols.length === 0) {
      db.exec(`
        CREATE TABLE project_memos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_memo_projects(id),
          author_id INTEGER,
          author_name TEXT DEFAULT '',
          title TEXT DEFAULT '',
          location TEXT DEFAULT '',
          scenario TEXT DEFAULT '',
          content TEXT DEFAULT '',
          photos TEXT DEFAULT '[]',
          attachments TEXT DEFAULT '[]',
          viewers TEXT DEFAULT '[]',
          status TEXT DEFAULT 'published' CHECK (status IN ('draft','published')),
          published_at DATETIME,
          ima_media_id TEXT DEFAULT '',
          ima_url TEXT DEFAULT '',
          ima_folder_id TEXT DEFAULT '',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now'))
        );
      `);
    } else if (!memoCols.includes('title')) {
      // 旧 type 版 → 新结构化版（保留既有记录，title 留空、published_at 取 created_at、草稿不存在）
      db.exec("ALTER TABLE project_memos RENAME TO _project_memos_old");
      db.exec(`
        CREATE TABLE project_memos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project_memo_projects(id),
          author_id INTEGER,
          author_name TEXT DEFAULT '',
          title TEXT DEFAULT '',
          location TEXT DEFAULT '',
          scenario TEXT DEFAULT '',
          content TEXT DEFAULT '',
          photos TEXT DEFAULT '[]',
          attachments TEXT DEFAULT '[]',
          viewers TEXT DEFAULT '[]',
          status TEXT DEFAULT 'published' CHECK (status IN ('draft','published')),
          published_at DATETIME,
          ima_media_id TEXT DEFAULT '',
          ima_url TEXT DEFAULT '',
          ima_folder_id TEXT DEFAULT '',
          created_at DATETIME DEFAULT (datetime('now')),
          updated_at DATETIME DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        INSERT INTO project_memos (id, project_id, author_id, author_name, location, scenario, content, photos, attachments, status, published_at, ima_media_id, ima_url, ima_folder_id, created_at, updated_at)
        SELECT id, project_id, author_id, author_name, location, scenario, content, photos, attachments, 'published', COALESCE(created_at, datetime('now')), ima_media_id, ima_url, ima_folder_id, created_at, datetime('now')
        FROM _project_memos_old;
      `);
      db.exec("DROP TABLE _project_memos_old");
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_pmm_project ON project_memos(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pmm_author ON project_memos(author_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pmm_created ON project_memos(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pmm_status ON project_memos(status)');
    // 项目参与人（显式成员表，驱动可见性与可参与性；2026-08-02 重构新增，取代「按发布记录人自动互看」）
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_memo_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES project_memo_projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        invited_by INTEGER,
        joined_at DATETIME,
        UNIQUE(project_id, user_id)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pmm_member ON project_memo_members(project_id, user_id)');
    // ── 2026-08-02 项目备忘 IMA 改造：每个项目在 SHARE-知识库 KB 根目录按「项目名」自动建文件夹 ──
    // 单路径：已发布备忘的 docx+附件+图片平铺进该项目文件夹（ima_media_id/ima_url/ima_folder_id）。
    // ima_new_folder_id 存该项目文件夹 id；ima2_* 为废弃的「双库并行」残留列（指向已删除的新库），不再使用。
    try { db.exec("ALTER TABLE project_memo_projects ADD COLUMN ima_new_folder_id TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE project_memos ADD COLUMN ima2_media_id TEXT DEFAULT ''"); } catch (e) {}
    try { db.exec("ALTER TABLE project_memos ADD COLUMN ima2_url TEXT DEFAULT ''"); } catch (e) {}
    // 2026-08-06 项目信息传递：支持「信息回复/追加」楼中楼线程 —— parent_id 指向原记录（顶层记录为 NULL）
    try { db.exec("ALTER TABLE project_memos ADD COLUMN parent_id INTEGER DEFAULT NULL"); } catch (e) {}
    // 2026-08-06 PDCA 拟设解决方案/做法：支持图片（拍摄）与文件附件
    try { db.exec("ALTER TABLE pdca_solutions ADD COLUMN photos TEXT DEFAULT '[]'"); } catch (e) {}
    try { db.exec("ALTER TABLE pdca_solutions ADD COLUMN attachments TEXT DEFAULT '[]'"); } catch (e) {}
    // 增量回填：把既有项目（开立人 + 所有已发布记录作者）补为成员，保证历史可见性不丢（幂等：UNIQUE + INSERT OR IGNORE）
    db.exec(`
      INSERT OR IGNORE INTO project_memo_members (project_id, user_id, invited_by, joined_at)
      SELECT p.id, p.opened_by, p.opened_by, COALESCE(p.opened_at, datetime('now'))
      FROM project_memo_projects p WHERE p.opened_by IS NOT NULL;
    `);
    db.exec(`
      INSERT OR IGNORE INTO project_memo_members (project_id, user_id, invited_by, joined_at)
      SELECT m.project_id, m.author_id, m.author_id, COALESCE(m.published_at, m.created_at)
      FROM project_memos m WHERE m.status='published' AND m.author_id IS NOT NULL;
    `);
  } catch (e) {}

  // ── 质量专题（主题主页 + 阶段动态 + 已发布内容关联，2026-10 新增）────────────
  // 只保存公告/宣贯/PDCA 的引用，不复制原文；所有建表与索引均幂等。
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT DEFAULT '',
        title TEXT NOT NULL,
        summary TEXT DEFAULT '',
        cover TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived','deleted')),
        owner_id INTEGER,
        owner_name TEXT DEFAULT '',
        scope TEXT DEFAULT 'all',
        divisions TEXT DEFAULT '[]',
        require_ack INTEGER DEFAULT 0,
        publish_date DATE,
        expiry_date DATE,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_quality_topics_status ON quality_topics(status);
      CREATE INDEX IF NOT EXISTS idx_quality_topics_owner ON quality_topics(owner_id);
      CREATE INDEX IF NOT EXISTS idx_quality_topics_updated ON quality_topics(updated_at);
      CREATE TABLE IF NOT EXISTS quality_topic_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL REFERENCES quality_topics(id) ON DELETE CASCADE,
        title TEXT DEFAULT '',
        content TEXT DEFAULT '',
        post_type TEXT DEFAULT '阶段进展',
        photos TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        author_id INTEGER,
        author_name TEXT DEFAULT '',
        is_pinned INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','deleted')),
        published_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_quality_topic_posts_topic ON quality_topic_posts(topic_id, status, is_pinned, published_at);
      CREATE INDEX IF NOT EXISTS idx_quality_topic_posts_author ON quality_topic_posts(author_id);
      CREATE TABLE IF NOT EXISTS quality_topic_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL REFERENCES quality_topics(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('announcement','dissem','pdca','flower')),
        target_id INTEGER NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_required INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(topic_id, target_type, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_quality_topic_items_topic ON quality_topic_items(topic_id, sort_order, id);
    `);
  } catch (e) { console.error('[migrate quality topics]', e && e.message); }

  // 质量专题 2026-10-11 增量：target_type 增加 'flower'（引用「红花奖惩台账」）。
  // 建表语句里的 CHECK 只对「新建表」生效；线上已有表仍是旧的
  // CHECK(target_type IN ('announcement','dissem','pdca'))，写入 flower 会被数据库拒绝 → 500。
  // 故这里做幂等迁移：仅当检测到旧 CHECK 不含 flower 时才重建表并搬运原数据。
  try {
    const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quality_topic_items'").get();
    if (sqlRow && !/'flower'\s*\)/.test(String(sqlRow.sql || ''))) {
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec('BEGIN');
      db.exec(`CREATE TABLE quality_topic_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL REFERENCES quality_topics(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('announcement','dissem','pdca','flower')),
        target_id INTEGER NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_required INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(topic_id, target_type, target_id)
      )`);
      db.exec('INSERT INTO quality_topic_items_new (id,topic_id,target_type,target_id,sort_order,is_required,created_by,created_at) SELECT id,topic_id,target_type,target_id,sort_order,is_required,created_by,created_at FROM quality_topic_items');
      db.exec('DROP TABLE quality_topic_items');
      db.exec('ALTER TABLE quality_topic_items_new RENAME TO quality_topic_items');
      db.exec('CREATE INDEX IF NOT EXISTS idx_quality_topic_items_topic ON quality_topic_items(topic_id, sort_order, id)');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON');
      console.log('[migrate quality topics] target_type 增加 flower，关联表已重建');
    }
  } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) {} console.error('[migrate topic_items flower]', e && e.message); }

  // 质量专题 2026-10-10 增量：主题色、专题置顶（幂等，列已存在则跳过）。
  try { db.exec("ALTER TABLE quality_topics ADD COLUMN color TEXT DEFAULT ''"); } catch (e) {}
  try { db.exec('ALTER TABLE quality_topics ADD COLUMN pinned INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE quality_topics ADD COLUMN pinned_at DATETIME'); } catch (e) {}

  // ── 检验池（出图考试：对千里行质量库文档的自动出题 / 批改 / 得分 / 排名）────────────
  // 2026-08-01 新增；纯增量，不影响既有表。
  //   exam_questions : 预建题库（从 IMA「000千里行质量库」内容出题，按专业打标；is_dissem=宣贯内容加权）
  //   exam_rounds    : 一场考试（任取范围即时组卷 10 题，snapsnot 存「规范顺序题目 + 正确答案」供批改）
  //   exam_attempts  : 某人某场的作答（key_secret 存每人独立的 ABCD 乱序，防作弊；答案密钥不下发前端）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS exam_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discipline TEXT NOT NULL,
        source TEXT DEFAULT '',
        stem TEXT NOT NULL,
        options TEXT NOT NULL,
        answer_index INTEGER NOT NULL,
        explanation TEXT DEFAULT '',
        is_dissem INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_exam_q_discipline ON exam_questions(discipline);

      CREATE TABLE IF NOT EXISTS exam_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        scope TEXT NOT NULL,
        question_ids TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        created_by INTEGER,
        created_by_name TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_exam_rounds_created ON exam_rounds(created_at);

      CREATE TABLE IF NOT EXISTS exam_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT DEFAULT '',
        answers TEXT,
        score INTEGER DEFAULT 0,
        correct_count INTEGER DEFAULT 0,
        key_secret TEXT,
        status TEXT DEFAULT 'in_progress',
        duration_ms INTEGER,
        created_at DATETIME DEFAULT (datetime('now')),
        submitted_at DATETIME,
        FOREIGN KEY (round_id) REFERENCES exam_rounds(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_exam_attempt_round ON exam_attempts(round_id);
      CREATE INDEX IF NOT EXISTS idx_exam_attempt_user ON exam_attempts(user_id);

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        real_name TEXT,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id);

      -- 已阅确认（2026-09）：取代"评论"。任意登录用户可点"已阅"，系统记录人名；
      --   专业帖额外展示该专业未阅名单。唯一约束防重复点击（幂等）。
      CREATE TABLE IF NOT EXISTS read_acks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        real_name TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(target_type, target_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_read_acks_target ON read_acks(target_type, target_id);
    `);
  } catch (e) {}

  // 考试答卷唯一约束（每人每场仅一条，防重复作答）：先去重保留最新，再建唯一索引（幂等，每次启动执行安全）
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_attempt_unique ON exam_attempts(round_id, user_id)');
  } catch (e) {
    try {
      db.exec('DELETE FROM exam_attempts WHERE id NOT IN (SELECT MAX(id) FROM exam_attempts GROUP BY round_id, user_id)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_attempt_unique ON exam_attempts(round_id, user_id)');
    } catch (e2) { console.error('[migrate exam_attempts unique]', e2 && e2.message); }
  }

  // 检验池考试结算锁：原 flowers_awarded 更名为 settled（语义更清晰：仅作「已结算锁定」标记）；
  // 原 flower_reward 列已废弃（前端从不发送该值，恒为 0），存在则删除。
  // 幂等、每次启动安全：老版本 SQLite 不支持 RENAME COLUMN 时回退为 ADD settled。
  try {
    const rcols = db.prepare("PRAGMA table_info(exam_rounds)").all().map(c => c.name);
    if (rcols.includes('flowers_awarded')) {
      try { db.exec('ALTER TABLE exam_rounds RENAME COLUMN flowers_awarded TO settled'); }
      catch (e) { if (!rcols.includes('settled')) db.exec('ALTER TABLE exam_rounds ADD COLUMN settled INTEGER DEFAULT 0'); }
    } else if (!rcols.includes('settled')) {
      db.exec('ALTER TABLE exam_rounds ADD COLUMN settled INTEGER DEFAULT 0');
    }
    if (rcols.includes('flower_reward')) db.exec('ALTER TABLE exam_rounds DROP COLUMN flower_reward');
  } catch (e) { console.error('[migrate exam_rounds settle]', e && e.message); }

  // 2026-10-11 质量库问答（Phase 1）：FTS5 全文索引，trigram 分词支持中文子串。
  // 内容与重建逻辑见 src/qa_index.js；检索见 src/routes/qa.js。
  // 注：虚拟表 CREATE IF NOT EXISTS 幂等；若 SQLite 缺 FTS5 仅告警不阻断启动（问答接口自会报错）。
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS qa_fts USING fts5(kind, ref_id UNINDEXED, title, body, author UNINDEXED, route UNINDEXED, updated_at UNINDEXED, tokenize='trigram')");
  } catch (e) { console.error('[migrate qa_fts]', e && e.message); }

  // 2026-10-12 全局轻量设置表（键值对）：目前仅 qa_ai_enabled（库问答 AI 开关，仅超级管理员可改）。
  try {
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  } catch (e) { console.error('[migrate app_settings]', e && e.message); }

  // 注：原「默认公告」自动播种已移除（2026-07-23，用户要求正式试用前清空所有演示数据，不自动补回）。

  // 废弃"评论"功能（2026-09）：公告/宣贯/PDCA 的评论改为"已阅"机制，原评论数据不再需要。
  // 先清空历史评论（已阅机制取代），再删表；路由已改为 /api/read-acks（见 readAcks.js），此处删表安全。
  try { db.exec('DELETE FROM comments'); } catch (e) {}
  try { db.exec('DROP TABLE IF EXISTS comments'); } catch (e) {}
}

module.exports = { createSchema };
