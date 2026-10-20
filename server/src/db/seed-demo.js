/**
 * 演示种子数据（开源版「clone 即能跑」专用）
 *
 * 设计目标：
 *   - 开源仓库裸 clone 后，跑一次本脚本即可看到完整可交互的演示（公告 / 质量宣贯 /
 *     人人讲 PDCA / 检验池例题 / 多角色账号）。
 *   - 所有演示数据均带「演示」前缀或明确标注，绝不与真实业务数据混淆；内容均为
 *     通用工程质量知识，不含任何本院真实人员 / 项目 / 题目。
 *
 * 重要约定（呼应铁律）：
 *   - 本脚本【绝不】在生产库运行（生产库由 institute.config.js 指向真实数据，部署流程
 *     不调用本脚本）。它只服务于开源演示 / 本地自测。
 *   - 本院 270 道真实题目、真实人员名单 一律不进开源包（见 seed-exam-*.js，已排除）。
 *
 * 幂等性：
 *   - 用户：用 username UNIQUE 做 INSERT OR IGNORE，重复运行不会创建重复账号。
 *   - 内容（公告/宣贯/人人讲/例题）：插入前按「标题」存在性判定，已存在则跳过，
 *     绝不删除任何既有数据（保证对真实库零破坏）。
 *
 * 用法：
 *   cd server
 *   node --experimental-sqlite src/db/seed-demo.js
 * 或（项目根）：
 *   node --experimental-sqlite server/src/db/seed-demo.js
 */

const bcrypt = require('bcryptjs');
const config = require('../config');
// 引入连接即自动建表（createSchema 幂等）并创建 admin / 游客 种子。
const db = require('./connection');

const DEMO_TAG = '【演示】';

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────────────────────────────────────
// 1) 演示账号（多角色，便于体验不同权限视野）
// ───────────────────────────────────────────────────────────
const hash = bcrypt.hashSync(config.password.defaultPassword, config.password.bcryptRounds);

// username, real_name, role, division, extra_roles
const demoUsers = [
  ['demo.dean',     '演示院长',   'dean',          null,     '["expert"]'],
  ['demo.chief',    '演示专总',   'chief',         '水工',   '["section_leader"]'],
  ['demo.section',  '演示室主任', 'section_leader', '建筑',   '[]'],
  ['demo.designer', '演示设计师', 'designer',      '暖通',   '[]'],
  ['demo.designer2','演示设计师2','designer',      '通信',   '[]'],
];

let usersAdded = 0;
const insUser = db.prepare(`
  INSERT OR IGNORE INTO users
    (username, password_hash, real_name, role, division, extra_roles, must_change_pwd, is_active)
  VALUES (?, ?, ?, ?, ?, ?, 0, 1)
`);
for (const [u, n, role, div, extra] of demoUsers) {
  const r = insUser.run(u, hash, n, role, div, extra);
  if (r.changes > 0) usersAdded++;
}

// ───────────────────────────────────────────────────────────
// 2) 演示公告（首页展示，require_ack=0 降低演示干扰）
// ───────────────────────────────────────────────────────────
let announcementsAdded = 0;
const insAnn = db.prepare(`
  INSERT INTO announcements (title, content, publisher, scope, status, require_ack, publish_date, expiry_date)
  VALUES (?, ?, ?, 'all', 'active', 0, ?, ?)
`);
const demoAnnouncements = [
  [
    DEMO_TAG + '欢迎使用质量千里行',
    '这是一个开源演示实例。本平台覆盖「质量公告 / 质量宣贯 / 人人讲 PDCA / 检验池 / 小红花」等模块，' +
    '支持按专业、地区、角色分级管理。请用上方演示账号登录，体验不同角色的视野与权限。',
    '演示院长',
  ],
  [
    DEMO_TAG + '关于组织开展季度质量自查的通知',
    '各专业人员请于本季度内完成在编图纸与计算书的质量自查，并在「人人讲」模块提交至少一项发现的问题及闭环方案。' +
    '专总与室主任可在管理中枢查看本专业待处理事项。',
    '演示专总',
  ],
];
for (const [title, content, publisher] of demoAnnouncements) {
  const ex = db.prepare('SELECT id FROM announcements WHERE title = ?').get(title);
  if (!ex) {
    insAnn.run(title, content, publisher, daysFromNow(-1), daysFromNow(90));
    announcementsAdded++;
  }
}

