/**
 * 基于「能力」的权限模型
 *
 * 设计原则：角色只是标签，界面与接口一律看「能力」，不写死 role 字符串。
 * 这样新增角色（室主任/专总/院长）不会散落一堆 if(role==='xxx')。
 *
 * 角色 → 能力映射：
 *   designer       设计师            canDesign
 *   section_leader 室主任           canDesign + canManage + canPublishDivision（专业室公告）
 *   chief          专总             canDesign + canManage + canPublishAll（全员公告）+ canPublishDivision（专业室公告，可选任意室）
 *   dean          院长             canDesign + canManage + canPublishAll（全员公告）+ canPublishDivision（专业室公告，可选任意室）
 *   admin          系统管理员        canManage + isSuper（建号/改密/禁用）+ 三套发布能力（公告/专业室公告/宣贯）
 *   leader         领导（旧超管别名） canManage + isSuper + 三套发布能力
 *   expert         专家（2026-07-27m） canDesign（PDCA 答疑 + 被请教提醒），无 canManage（无公告/宣贯/用户管理）
 *
 * 双身份：用户可带 extra_roles（JSON 数组）附加角色，如 专总+室主任。
 * 所有判断函数同时支持「角色字符串」或「用户对象 {role, extra_roles}」。
 */

// 具备「设计能力」的角色：能上报/解决自己的问题、有「质量工作」个人栏、可参与 PDCA 专家答疑
// 院长/专总同样保留设计人界面（与前端保持一致，落地"无论什么角色都首先保留设计人界面"）
// 总工（chief_engineer）保留设计人/专家界面（质量库 + 管理版面[仅小红花] + 专家职能），但不纳入管理者
// 专家（expert，2026-07-27m 新增）：仅答疑、无管理权限；保留设计人界面（PDCA 答疑 + 被请教提醒），但不纳入管理者
const DESIGN = ['designer', 'section_leader', 'chief', 'dean', 'chief_engineer', 'expert'];

// 具备「管理能力」的角色：看全量问题、推送/关闭部门问题、发公告、浏览人人讲、用户管理
// 总工（chief_engineer）不在此列：院长决策仅保留其专家身份，不给管理员/公告宣贯/用户管理权限（2026-07-25）
const MANAGE = ['section_leader', 'chief', 'dean', 'admin', 'leader'];

// 具备「超管能力」的角色：用户管理（建号/重置密码/禁用）
const SUPER = ['admin', 'leader'];

// 可发布「全员公告」的角色：院长 + 专总（超管 admin/leader 经 isSuper 一并放行，见下方 can*）
const PUBLISH_ALL = ['dean', 'chief'];

// 可发布「专业室公告」的角色：室主任（锁定本室）+ 院长/专总（可选任意室）（超管经 isSuper 放行）
const PUBLISH_DIV = ['section_leader', 'dean', 'chief'];

// 可发布「质量宣贯」的角色：院长 + 专总 + 室主任（按专业室多选，到期自动进质量库）（超管经 isSuper 放行）
const PUBLISH_DISSEM = ['dean', 'chief', 'section_leader'];

// 资深专家（总工）：比专总更高的评审专家。院长决策（2026-07-25）：总工仅保留专家身份，
// 享有「质量库 + 管理版面（仅小红花系统）+ 专家职能」，不拥有管理者权限
// （无用户管理、公告宣贯发布/审核/删除、内容改全权）。
// PDCA 规则不变：仅 专总/院长/超管 可邀请总工参加 PDCA 话题；设计师不可直接邀请。
const CHIEF_ENGINEER = ['chief_engineer'];

// 具备「专家答疑」职能的角色：被请教、在管理版面看到「被请教提醒」的候选与通知范围。
// 专家（expert，2026-07-27m 新增）为主力；总工（chief_engineer）作为资深专家保留相同职能。
// 室主任（section_leader）/ 专总（chief）同样具备专家职能：可被设计师/管理者邀请为 PDCA 共议专家，
//   并在被邀请后看到「被请教提醒」面板（2026-07-29 晚修正：此前 2026-07-27m「解耦」把专家收窄为独立角色，
//   导致室主任/专总从候选池消失，仅剩 3 名显式专家；现按用户口径恢复 室主任/专总（除暂不参与程序的综管/综能/节能三室）为专家）。
// 注意：室主任/专总本就在 MANAGE（有管理权限），此处叠加专家职能仅是「也可被请教答疑」，不改变其管理身份。
const EXPERT = ['expert', 'chief_engineer', 'section_leader', 'chief'];

// 把入参（角色字符串 或 用户对象）展开为角色集合
function rolesOf(input) {
  if (typeof input === 'string') return [input];
  if (!input || !input.role) return [];
  const set = [input.role];
  const ex = input.extra_roles ?? input.extraRoles;
  if (Array.isArray(ex)) set.push(...ex);
  else if (typeof ex === 'string' && ex) {
    try { set.push(...JSON.parse(ex)); } catch (e) {}
  }
  return set;
}

