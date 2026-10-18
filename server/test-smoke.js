/**
 * 冒烟测试：打通真实后端全链路
 * 运行：node test-smoke.js  (仅用全局 fetch，不需要 --experimental-sqlite)
 */
const BASE = 'http://127.0.0.1:3000';
let token = '';
let pass = 0, fail = 0;
function ok(name, cond, extra='') { if (cond) { pass++; console.log('  ✅', name, extra); } else { fail++; console.log('  ❌', name, extra); } }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${data.error || ''}`);
  return data;
}

(async () => {
  console.log('\n=== 质量千里行 · 后端冒烟测试 ===\n');

  // 1. 登录
  console.log('[1] 登录');
  try {
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: 'ChangeMe123!' });
    token = r.token;
    ok('管理员登录', !!token && r.user.role === 'leader', `realName=${r.user.realName}`);
  } catch (e) { ok('管理员登录', false, e.message); }

  // 2. 建质量目标
  console.log('[2] 发布质量目标');
  try {
    const r = await api('POST', '/api/goals', { title: '测试目标-差错率0.3‰', content: '测试内容', category: '年度目标', period: '2026全年' });
    ok('目标发布', !!r.id, `id=${r.id}`);
  } catch (e) { ok('目标发布', false, e.message); }

  // 3. 列目标
  try { const list = await api('GET', '/api/goals?status=active'); ok('目标列表', Array.isArray(list) && list.length >= 1, `count=${list.length}`); }
  catch (e) { ok('目标列表', false, e.message); }

  // 4. 上报问题
  console.log('[3] 现场问题上报');
  let ticketNo = '';
  try {
    const r = await api('POST', '/api/issues', { issueType: '图纸表达及成品显示', description: '测试：指北针方向标反', severity: 'high', projectName: '测试项目', volumeCode: 'T-01', volumeName: '测试卷册', volumeOwner: '张三' });
    ticketNo = r.ticketNo;
    ok('问题上报', !!ticketNo, `ticketNo=${ticketNo}`);
  } catch (e) { ok('问题上报', false, e.message); }

  // 5. 工单流转：分配→处理→解决→关闭
  console.log('[4] 工单流转');
  if (ticketNo) {
    try { await api('PUT', `/api/tickets/${ticketNo}/assign`, { assignedTo: '李四', comment: '分配给李四核实' }); ok('分配', true); }
    catch (e) { ok('分配', false, e.message); }
    try { await api('PUT', `/api/tickets/${ticketNo}/process`, {}); ok('开始处理', true); }
    catch (e) { ok('开始处理', false, e.message); }
    try { await api('PUT', `/api/tickets/${ticketNo}/resolve`, { resolvedNote: '已更正指北针方向，重新出图' }); ok('提交处理', true); }
    catch (e) { ok('提交处理', false, e.message); }
    try { await api('PUT', `/api/tickets/${ticketNo}/close`, {}); ok('验证关闭', true); }
    catch (e) { ok('验证关闭', false, e.message); }
    // 验证状态
    try { const t = await api('GET', `/api/issues/${ticketNo}`); ok('状态终态=closed', t.status === 'closed', `status=${t.status}, logs=${t.logs.length}`); }
    catch (e) { ok('状态终态', false, e.message); }
  } else { ok('工单流转', false, '无 ticketNo'); }

  // 6. 点子墙
  console.log('[5] 质量人人讲');
  let ideaId = 0;
  try { const r = await api('POST', '/api/ideas', { category: '工艺改进', title: '测试点子', content: '建立标准详图库' }); ideaId = r.id; ok('发布点子', !!ideaId, `id=${ideaId}`); }
  catch (e) { ok('发布点子', false, e.message); }
  try { const r = await api('POST', `/api/ideas/${ideaId}/like`, {}); ok('点赞', r.liked === true, `likes=${r.likes}`); }
  catch (e) { ok('点赞', false, e.message); }
  try { const r = await api('PUT', `/api/ideas/${ideaId}/adopt`, {}); ok('采纳', r.message.includes('采纳'), r.message); }
  catch (e) { ok('采纳', false, e.message); }

  // 7. 管理员：建账号 + 禁用 + 重置密码
  console.log('[6] 管理员操作');
  let newId = 0;
  const testUname = 'tu' + Date.now();
  try { const r = await api('POST', '/api/admin/users', { users: [{ username: testUname, realName: '测试员', role: 'designer', titleTag: '', department: '建筑室' }] }); newId = r.created[0].id; ok('建账号', !!newId, `id=${newId}, defaultPwd=${r.defaultPassword}`); }
  catch (e) { ok('建账号', false, e.message); }
  if (newId) {
    try { const r = await api('PUT', `/api/admin/users/${newId}/reset-pwd`, {}); ok('重置密码', r.newPassword === 'ChangeMe123!', r.message); }
    catch (e) { ok('重置密码', false, e.message); }
    // 用新账号登录
    try {
      const r = await fetch(BASE + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:testUname, password:'ChangeMe123!'}) });
      const d = await r.json();
      ok('新账号可登录+强制改密', r.ok && d.mustChangePwd === true, `mustChangePwd=${d.mustChangePwd}`);
    } catch (e) { ok('新账号登录', false, e.message); }
  }

  // 8. 鉴权：无 token 访问受保护接口应 401
  console.log('[7] 鉴权');
  try { const r = await fetch(BASE + '/api/goals'); ok('无token被拒(401)', r.status === 401, `status=${r.status}`); }
  catch (e) { ok('无token被拒', false, e.message); }

  console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===\n`);
  process.exit(fail ? 1 : 0);
})();