// ───────────────────────────────────────────────────────────
// 3) 演示质量宣贯（首页版块，到期自动进入质量库）
// ───────────────────────────────────────────────────────────
let dissemAdded = 0;
const insDissem = db.prepare(`
  INSERT INTO quality_dissem
    (title, content, publisher, publisher_role, category, divisions, regions, status, require_ack, publish_date, expiry_date)
  VALUES (?, ?, ?, 'chief', '通用', ?, '[]', 'active', 0, ?, ?)
`);
const demoDissem = [
  [
    DEMO_TAG + '施工图设计文件深度常见短板解析',
    '结合近年校审发现，施工图常见短板集中在：①节点详图深度不足；②设备参数与系统图不一致；' +
    '③节能专篇与建筑专业提资脱节。建议各专业在提资阶段即锁定接口边界，减少后期返工。',
    '演示专总',
  ],
  [
    DEMO_TAG + '质量通病防治要点（水工篇）',
    '水工专业质量通病以「管道碰撞」「支吊架遗漏」「化水车间防腐蚀做法缺失」为主。' +
    '设计时应优先采用标准化支吊架图集，并在模型阶段完成碰撞检查。',
    '演示室主任',
  ],
];
for (const [title, content, publisher] of demoDissem) {
  const ex = db.prepare('SELECT id FROM quality_dissem WHERE title = ?').get(title);
  if (!ex) {
    insDissem.run(title, content, publisher, JSON.stringify(['水工', '建筑', '暖通', '通信']), daysFromNow(-2), daysFromNow(90));
    dissemAdded++;
  }
}

// ───────────────────────────────────────────────────────────
// 4) 演示人人讲 PDCA（发现问题 → 解决 → 闭环）
// ───────────────────────────────────────────────────────────
let pdcaAdded = 0;
const insPdca = db.prepare(`
  INSERT INTO pdca_problems (code, title, description, urgency, source, reporter, owner, status, require_ack)
  VALUES (?, ?, ?, 'normal', 'personal', ?, ?, 'solving', 0)
`);
const insPdcaSolution = db.prepare(`
  INSERT INTO pdca_solutions (problem_id, content, created_by) VALUES (?, ?, ?)
`);
const demoPdca = [
  [
    'DEMO-2026-001',
    DEMO_TAG + '某变电站暖通机房管线排布混乱',
    '现场反馈暖通机房内风管与水管交叉未预留检修空间，导致运维困难。建议在后续设计中引入' +
    'BIM 管线综合，并在图纸中明确检修通道净宽。',
    '演示设计师',
    '演示室主任',
    '已组织专业内讨论，采用 BIM 管线综合后重新出图；后续同类机房设计统一执行检修通道净宽≥800mm 的约定。',
  ],
  [
    'DEMO-2026-002',
    DEMO_TAG + '通信机房接地端子标识缺失',
    '竣工图与现场不一致，部分接地端子未标识编号，不利于运维排查。建议将接地端子编号纳入' +
    '图纸强制表达项。',
    '演示设计师2',
    '演示专总',
    '已在通信专业制图规定中补充「接地端子编号」强制表达要求，并在校审要点中增加对应检查项。',
  ],
];
for (const [code, title, desc, reporter, owner, solution] of demoPdca) {
  const ex = db.prepare('SELECT id FROM pdca_problems WHERE code = ?').get(code);
  if (!ex) {
    const r = insPdca.run(code, title, desc, reporter, owner);
    const pid = r.lastInsertRowid;
    insPdcaSolution.run(pid, solution, owner);
    pdcaAdded++;
  }
}