const canDesign = (input) => rolesOf(input).some(r => DESIGN.includes(r));
const canManage = (input) => rolesOf(input).some(r => MANAGE.includes(r));
const isSuper = (input) => rolesOf(input).some(r => SUPER.includes(r));
// 2026-07-26 修复 P0①：超管(admin/leader) 经 isSuper 一并获得三套发布能力（此前被遗漏，导致超管无法发公告/宣贯）
const canPublishAll = (input) => rolesOf(input).some(r => PUBLISH_ALL.includes(r)) || isSuper(input);
const canPublishDivision = (input) => rolesOf(input).some(r => PUBLISH_DIV.includes(r)) || isSuper(input);
const canPublishDissem = (input) => rolesOf(input).some(r => PUBLISH_DISSEM.includes(r)) || isSuper(input);

// 可邀请「总工」参加 PDCA 话题的角色：仅 专总 / 院长（设计师、室主任、超管均不可）。
// 2026-08-02 收窄：移除 isSuper —— 三位总工不进入「信息沟通人」可邀请目录，只有专总/院长解决问题时可邀请。
const canInviteChiefEngineer = (input) => {
  const rs = rolesOf(input);
  return rs.some(r => r === 'chief' || r === 'dean');
};

// 可「院选」人人讲（精选已闭环 PDCA 为质量人人讲）的角色：仅 院长 + 专总。
// 2026-07-26 优化：收窄——不再含室主任 / 超管 / 分管领导，避免每闭环一条 PDCA 就广播打扰全体领导层。
const canSelectRrj = (input) => {
  const rs = rolesOf(input);
  return rs.some(r => r === 'chief' || r === 'dean');
};

// 专总 / 院长的「专业」视为全部专业：不受程序中有专业（division）限制的地方约束。
// 院领导（专总/院长）本身即管理者，绝大多数列表本就全看；此函数用于显式兜底，
// 防止任何依据「本人 division 字段」做可见性/范围限定的分支把院领导误限在其登记专业内。
const hasAllDivisions = (input) => {
  const rs = rolesOf(input);
  return rs.some(r => r === 'chief' || r === 'dean');
};

// 超级管理员（superadmin / 真实姓名超级管理员）—— 全局唯一超级身份标识，多处用于「集中管控」判定
// （删除项目备忘、删除记录、超管兜底等）。集中到此处，杜绝各路由各自重写字符串导致漂移。
const isSuperAdmin = (input) => {
  if (!input) return false;
  if (typeof input === 'object') return input.username === 'superadmin';
  return false;
};

// 院级 oversight（只读强制可见）：专总（role chief）或 超级管理员。
// 用于项目备忘等模块的只读可见性判定。集中到此处，消除「双真相源」。
const isOversight = (input) => {
  const rs = rolesOf(input);
  return rs.includes('chief') || isSuperAdmin(input);
};

// 已发布内容「修改」权限（公告 / 质量宣贯 / 人人讲 通用）：
//   院长        → 可改全部（含他人与管理员内容）
//   专总        → 可改自己发的 + 设计师发的 + 室主任发的；不能改院长发的（B1：2026-07-30 放开室主任发的，仍不含院长）
//   室主任       → 可改自己发的 + 设计师发的；不能改其他管理者的
//   设计师       → 仅可改自己「尚未发布(pending/rejected)」的内容；已发布(active)不能自己改
//   record 需含 { publisher_id, publisher_role, status? }
const canEditContent = (input, record = {}) => {
  // 游客账户：纯只读，任何内容编辑一律禁止（兜底，主拦截在 auth 中间件对非 GET 请求 403）
  if (typeof input === 'object' && input && input.isGuest) return false;
  const rs = rolesOf(input);
  const id = typeof input === 'object' && input ? input.id : undefined;
  // 院长 可改全部；总工不在此列（无内容改全权）
  if (rs.includes('dean')) return true;
  if (rs.includes('chief') || rs.includes('section_leader')) {
    if (id && record.publisher_id && record.publisher_id === id) return true;
    if ((record.publisher_role || '') === 'designer') return true;
    // 专总额外可改室主任已发布的内容（B1：室主任发错时二把手可修正；不含院长）
    if (rs.includes('chief') && (record.publisher_role || '') === 'section_leader') return true;
    return false;
  }
  // designer / 其他角色：仅可改自己尚未发布的草稿
  if (id && record.publisher_id && record.publisher_id === id && record.status && record.status !== 'active') return true;
  return false;
};

module.exports = {
  DESIGN, MANAGE, SUPER, PUBLISH_ALL, PUBLISH_DIV, PUBLISH_DISSEM, CHIEF_ENGINEER, EXPERT,
  rolesOf, canDesign, canManage, isSuper, canPublishAll, canPublishDivision, canPublishDissem,
  canInviteChiefEngineer, canSelectRrj, canEditContent, hasAllDivisions, isSuperAdmin, isOversight,
};