// ───────────────────────────────────────────────────────────
// 5) 演示检验池例题（通用工程质量知识，无 dissem_id，不含任何真实题目）
// ───────────────────────────────────────────────────────────
let examAdded = 0;
const insExam = db.prepare(`
  INSERT INTO exam_questions (discipline, source, stem, options, answer_index, explanation, is_dissem)
  VALUES (?, ?, ?, ?, ?, ?, 0)
`);
const demoExam = [
  ['建筑', DEMO_TAG + '通用', '施工图设计文件深度应满足的基本要求是？',
   JSON.stringify(['越细越好', '满足施工、安装、加工及编制概预算的需要', '仅表达主要尺寸', '由设计单位自行决定']), 1,
   '施工图深度应以能满足施工、安装、加工及编制工程概预算的需要为原则，并非越细越好。'],
  ['水工', DEMO_TAG + '通用', '管道支吊架设计的主要作用不包括下列哪一项？',
   JSON.stringify(['承受管道荷载', '限制管道位移', '替代管道本身的强度', '控制管道振动']), 2,
   '支吊架用于承受荷载、限制位移、控制振动，但不能替代管道自身的强度设计。'],
  ['暖通', DEMO_TAG + '通用', 'BIM 管线综合的主要价值在于？',
   JSON.stringify(['增加图纸数量', '提前发现并解决管线碰撞冲突', '取代设计规范', '仅用于效果图展示']), 1,
   'BIM 管线综合可在施工前发现风管、水管、桥架之间的碰撞与冲突，减少现场返工。'],
  ['通信', DEMO_TAG + '通用', '接地端子编号应在哪类文件中明确表达？',
   JSON.stringify(['仅竣工图', '图纸强制表达项及竣工图', '不需要表达', '仅设备说明书']), 1,
   '接地端子编号应作为图纸强制表达项并在竣工图中落实，便于运维排查。'],
  ['通用', DEMO_TAG + '通用', '质量「人人讲」PDCA 循环中，C 代表的是？',
   JSON.stringify(['检查 Check', '沟通 Communicate', '成本 Cost', '客户 Customer']), 0,
   'PDCA 即 Plan(计划)-Do(执行)-Check(检查)-Act(处理)，C 为 Check（检查）。'],
];
for (const [discipline, source, stem, options, answerIndex, explanation] of demoExam) {
  const ex = db.prepare('SELECT id FROM exam_questions WHERE stem = ?').get(stem);
  if (!ex) {
    insExam.run(discipline, source, stem, options, answerIndex, explanation);
    examAdded++;
  }
}

console.log('──────── 演示种子写入完成 ────────');
console.log(`新增演示账号：${usersAdded} 个（已存在则跳过）`);
console.log(`新增演示公告：${announcementsAdded} 条`);
console.log(`新增演示宣贯：${dissemAdded} 条`);
console.log(`新增演示人人讲：${pdcaAdded} 条（各含 1 条解决方案）`);
console.log(`新增演示例题：${examAdded} 道`);
console.log('');
console.log('演示账号（默认密码 ' + config.password.defaultPassword + '，首次登录未强制改密，仅演示用）：');
console.log('  demo.dean      / 演示院长   （院长，可见管理中枢）');
console.log('  demo.chief     / 演示专总   （专总，水工）');
console.log('  demo.section   / 演示室主任 （室主任，建筑）');
console.log('  demo.designer  / 演示设计师 （设计师，暖通）');
console.log('  demo.designer2 / 演示设计师2（设计师，通信）');
console.log('系统自动种子：admin（管理员）/ guest1~guest9、examguest1~examguest9（只读游客，仅演示视野）');
console.log('');
console.log('⚠️ 本脚本仅供开源演示与本地自测，切勿在生产库执行。');
