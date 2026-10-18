/**
 * 页面渲染器（续）：profile / admin
 * 扩展 Pages 对象
 */

(() => {
  const app = () => document.getElementById('app');
  const esc = UI.esc;
  const topbar = Pages.topbar;
  const tabbar = Pages.tabbar;

  // 小红花优秀榜卡片（管理中心页 .flower-banner）：点按先绽放一朵花再跳转榜单页，
  // 避免「立刻跳转」把花开动画截断。纯 CSS 动画（只动 transform/opacity），不影响加载速度。
  // 尊重系统「减少动态效果」→ 不延时，直接跳转。
  Pages.flowerTap = function (el) {
    const go = () => { location.hash = '#/flowers'; };
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduce || !el || el._blooming) { go(); return; }
    el._blooming = true;
    el.classList.remove('fb-bloom');
    void el.offsetWidth;                 // 强制重排，确保动画可重播
    el.classList.add('fb-bloom');
    setTimeout(go, 520);
  };

  // ─── 我的（设计师）─────────────────────────
  // V3 §6.6 / 设计稿 06：头像横向紧凑 + 「我的小红花」浅红卡 + 功能行（状态在右）
  // 原有功能全部保留：消息中心（站内信收发）/ 微信提醒 / 修改密码 / 退出登录
  async function profile() {
    const u = App.user;
    const isGuest = App.caps.isGuest;
    // 我的小红花（年度朵数）：仅正式成员请求；游客无个人红花
    let myFlower = 0;
    if (!isGuest) {
      try { const f = await API.get('/api/flowers/me'); myFlower = (f && Number(f.year || f.count || 0)) || 0; } catch (e) {}
    }
    const roleLabel = UI.roleLabel(u);
    // 副标题：职称 · 部门 · 角色（去空去重）
    const subs = [u.titleTag, u.department, roleLabel].filter((v, i, a) => v && a.indexOf(v) === i);
    app().innerHTML = `
      ${topbar('个人中心', { back: true })}
      <div class="page">
        <div class="card">
          <div class="profile-head-row">
            <div class="profile-avatar">👤</div>
            <div class="ph-main">
              <div class="profile-name">${esc(u.realName)}</div>
              <div class="ph-sub">${esc(subs.join(' · '))}</div>
            </div>
          </div>
        </div>
        ${isGuest ? '' : `
        <div class="me-flower" onclick="location.hash='#/flowers'">
          <span class="mf-label">🌸 我的小红花</span>
          <span class="mf-val">年度 ${myFlower} 朵</span>
        </div>`}
        ${isGuest ? '' : `
        <div class="card">
          <div class="me-row"><span class="me-label">Server酱 微信提醒</span><span id="wx-bind-body"><span class="text-muted">加载中…</span></span></div>
          <div class="me-row" onclick="location.hash='#/change-pwd'"><span class="me-label">修改密码</span><span class="me-arrow">›</span></div>
        </div>`}
        ${isGuest ? '' : `
        <div class="card">
          <div class="card-title">消息中心<span class="more-link" onclick="Pages.openReminderSender()">＋发提醒</span></div>
          <div id="profile-reminders"></div>
        </div>`}
        <div class="card">
          <div class="me-logout" onclick="App.logout()">退出登录</div>
        </div>
      </div>
      ${tabbar('profile')}`;
    if (Pages.remindersPanel && !isGuest) Pages.remindersPanel('profile-reminders');
    if (Pages.renderWxBind && !isGuest) Pages.renderWxBind('wx-bind-body');
  }

  // ── 微信提醒绑定（Server酱 / ServerChan：粘贴 SendKey，免扫码免 App）──
  async function renderWxBind(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    let st = { bound: false };
    try { st = await API.get('/api/serverchan/status'); } catch (e) {}
    // V3「我的」页：状态内联在功能行右侧（已绑定 / 未绑定 + 操作），不再单列一卡
    if (st.bound) {
      el.innerHTML = '<span style="color:var(--success);font-size:var(--fs-t5);font-weight:600;white-space:nowrap">已绑定</span>'
        + '<span class="more-link" style="color:var(--danger);white-space:nowrap;margin:0 0 0 10px;padding:0;font-size:var(--fs-t5)" onclick="Pages.unbindWx(\'' + elId + '\')">解绑</span>';
      return;
    }
    el.innerHTML = '<span class="text-muted" style="font-size:var(--fs-t5);white-space:nowrap">未绑定</span>'
      + '<span class="more-link" style="white-space:nowrap;margin:0 0 0 10px;padding:0;font-size:var(--fs-t5)" onclick="Pages.bindWx(\'' + elId + '\')">绑定</span>';
  }

  async function bindWx(elId, onClose) {
    const mask = document.createElement('div');
    mask.className = 'wx-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000';
    const closeLabel = onClose ? '稍后绑定' : '关闭';
    mask.innerHTML = '<div style="background:#fff;border-radius:14px;padding:22px 24px;max-width:340px;width:90%;text-align:center">'
      + '<div style="font-size:var(--fs-t4);font-weight:600;margin-bottom:8px">绑定微信提醒（Server酱）</div>'
      + '<div style="background:#eaf7f2;color:#0a7d6b;border-radius:8px;padding:8px 10px;font-size:var(--fs-t5);line-height:1.6;margin-bottom:12px"><b>✅ 免下载 App、免扫码</b>：绑定后提醒直接走微信原生「服务通知」。绑定只用于收通知，<b>进入系统仍需输用户名密码</b>。</div>'
      + '<div style="text-align:left;background:#f8fafb;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:var(--fs-t5);line-height:1.9">'
      + '<b>如何获取 SendKey：</b><br>① 微信搜索公众号「<b>Server酱</b>」并关注，或打开 <a href="https://sct.ftqq.com" target="_blank" rel="noopener" style="color:#0a7d6b">sct.ftqq.com</a><br>② 用微信登录后，首页会显示你的 <b>SendKey</b>（以 <b>SCT</b> 开头）<br>③ 复制下面的 SendKey 粘贴到此处'
      + '</div>'
      + '<textarea id="sc-key" rows="2" placeholder="粘贴 SendKey（SCT 开头）" style="width:100%;box-sizing:border-box;border:1px solid #d8dee2;border-radius:8px;padding:10px;font-size:var(--fs-t5);resize:vertical;font-family:monospace"></textarea>'
      + '<div id="sc-tip" class="text-muted" style="font-size:var(--fs-t5);margin-top:6px;text-align:left">提示：SendKey 仅存于本系统，用于向你推送提醒。</div>'
      + '<div style="margin-top:14px;display:flex;gap:10px;justify-content:center">'
      + '<button id="sc-bind" style="padding:10px 18px;border:none;border-radius:8px;background:#0a7d6b;color:#fff;cursor:pointer;font-size:var(--fs-t4)">绑定并发送测试</button>'
      + '<button style="padding:10px 16px;border:none;border-radius:8px;background:#9aa;color:#fff;cursor:pointer" onclick="this.closest(\'.wx-mask\').remove()">' + closeLabel + '</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(mask);
    if (onClose) {
      const _origRemove = mask.remove.bind(mask);
      mask.remove = function () { try { onClose(); } catch (e) {} _origRemove(); };
    }
    const btn = document.getElementById('sc-bind');
    const tip = document.getElementById('sc-tip');
    const input = document.getElementById('sc-key');
    if (btn) btn.onclick = async () => {
      const key = (input.value || '').trim();
      if (!/^SCT[a-zA-Z0-9]{5,}$/.test(key)) { tip.textContent = '⚠️ SendKey 格式不正确（应以 SCT 开头）'; tip.style.color = '#d8504a'; return; }
      btn.disabled = true; btn.textContent = '绑定中…';
      try {
        await API.post('/api/serverchan/bind', { key });
      } catch (e) { tip.textContent = '⚠️ 绑定失败：' + (e && e.message || e); tip.style.color = '#d8504a'; btn.disabled = false; btn.textContent = '绑定并发送测试'; return; }
      let testOk = false, msg = '';
      try { const t = await API.post('/api/serverchan/test'); testOk = true; msg = t.message || 'OK'; }
      catch (e2) { msg = (e2 && e2.message) || '测试发送失败'; }
      mask.remove();
      if (testOk) UI.toast('✅ 绑定成功，请查收微信「服务通知」');
      else UI.toast('已绑定，但测试发送失败：' + msg);
      Pages.renderWxBind(elId);
    };
  }

  async function unbindWx(elId) {
    if (!(await UI.confirm('确定解绑微信提醒？解绑后将不再推送微信。'))) return;
    try { await API.post('/api/serverchan/unbind'); UI.toast('已解绑'); Pages.renderWxBind(elId); } catch (e) { UI.toast('解绑失败'); }
  }
  // 暴露到 Pages（个人中心及其它入口调用）；漏挂会导致一直停在「加载中…」
  Pages.renderWxBind = renderWxBind;
  Pages.bindWx = bindWx;
  Pages.unbindWx = unbindWx;

  // ─── 管理（管理员）─────────────────────────
  async function admin() {
    const u = App.user;
    const canManage = App.caps.canManage;
    // 游客不再走专用分支——直接按自身角色渲染「全视野」（guest1=设计师 / guest2=室主任 / guest3=专总 / guest9=超级管理员），
    // 所有写按钮后续统一按 App.caps.isGuest 隐藏，后端 auth 中间件对非 GET 也 403 兜底，确保纯只读。
    // 用户管理：仅 admin / superadmin（院长）及游客 guest9（超级管理员视野，按用户要求含用户管理版块，但写按钮仍隐藏）。
    // 总工（chief_engineer）不给用户管理权（2026-07-25 院长决策）
    const canManageUsers = u.username === 'admin' || u.username === 'superadmin' || (App.caps.isGuest && u.username === 'guest9');
    const STATUS = { found: '待解决', solving: '解决中', solved: '已解决', reviewed: '已复盘', closed: '已闭环' };
    // 游客纯只读：顶部「＋建账号 / ＋发布」写入口一律隐藏（后端非 GET 也 403 兜底）
    const action = (App.caps.isGuest || !canManageUsers)
      ? (App.caps.canPublishAnnouncement ? { text: '＋发布', onclick: 'Pages.publishAnnouncement()' } : null)
      : { text: '＋建账号', onclick: 'Pages.createUser()' };
    app().innerHTML = `
      ${topbar('管理中心', { action, center: true })}
      <div class="page" id="admin-body"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>
      ${tabbar('admin')}`;

    // ── 总工（chief_engineer）：管理版面仅开放「小红花系统」+ 个人提醒收件箱 ──
    // 不给用户管理、公告宣贯管理（发布/审核/删除/内容改全权）。专家职能（PDCA 答疑）走主界面。
    const isChiefEngineer = u.role === 'chief_engineer' || (u.extraRoles || []).includes('chief_engineer');
    // 小红花年度优秀榜（管理界面优秀榜区展示；点进去看全量，默认按年度、可切按月/按奖惩）
    const flowerRank = await API.get('/api/flowers/summary').catch(() => []);
    // 年度总分榜：下方列表只出这一套「名次」，不再单列「月冠军最多者」——
    // ⚠️ 修复（2026-09-11 用户反馈「两遍第一名×××」）：原先把「月冠军最多者」也渲染成
    //    `<span class="medal gold">1</span>` 一行，而该人往往同时是年度第 1，于是同名同序号出现两次。
    const yearSorted = flowerRank.slice().sort((a, b) => (b.year - a.year) || (b.count - a.count) || (a.userName < b.userName ? -1 : 1));
    const yearTop3 = yearSorted.filter(x => x.year > 0).slice(0, 3);
    // 荣誉摘要（横向 chips）：与下方「年度名次」语义不同（荣誉身份，无序号），故不构成重复 ——
    //   👑 已结算的「月冠军」次数最多者（并列则全部列出）
    //   ⭐ 当月实时领先者（尚未结算，并列则全部列出）
    const fbTopHtml = (() => {
      let s = '';
      const maxChamp = flowerRank.reduce((m, x) => Math.max(m, x.champions || 0), 0);
      if (maxChamp > 0) {
        flowerRank.filter(x => (x.champions || 0) === maxChamp)
          .sort((a, b) => (b.year - a.year) || (a.userName < b.userName ? -1 : 1))
          .forEach(x => { s += `<span class="fb-it fb-crown">👑 <b>${esc(x.userName)}</b> <i>月冠军×${x.champions}</i></span>`; });
      }
      const maxMonth = flowerRank.reduce((m, x) => Math.max(m, x.month || 0), 0);
      if (maxMonth > 0) {
        flowerRank.filter(x => (x.month || 0) === maxMonth)
          .sort((a, b) => (a.userName < b.userName ? -1 : 1))
          .forEach(x => { s += `<span class="fb-it fb-lead">⭐ <b>${esc(x.userName)}</b> <i>本月领先</i></span>`; });
      }
      return s;
    })();
    const medalClass = ['gold', 'silver', 'bronze'];
    const top3Rows = yearTop3.length ? yearTop3.map((x, i) => `
          <div class="fb-row">
            <span class="medal ${medalClass[i]}">${i + 1}</span>
            <span class="fb-name">${esc(x.userName)}</span>
            <span class="fb-status">年度 ${x.year} 朵</span>
          </div>`).join('') : '<div class="fb-empty">本年暂无数据</div>';

    const flowerBannerHtml = `
      <div class="flower-banner" onclick="Pages.flowerTap(this)">
        <div class="fb-header">
          <div class="fb-title-row">
            <span class="fb-icon">🏵️</span>
            <span class="fb-title">小红花优秀榜</span>
          </div>
          <span class="fb-more">全部 ›</span>
        </div>
        <div class="fb-sub">月冠军与年度积分最高者，获年底绩效加档</div>
        ${fbTopHtml ? `<div class="fb-chips">${fbTopHtml}</div>` : ''}
        <div class="fb-list">
          ${top3Rows}
        </div>
      </div>`;
    // ── 专家（expert）：管理版面顶部叠加「被请教提醒」面板 ──
    // 专家职能（PDCA 答疑）无论本职是设计师 / 室主任 / 专总，都叠加在原有界面之上，不替换原界面。
    // 纯专家（role='expert'）走下方设计师视图即可看到本面板 + 自身相关内容；
    // 设计师 + 专家 同时保留设计师视图（我的问题等），故此处仅构建面板 HTML，不提前 return（2026-07-29 修复）。
    // 专家 = 显式专家（role='expert' 或 extra_roles 含 expert）+ 室主任 + 专总（被请教提醒面板对其同样可见，2026-07-29 晚修正）
    const isExpert = ['expert', 'section_leader', 'chief', 'chief_engineer'].includes(u.role)
      || (u.extraRoles || []).includes('expert') || (u.extra_roles || []).includes('expert');
    let expertPanelHtml = '';
    let expertUnanswered = 0;   // 供导航卡 badge 使用
    if (isExpert) {
      const tasks = await API.get('/api/pdca/expert-tasks').catch(() => []);
      const unanswered = tasks.filter(t => !t.answered);
      expertUnanswered = unanswered.length;
      const taskHtml = tasks.length ? tasks.map(t => `
        <div class="list-item expert-task" onclick="Pages.pdcaDetail(${t.id})">
          <div class="li-head"><div class="li-title">${esc(t.title)}</div>${t.answered ? '<span class="tag tag-resolved">已答复</span>' : '<span class="tag tag-pending">待答复</span>'}</div>
          <div class="li-meta"><span>👤 ${esc(t.reporter)}</span><span>${UI.relTime(t.created_at)}</span><span class="badge badge-${t.status}">${STATUS[t.status] || t.status}</span></div>
        </div>`).join('') : '<div class="empty"><div class="ei">💡</div><div class="et">暂无被请教的待处理问题</div></div>';
      expertPanelHtml = `
        <div class="card-title" id="sec-expert">被请教提醒（<span id="expert-unanswered-count">${unanswered.length}</span> 条待答复）<span class="vis-only">（专家可见）</span></div>
        <div id="expert-tasks">${taskHtml}</div>
      `;
    }

    if (isChiefEngineer) {
      // 总工视界：管理版面仅「小红花榜 + 被请教提醒 + PDCA 待办」，导航卡同构（2 行）
      const chiefNav = `<div class="adm-nav">
        <div class="adm-row" onclick="Pages.adminToggle('sec-expert')"><span class="adm-label">被请教提醒</span><span class="adm-arrow">›</span></div>
        <div class="adm-row" onclick="Pages.adminToggle('sec-inbox')"><span class="adm-label">PDCA 待办</span><span class="adm-arrow">›</span></div>
      </div>`;
      document.getElementById('admin-body').innerHTML = `
        ${flowerBannerHtml}
        ${expertPanelHtml}
        ${chiefNav}
        <div class="card-title" id="sec-inbox">PDCA 待办（<span id="admin-inbox-count"></span>）</div>
        <div id="admin-inbox"></div>
      `;
      initAdminSections();
      loadAdminInbox(document.getElementById('admin-inbox'), document.getElementById('admin-inbox-count'));
      return;
    }

    try {
      const isMgr = canManage;
      const [problems, rrj, pendingDissem, inbox, closed] = await Promise.all([
        API.get(isMgr ? '/api/pdca/problems' : '/api/pdca/problems?related=1').catch(() => []),
        API.get(isMgr ? '/api/pdca/problems?is_renrenjiang=1' : '/api/pdca/problems?is_renrenjiang=1&related=1').catch(() => []),
        canManage ? API.get('/api/quality-dissem/pending').catch(() => []) : Promise.resolve([]),
        API.get('/api/reminders/inbox').catch(() => []),
        isMgr ? API.get('/api/pdca/problems?status=closed').catch(() => []) : Promise.resolve([]),
      ]);
      // 仅 专总 / 院长 可在管理端勾选「院选人人讲」（2026-07-26 优化：收窄，不再含室主任/系统管理员）
      const canSelectRrj = ['chief', 'dean'].includes(u.role) || (u.extraRoles || []).some(r => ['chief', 'dean'].includes(r));
      // 室主任 / 专总 / 院长 兼具设计师身份：在管理全量视角下额外展示「我的问题（发起 / 共议）」
      const isMyProblems = ['section_leader', 'chief', 'dean'].includes(u.role) || (u.extraRoles || []).some(r => ['section_leader', 'chief', 'dean'].includes(r));
      const myProblems = isMyProblems ? problems.filter(p => {
        const ds = p.consult_designers ? (() => { try { return JSON.parse(p.consult_designers); } catch (e) { return []; } })() : [];
        return p.reporter === u.realName || ds.includes(u.realName);
      }) : [];
      // 简报栏仅对院长(dean) / 专总(chief) 开放（2026-07-25 院长决策），且置于小红花榜上方
      const isDeanOrChief = ['dean', 'chief'].includes(u.role) || (u.extraRoles || []).some(r => ['dean', 'chief'].includes(r));
      // 待解决问题总览只展示「未闭环」的帖子（已闭环 / 已院选的帖子在上方「院选人人讲」区块单独展示，不应混进待解决）
      const openProblems = problems.filter(p => p.status !== 'closed');

      // 院选候选 / 已院选 / 已不选 拆分 + 列表项渲染（含管理者「调整专业/地区/备注」「不选」入口）
      const rrjCandidates = closed.filter(p => !p.rrj_selected && !p.rrj_rejected);
      const rrjSelected = closed.filter(p => p.rrj_selected);
      const rrjRejected = closed.filter(p => p.rrj_rejected);
      const rrjItemHtml = (p) => `
        <div class="list-item rrj-item">
          <div class="li-head"><div class="li-title">${esc(p.title)}</div>${p.rrj_selected ? '<span class="tag tag-rrj">已入选 🏵️3</span>' : '<span class="tag tag-pending">待精选</span>'}</div>
          <div class="li-meta"><span>👤 ${esc(p.reporter)}</span><span>${UI.relTime(p.closed_at || p.created_at)}</span>${p.manager_note ? '<span class="tag tag-note">有备注</span>' : ''}</div>
          ${canSelectRrj && !App.caps.isGuest ? `
            <div class="rrj-actions">
              <label class="rrj-toggle"><input type="checkbox" ${p.rrj_selected ? 'checked' : ''} onchange="Pages.toggleRrj(${p.id}, this.checked)"> 入选人人讲（院选 ＋3 🏵️）</label>
              <button class="btn btn-sm" onclick="Pages.rrjCandidateEdit(${p.id})">调整专业/地区/备注</button>
              <button class="btn btn-sm btn-gray" onclick="Pages.rrjReject(${p.id})">不选</button>
            </div>` : (p.rrj_selected ? `<span class="rrj-by">由 ${esc(p.rrj_selected_by || '')} 精选</span>` : '')}
        </div>`;

      // 用户清单（导航卡「用户与权限」与下方「用户管理」区块共用，只请求一次）
      let allUsers = null;
      if (canManageUsers) { try { allUsers = (await API.get('/api/admin/users')) || []; } catch (e) { allUsers = []; } }
      // IMA 知识库同步状态（导航卡状态行；仅管理者）
      let imaStatus = null;
      if (isMgr && !App.caps.isGuest) { try { imaStatus = await API.get('/api/ima/status'); } catch (e) { imaStatus = null; } }

      // ── 管理中心导航卡（V3 §6.4 / 设计稿 05）：扁平入口，下方原有区块全部保留原样 ──
      // ⚠️ 口径必须与 loadAdminInbox 完全一致（同样排除「自己发给自己」的提醒），
      //    否则导航徽标会虚高：徽标 N 条、点开却只有 M 条（2026-09-11 审计修复）。
      const inboxPending = inbox.filter(r => r.state !== 'done' && r.related_problem_id && r.sender_name !== u.realName);
      const inboxCount = inboxPending.length;
      const navRows = [];
      const navRow = (label, opts) => {
        opts = opts || {};
        // badgeId 存在时「始终渲染」徽标元素（值为 0 时隐藏），便于数据加载完成后原地同步更新计数
        let right;
        if (opts.badgeId) {
          right = `<span class="adm-badge" id="${opts.badgeId}"${opts.badge > 0 ? '' : ' style="display:none"'}>${opts.badge || 0}</span>`;
        } else if (opts.badge > 0) {
          right = `<span class="adm-badge">${opts.badge}</span>`;
        } else if (opts.ok) {
          right = `<span class="adm-ok">${esc(opts.ok)}</span>`;
        } else if (opts.warn) {
          right = `<span class="adm-warn">${esc(opts.warn)}</span>`;
        } else { right = ''; }
        const cls = 'adm-row' + (opts.hl ? ' hl' : '') + (opts.go ? '' : ' no-go');
        // 该行若指向某个原有区块（adminToggle），记录锚点 id：渲染后会把该区块内容折叠收纳到本行下方
        const m = (opts.go || '').match(/Pages\.adminToggle\('([^']+)'\)/);
        const secAttr = m ? ` data-sec="${m[1]}"` : '';
        const oc = opts.go ? ` onclick="${opts.go}"` : '';
        return `<div class="${cls}"${secAttr}${oc}><span class="adm-label">${label}</span>${right}<span class="adm-arrow">${opts.go ? '›' : ''}</span></div>`;
      };
      if (!App.caps.isGuest && App.caps.canPublishAnnouncement) navRows.push(navRow('公告发布', { go: 'Pages.publishAnnouncement()' }));
      if (isMgr) navRows.push(navRow('宣贯审核', { badge: pendingDissem.length, badgeId: 'adm-badge-review', go: "Pages.adminToggle('sec-review')" }));
      // hl（高亮）只在「真的有待办」时生效，否则 0 条也高亮会误导
      navRows.push(navRow('PDCA 待办 · 请及时处理共议邀请', { badge: inboxCount, badgeId: 'adm-badge-inbox', hl: inboxCount > 0, go: "Pages.adminToggle('sec-inbox')" }));
      if (isMgr) navRows.push(navRow('未闭环问题清单', { badge: openProblems.length, go: "Pages.adminToggle('sec-open')" }));
      // 「我的问题」区块：管理者视界需具设计师身份才渲染；设计师视界恒渲染 → 导航行条件必须同步
      const myProblemCount = isMgr ? myProblems.length : problems.length;
      if (isMgr ? isMyProblems : true) navRows.push(navRow('我的问题（发起 / 共议）', { badge: myProblemCount, go: "Pages.adminToggle('sec-mine')" }));
      if (isMgr) navRows.push(navRow('院选精选', { badge: rrjCandidates.length, go: "Pages.adminToggle('sec-rrj')" }));
      // 「我的质量人人讲」区块仅设计师视界渲染（管理者视界由「院选精选」覆盖）
      if (!isMgr) navRows.push(navRow('我的质量人人讲（发起 / 共议）', { badge: rrj.length, go: "Pages.adminToggle('sec-myrrj')" }));
      // 与下方「项目信息传递提醒」区块统一为一套：点击就地展开该区块，不再另开弹窗形成两套布置
      if (!App.caps.isGuest) navRows.push(navRow('项目信息传递提醒', { go: "Pages.adminToggle('sec-shared')" }));
      if (u.username === 'superadmin' || (App.caps.isGuest && u.username === 'guest9')) navRows.push(navRow('最近活跃', { go: "Pages.adminToggle('sec-activity')" }));
      if (canManageUsers) navRows.push(navRow('用户与权限', { badge: allUsers ? allUsers.length : 0, go: "Pages.adminToggle('sec-users')" }));
      if (isExpert) navRows.push(navRow('被请教提醒', { badge: expertUnanswered, go: "Pages.adminToggle('sec-expert')" }));
      // 「月度质量工作简报」不再进导航卡：简报卡片本身平铺在小红花榜之上、且自带「生成简报」按钮，
      // 导航卡再放一个同名入口会形成「同一功能的第二套入口」（用户 2026-09-11 明确反对）。
      if (isMgr && imaStatus) navRows.push(navRow('IMA 知识库同步', { ok: imaStatus.status === 'ok' ? '已同步' : '', warn: imaStatus.status === 'ok' ? '' : '未同步', go: 'Pages.imaHelp()' }));
      const adminNavHtml = `<div class="adm-nav">${navRows.join('')}</div>`;

      // ── 管理界面版块顺序（人员无权限的版块自动跳过）：
      //   0 导航卡 → 1 月度质量简报(专总/院长) → 2 小红花优秀榜(全员) → 3 被请教提醒(专家) →
      //   4 宣贯审核 → 5 PDCA待办 → 6 未闭环问题清单 → 7 我的问题 →
      //   8 质量人人讲院选 → 9 最近活跃(superadmin) → 10 用户管理
      let html = '';
      if (isDeanOrChief) {
        html += `
        <div class="card" id="sec-report">
          <div class="card-title">月度质量工作简报<span class="vis-only">（唯专总/院长可见）</span></div>
          <div class="card-sub">按月份导出平台公告 / 质量宣贯 / 质量人人讲（分类型、数量、分专业统计）</div>
          <div class="card-actions" style="display:flex;justify-content:flex-end;margin-top:12px;">
            <button class="btn" ${(App.caps.isGuest ? 'disabled' : '')} onclick="${App.caps.isGuest ? 'return false' : 'Pages.openMonthlyReport()'}">生成简报</button>
          </div>
        </div>
        `;
      }
      // V3 §6.4（用户裁定 2026-09-11）：小红花优秀榜置顶 —— 月度质量简报之下、专家提醒与导航卡之上
      html += flowerBannerHtml;
      html += expertPanelHtml;
      html += adminNavHtml;

      if (isMgr) {
        // ── 管理者：全量视图（含公告管理 / 宣贯审核 / 用户管理）──
        html += `

        <div class="card-title" id="sec-review">宣贯审核（待审 <span id="admin-review-count">${pendingDissem.length}</span>）<span class="vis-only">（唯系统管理员/室主任/专总/院长可见）</span></div>
        <div id="admin-review"></div>

        <div class="card-title" id="sec-inbox">PDCA 待办（<span id="admin-inbox-count">${inbox.filter(r => r.state !== 'done' && r.related_problem_id).length}</span>）<span class="vis-only">（唯系统管理员/室主任/专总/院长可见）</span></div>
        <div id="admin-inbox"></div>

        <div class="card-title" id="sec-open">未闭环问题清单<span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA →</span><span class="vis-only">（唯系统管理员/室主任/专总/院长可见）</span></div>
        ${openProblems.length ? openProblems.slice(0, 8).map(p => `
          <div class="list-item" onclick="Pages.pdcaDetail(${p.id})">
            <div class="li-head"><div class="li-title">${esc(p.title)}</div><span class="badge badge-${p.status}">${STATUS[p.status] || p.status}</span></div>
            <div class="li-meta"><span>👤 ${esc(p.reporter)}</span>${p.source === 'dept' ? '<span class="badge-dept">部门</span>' : ''}<span>${UI.relTime(p.created_at)}</span></div>
          </div>`).join('') + (openProblems.length > 8 ? `<div class="text-muted" style="font-size:var(--fs-t5);margin:6px 2px 0">共 ${openProblems.length} 条，此处仅列前 8 条 — <span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA 查看全部 →</span></div>` : '') : '<div class="empty"><div class="ei">🔍</div><div class="et">暂无待解决问题</div><div class="es">共议中发现的问题会在这里跟进</div></div>'}

        ${isMyProblems ? `
        <div class="card-title" id="sec-mine">我的问题（发起 / 共议）<span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA →</span><span class="vis-only">（仅自己可见）</span></div>
        ${myProblems.length ? myProblems.slice(0, 8).map(p => {
          const ds = p.consult_designers ? (() => { try { return JSON.parse(p.consult_designers); } catch (e) { return []; } })() : [];
          const isCo = ds.includes(u.realName);
          return `
          <div class="list-item" onclick="Pages.pdcaDetail(${p.id})">
            <div class="li-head"><div class="li-title">${esc(p.title)}</div><span class="badge badge-${p.status}">${STATUS[p.status] || p.status}</span></div>
            <div class="li-meta"><span>👤 ${esc(p.reporter)}</span>${p.source === 'dept' ? '<span class="badge-dept">部门</span>' : ''}${isCo ? '<span class="badge-dept">共议</span>' : ''}<span>${UI.relTime(p.created_at)}</span></div>
          </div>`;
        }).join('') + (myProblems.length > 8 ? `<div class="text-muted" style="font-size:var(--fs-t5);margin:6px 2px 0">共 ${myProblems.length} 条，此处仅列前 8 条 — <span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA 查看全部 →</span></div>` : '') : '<div class="empty"><div class="ei">🤝</div><div class="et">你还没有发起或参与共议的问题</div><div class="es">在「发现问题」里发起第一个吧</div>' + (App.caps.isGuest ? '' : '<div class="ea"><button class="btn btn-sm btn-primary" onclick="Pages.pdcaCompose()">＋发起</button></div>') + '</div>'}
        ` : ''}

        <div class="card-title" id="sec-rrj">质量人人讲（院选精选）<span class="more-link" onclick="location.hash='#/pdca'">前往问题库 →</span><span class="vis-only">（唯系统管理员/室主任/专总/院长可见）</span></div>
        <div class="rrj-manage">
          <div class="rrj-sub">📥 院选候选（已闭环待精选 <span class="count-pill">${rrjCandidates.length}</span>）</div>
          ${rrjCandidates.length ? rrjCandidates.map(p => rrjItemHtml(p)).join('') : '<div class="empty"><div class="ei">🏅</div><div class="et">暂无待院选的已闭环问题</div></div>'}
          <div class="rrj-sub">✅ 已院选（首页人人讲版块 <span class="count-pill">${rrjSelected.length}</span>）</div>
          ${rrjSelected.length ? rrjSelected.map(p => rrjItemHtml(p)).join('') : '<div class="empty"><div class="ei">🎤</div><div class="et">暂无已入选人人讲</div></div>'}
          ${canSelectRrj && rrjRejected.length ? `
          <details class="rrj-rejected"><summary>🚫 已不选（${rrjRejected.length}）</summary>
            ${rrjRejected.map(p => `
              <div class="list-item rrj-item">
                <div class="li-head"><div class="li-title">${esc(p.title)}</div><span class="tag tag-pending">已不选</span></div>
                <div class="li-meta"><span>👤 ${esc(p.reporter)}</span><span>${UI.relTime(p.closed_at || p.created_at)}</span>${p.rrj_rejected_by ? `<span class="text-muted">— ${esc(p.rrj_rejected_by)}</span>` : ''}</div>
                <div class="rrj-actions"><button class="btn btn-sm btn-outline" onclick="Pages.rrjReject(${p.id}, false)">重新考虑（放回候选）</button></div>
              </div>`).join('')}
          </details>` : ''}
        </div>

        ${App.caps.isGuest ? '' : `<div class="card-title" id="sec-shared">项目信息传递提醒</div>
        <div id="shared-memo-card"><div class="text-muted" style="padding:8px 0">加载中…</div></div>
        <div class="sec-more"><span class="more-link" onclick="Pages.openSharedMemo()">查看全部 →</span></div>`}

        `;
        if (canManageUsers) {
          // GUEST9（超级管理员视野游客）同样可见：导航行条件早已含 guest9，若此处缺 guest9 会形成「点开没反应」的死条目
          if (u.username === 'superadmin' || (App.caps.isGuest && u.username === 'guest9')) {
            html += `
            <div class="card-title" id="sec-activity">最近活跃<span class="vis-only">（仅院长 superadmin / 游客 GUEST9 可见）</span></div>
            <div class="text-muted" style="font-size:var(--fs-t5);margin:-2px 0 8px">打开软件、浏览、筛选均计为活跃（不要求具体操作）；默认展示近 7 天，可点开查看近 30 天</div>
            <div id="login-activity-list"></div>`;
          }
          const users = allUsers || [];   // 已在导航卡之前取回，避免重复请求
          const allRoles = ['leader', 'admin', 'dean', 'chief', 'chief_engineer', 'section_leader', 'designer', 'expert'];
          const byRole = {};
          allRoles.forEach(r => byRole[r] = []);
          users.forEach(x => (byRole[x.role] || (byRole[x.role] = [])).push(x));
          html += `
            <div class="card-title" id="sec-users">用户管理<span class="vis-only">（唯系统管理员/院长可见）</span></div>
            ${allRoles.filter(r => byRole[r] && byRole[r].length).map(role => `
              <div class="card-sub" style="margin:12px 0 6px">${UI.ROLE_MAP[role] || role}</div>
              ${byRole[role].map(x => `
                <div class="list-item" style="cursor:default">
                  <div class="flex-between">
                    <div><b>${esc(x.realName)}</b><span class="role-tag ${x.role}">${UI.roleLabel(x)}</span>${(x.titleTag && x.titleTag !== UI.roleLabel(x)) ? `<span class="role-tag">${esc(x.titleTag)}</span>` : ''}</div>
                    <span class="badge ${x.isActive ? 'badge-resolved' : 'badge-closed'}">${x.isActive ? '启用' : '禁用'}</span>
                  </div>
                  <div class="li-meta"><span>@${esc(x.username)}</span><span>${esc(x.department || '未分配')}</span>${x.mustChangePwd ? '<span style="color:var(--accent)">未改密码</span>' : ''}</div>
                  <div class="mt8" style="display:flex;gap:8px">
                    ${App.caps.isGuest ? '' : `<span class="btn btn-sm btn-gray" data-uid="${x.id}" data-name="${esc(x.realName)}" onclick="Pages.resetPwd(this)">重置密码</span>`}
                    ${App.caps.isGuest ? '' : `<span class="btn btn-sm ${x.isActive ? 'btn-outline' : 'btn-gray'}" onclick="Pages.toggleUser(${x.id})">${x.isActive ? '禁用' : '启用'}</span>`}
                  </div>
                </div>`).join('')}
            `).join('')}
          `;
        }
      } else {
        // ── 设计师 / 普通用户：仅与自己相关（发起 / 共议 / 待解决），不出现公告管理、不出现他人人人讲 ──
        // 小红花优秀榜(Top3) 置于设计师管理界面最顶部（含专家身份设计师，与管理者一致可见）；
        // 专家职能用户（设计师 + 专家）在其下方叠加「被请教提醒」面板，同时保留本设计师视图
        html = flowerBannerHtml + expertPanelHtml + adminNavHtml + `
        <div class="card-title" id="sec-inbox">PDCA 待办（<span id="admin-inbox-count">${inbox.filter(r => r.state !== 'done' && r.related_problem_id).length}</span>）</div>
        <div id="admin-inbox"></div>

        <div class="card-title" id="sec-mine">我的问题（发起 / 共议 · 与 PDCA 同步）<span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA →</span></div>
        ${problems.length ? problems.slice(0, 8).map(p => {
          const ds = p.consult_designers ? (() => { try { return JSON.parse(p.consult_designers); } catch (e) { return []; } })() : [];
          const isCo = ds.includes(App.user.realName);
          return `
          <div class="list-item" onclick="Pages.pdcaDetail(${p.id})">
            <div class="li-head"><div class="li-title">${esc(p.title)}</div><span class="badge badge-${p.status}">${STATUS[p.status] || p.status}</span></div>
            <div class="li-meta"><span>👤 ${esc(p.reporter)}</span>${p.source === 'dept' ? '<span class="badge-dept">部门</span>' : ''}${isCo ? '<span class="badge-dept">共议</span>' : ''}<span>${UI.relTime(p.created_at)}</span></div>
          </div>`;
        }).join('') + (problems.length > 8 ? `<div class="text-muted" style="font-size:var(--fs-t5);margin:6px 2px 0">共 ${problems.length} 条，此处仅列前 8 条 — <span class="more-link" onclick="location.hash='#/pdca'">前往 PDCA 查看全部 →</span></div>` : '') : '<div class="empty"><div class="ei">🤝</div><div class="et">你还没有发起或参与共议的问题</div><div class="es">在「发现问题」里发起第一个吧</div>' + (App.caps.isGuest ? '' : '<div class="ea"><button class="btn btn-sm btn-primary" onclick="Pages.pdcaCompose()">＋发起</button></div>') + '</div>'}

        <div class="card-title" id="sec-myrrj">我的质量人人讲（发起 / 共议 · 与 PDCA 同步）<span class="more-link" onclick="location.hash='#/pdca'">查看全部 →</span></div>
        ${rrj.length ? rrj.slice(0, 3).map(p => {
          const ds = p.consult_designers ? (() => { try { return JSON.parse(p.consult_designers); } catch (e) { return []; } })() : [];
          const isCo = ds.includes(App.user.realName);
          return `
          <div class="list-item" onclick="Pages.pdcaDetail(${p.id})">
            <div class="li-head"><div class="li-title">${esc(p.title)}</div>${p.rrj_selected ? '<span class="tag tag-rrj">院选 🏵️3</span>' : '<span class="tag">人人讲</span>'}</div>
            <div class="li-meta"><span>👤 ${esc(p.reporter)}</span>${isCo ? '<span class="badge-dept">共议</span>' : ''}</div>
          </div>`;
        }).join('') : '<div class="empty"><div class="ei">🎤</div><div class="et">你还没有发起或参与共议的人人讲案例</div></div>'}

        ${App.caps.isGuest ? '' : `<div class="card-title" id="sec-shared">项目信息传递提醒</div>
        <div id="shared-memo-card"><div class="text-muted" style="padding:8px 0">加载中…</div></div>
        <div class="sec-more"><span class="more-link" onclick="Pages.openSharedMemo()">查看全部 →</span></div>`}
        ${isExpert ? `
        <div class="card" style="background:#f3f8ff;border:1px solid #cfe0ff">
          <div class="text-muted" style="font-size:var(--fs-t5);line-height:1.75">💡 你是<b>专家</b>：同事向你请教的待答复问题见上方「💡 被请教提醒」，请到 <span class="more-link" onclick="location.hash='#/pdca'">PDCA 主界面</span> 答复。质量库、人人讲等全员内容均可正常浏览与参与。</div>
        </div>` : ''}
        `;
      }

      document.getElementById('admin-body').innerHTML = html;
      // 先把原有区块折叠收纳进各导航行下方（在加载数据之前：节点已到新位置，后续引用依然有效）
      initAdminSections();
      const sharedCard = document.getElementById('shared-memo-card');
      if (sharedCard) Pages.loadSharedMemoCard(sharedCard);
      if (canManage) loadAdminReview(document.getElementById('admin-review'), document.getElementById('admin-review-count'));
      loadAdminInbox(document.getElementById('admin-inbox'), document.getElementById('admin-inbox-count'));
      if (u.username === 'superadmin' || (App.caps.isGuest && u.username === 'guest9')) loadLoginActivity(document.getElementById('login-activity-list'));
    } catch (e) { UI.toast(e.message); }
  }

  // 管理中心导航卡（V3 §6.4 / 设计稿 05，用户裁定 2026-09-11）：
  // 导航行 = 折叠面板的表头。点一下 → 在其下方展开对应原有区块的内容；
  // 区块仍留在原位（零 DOM 搬运，避免破坏加载逻辑），但原标题行隐藏、由导航行取代 ——
  // 于是「导航卡 + 平铺区块」两套布置合并为一套，内容零丢失、仅默认收起。
  function collectSection(id) {
    const head = document.getElementById(id);
    if (!head) return null;
    const nodes = [head];
    let n = head.nextElementSibling;
    while (n && !n.classList.contains('card-title')) {
      // ⚠️ 导航卡（.adm-nav）不属于任何区块：若某区块位于导航卡之前（如「被请教提醒」），
      //    其兄弟链会穿过导航卡；必须跳过，否则导航卡会被一并收起（曾致导航卡整块消失）。
      if (!n.classList.contains('adm-nav')) nodes.push(n);
      const nx = n.nextElementSibling; n = nx;
    }
    return nodes;
  }

  // 渲染后调用：给每个有导航行的区块打上分组标记并默认收起
  function initAdminSections() {
    const body = document.getElementById('admin-body');
    if (!body) return;
    body.querySelectorAll('.adm-row[data-sec]').forEach(row => {
      const id = row.getAttribute('data-sec');
      if (!document.getElementById(id)) return;
      const nodes = collectSection(id);
      if (!nodes) return;
      nodes.forEach((el, i) => {
        el.setAttribute('data-sec-group', id);
        el.setAttribute('hidden', '');
        // 原标题行由导航行取代：保留 DOM（计数元素仍需被 loadAdminInbox 等更新）但不显示
        if (i === 0) el.classList.add('adm-sec-title');
      });
    });
  }

  Pages.adminToggle = (id) => {
    const nodes = document.querySelectorAll('[data-sec-group="' + id + '"]');
    if (!nodes.length) return;
    const willOpen = nodes[0].hasAttribute('hidden');
    nodes.forEach(el => willOpen ? el.removeAttribute('hidden') : el.setAttribute('hidden', ''));
    const row = document.querySelector('.adm-row[data-sec="' + id + '"]');
    if (row) row.classList.toggle('open', willOpen);
    if (willOpen) {
      const head = document.getElementById(id);
      if (head) { try { head.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { head.scrollIntoView(); } }
    }
  };

  // IMA 知识库同步异常时的处理指引（导航卡「IMA 知识库同步」行的点击入口，避免该行点了没反应）
  Pages.imaHelp = () => {
    UI.modal('IMA 知识库同步', `
      <div class="text-muted" style="font-size:var(--fs-t5);line-height:1.85">
        <p style="margin:0 0 8px">平台每日自动校验 IMA 连接：<b>04:37</b> 自检、<b>04:47</b> 自动重绑（20 天门控）；一旦失败会通过微信推送告警。</p>
        <p style="margin:0 0 8px">显示「未同步」多为 <b>IMA 授权 Key 到期</b>（约每月一次）：</p>
        <p style="margin:0 0 4px">① 微信打开 <b>ima.qq.com/agent-interface</b> 重新生成 Key（<b>新 Key 只显示一次，请立即保存</b>）；</p>
        <p style="margin:0 0 4px">② 把新 Key 发给系统管理员完成重绑；</p>
        <p style="margin:0">③ 也可在服务器执行 <code>node src/imaRebind.js --now</code> 立即重绑。</p>
      </div>`);
  };

  // ─── 项目备忘提醒（闭环缺口1重做）：被开立人/参与者邀请加入「信息沟通人」时收到的提醒收件箱 ───
  function memoReminderItemHtml(r) {
    const proj = r.project_name || '项目信息传递';
    return `
      <div class="list-item clickable" style="position:relative" data-mid="${r.id}" onclick="Pages.memoGotoOriginal(${r.related_memo_project_id}, ${r.related_memo_record_id != null ? r.related_memo_record_id : 'null'}, ${r.id})">
        <div class="li-head"><div class="li-title">${esc(r.title || '项目信息传递提醒')}</div>${proj ? `<span class="tag tag-note">${esc(proj)}</span>` : ''}</div>
        <div class="li-meta"><span>👤 ${esc(r.sender_name || '')}</span><span>${UI.relTime(r.created_at)}</span></div>
        <div class="li-meta"><span class="text-muted">➕ 一键加入项目</span></div>
        <button class="memo-dismiss" title="关闭该提醒" onclick="Pages.memoReminderDismiss(event, ${r.id})">✕</button>
      </div>`;
  }

  // 关闭「项目备忘提醒」条目（对标其他提醒的「可关闭」按钮，避免永远留在框里）。
  // 仅软隐藏自己收到的提醒；同时移除卡片/弹窗中的对应 DOM 并刷新卡片。
  Pages.memoReminderDismiss = async (ev, id) => {
    ev.stopPropagation();
    if (!id) return;
    try {
      UI.loading(true);
      await API.post(`/api/memos/my-reminders/${id}/dismiss`, {});
      UI.toast('已关闭该提醒');
      document.querySelectorAll(`[data-mid="${id}"]`).forEach(n => n.remove());
      const card = document.getElementById('shared-memo-card');
      if (card) Pages.loadSharedMemoCard(card);
    } catch (e) { UI.toast(e.message); }
    finally { UI.loading(false); }
  };

  Pages.loadSharedMemoCard = async (el) => {
    if (!el) return;
    try {
      const list = await API.get('/api/memos/my-reminders');
      if (!list.length) { el.innerHTML = '<div class="empty"><div class="ei">📨</div><div class="et">暂无项目信息传递提醒</div></div>'; return; }
      el.innerHTML = list.slice(0, 3).map(r => memoReminderItemHtml(r)).join('') + (list.length > 3 ? `<div class="text-muted" style="padding:6px 0;cursor:pointer" onclick="Pages.openSharedMemo()">查看全部 ${list.length} 条 →</div>` : '');
    } catch (e) { el.innerHTML = `<div class="text-muted" style="padding:8px 0">加载失败：${esc(e.message)}</div>`; }
  };

  Pages.openSharedMemo = async () => {
    try {
      UI.loading(true);
      const list = await API.get('/api/memos/my-reminders');
      const body = list.length ? list.map(r => memoReminderItemHtml(r)).join('') : '<div class="empty"><div class="ei">📨</div><div class="et">暂无项目信息传递提醒</div></div>';
      UI.modal('📣 项目信息传递提醒', `
        <p class="text-muted" style="font-size:var(--fs-t5);margin:0 0 10px">当你被某项目的开立人或参与者邀请加入「信息沟通人」时，会在此收到提醒，点击可「一键加入」并直接进入该项目。</p>
        ${body}
      `, () => {});
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // 是否微信 / 移动端外壳（决定简报按钮形态与打开方式）
  const isWxShell = () => {
    const ua = navigator.userAgent || '';
    return /MicroMessenger/i.test(ua) || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  };

  // ─── 月度质量工作简报（PDF / Word 导出）────────────
  Pages.openMonthlyReport = () => {
    const pad2 = n => (n < 10 ? '0' + n : '' + n);
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    const def = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    const curYear = new Date().getFullYear();
    UI.modal('质量工作简报', `
      <div class="field"><label>统计方式</label>
        <select id="mr-mode" class="input">
          <option value="month">单月</option>
          <option value="range">区间累加（多月）</option>
          <option value="year">全年</option>
        </select>
      </div>
      <div class="field" id="mr-month-wrap"><label>统计月份</label><input type="month" id="mr-month" class="input" value="${def}"></div>
      <div class="field" id="mr-range-wrap" style="display:none">
        <div style="display:flex;gap:10px">
          <div style="flex:1"><label>起（含）</label><input type="month" id="mr-from" class="input" value="${def}"></div>
          <div style="flex:1"><label>止（含）</label><input type="month" id="mr-to" class="input" value="${curYear}-${pad2(d.getMonth() + 1)}"></div>
        </div>
      </div>
      <div class="field" id="mr-year-wrap" style="display:none"><label>年份</label><input type="number" id="mr-year" class="input" value="${curYear}" min="2020" max="2099"></div>
      <p class="text-muted" style="font-size:var(--fs-t5);margin:0 2px 12px">单月=某月；区间累加=起止月之间（含两端）所有月份汇总；全年=该年 1–12 月汇总。公告/宣贯按创建月、人人讲按闭环月统计。PDF 版含「总览 + 分版块叙述」结构。</p>
      ${isWxShell() ? '<p class="text-muted" style="font-size:var(--fs-t5);margin:0 2px 12px">📱 微信内会自动切换为<b>在线预览</b>（微信不支持直接打开 .docx）。需保存原始文件，请点右上角「…」→ 在浏览器中打开。</p>' : ''}
      ${isWxShell() ? '<button class="btn btn-block" id="mr-view" style="margin-bottom:8px">📱 在线查看（微信内推荐）</button>' : ''}
      <button class="btn btn-block" id="mr-pdf">生成 PDF 简报</button>
      <button class="btn btn-block" id="mr-word" style="margin-top:8px;background:#fff;color:#0a5c50;border:1px solid #0a5c50">下载 Word 版（.docx · 可编辑）</button>
    `, (mask, close) => {
      const modeSel = mask.querySelector('#mr-mode');
      const toggle = () => {
        const v = modeSel.value;
        mask.querySelector('#mr-month-wrap').style.display = v === 'month' ? '' : 'none';
        mask.querySelector('#mr-range-wrap').style.display = v === 'range' ? '' : 'none';
        mask.querySelector('#mr-year-wrap').style.display = v === 'year' ? '' : 'none';
      };
      modeSel.onchange = toggle; toggle();
      const collect = () => {
        const v = modeSel.value;
        if (v === 'range') {
          const f = mask.querySelector('#mr-from').value, t = mask.querySelector('#mr-to').value;
          if (!f || !t) return null;
          return { qs: 'from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t), base: '质量工作简报_' + f + '_' + t };
        } else if (v === 'year') {
          const y = mask.querySelector('#mr-year').value;
          if (!y) return null;
          return { qs: 'year=' + encodeURIComponent(y), base: '质量工作简报_' + y + '全年' };
        } else {
          const m = mask.querySelector('#mr-month').value;
          if (!m) return null;
          return { qs: 'month=' + encodeURIComponent(m), base: '质量工作月报_' + m };
        }
      };
      mask.querySelector('#mr-pdf').onclick = () => {
        const p = collect(); if (!p) return UI.toast('请选择统计范围');
        Pages.downloadMonthlyReportPDF(p.qs, p.base + '.pdf');
        close();
      };
      mask.querySelector('#mr-word').onclick = () => {
        const p = collect(); if (!p) return UI.toast('请选择统计范围');
        Pages.downloadMonthlyReport(p.qs, p.base + '.docx');
        close();
      };
      // 微信内「在线查看」：走服务端生成 docx（比客户端 html2canvas 稳），随后由 _saveBlobRobust 自动转 kkf 预览
      const viewBtn = mask.querySelector('#mr-view');
      if (viewBtn) viewBtn.onclick = () => {
        const p = collect(); if (!p) return UI.toast('请选择统计范围');
        Pages.downloadMonthlyReport(p.qs, p.base + '.docx');
        close();
      };
    });
  };
  Pages.downloadMonthlyReport = async (qs, fname) => {
    try {
      UI.loading(true);
      const token = API.getToken();
      const res = await fetch('/api/stats/monthly-export?' + qs, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || '导出失败'); }
      const blob = await res.blob();
      const mode = await Pages._saveBlobRobust(blob, fname || '质量工作简报.docx');
      UI.toast(mode === 'preview'
        ? '已生成，正在打开在线预览；需原始文件请点右上角「…」→ 在浏览器中打开'
        : '已生成，正在打开 / 下载…');
    } catch (e) { UI.toast(e.message); }
    finally { UI.loading(false); }
  };

  // 微信 / 移动端打开策略（2026-09-15 修复「微信内文档打不开」）：
  //   微信内置浏览器**不能直接预览 .docx/.xlsx/.pptx**（直跳文件地址 → 白屏 / 提示格式不支持），
  //   且同源响应带 X-Frame-Options: DENY + CSP frame-ancestors 'none'，内嵌渲染同样会被拦。
  //   故 Word/Excel/PPT/PDF 一律改走 kkFileView 在线预览页（服务端已转成可滚动的图片/PDF 预览），
  //   微信内可直接翻阅；需保存原件再提示「右上角 → 在浏览器中打开」。
  //   注：url 参数须为 base64（沿用 ui.js officeViewerHref 的同款约定）。
  const KK_PREVIEW_EXT = ['pdf', 'doc', 'docx', 'wps', 'xls', 'xlsx', 'ppt', 'pptx'];
  Pages._wechatOpenTarget = (absUrl, name) => {
    const ext = String(absUrl.split('?')[0].split('.').pop() || '').toLowerCase();
    if (!KK_PREVIEW_EXT.includes(ext)) return { url: absUrl, mode: 'upload' };
    try {
      return { url: location.origin + '/kkf/onlinePreview?url=' + encodeURIComponent(btoa(absUrl)), mode: 'preview' };
    } catch (e) {
      return { url: absUrl, mode: 'upload' }; // btoa 失败（非 Latin-1 字符）→ 回退直连
    }
  };

  // 通用文件导出：移动端 / 微信下直接 blob 下载经常失败（中文名丢失后缀、WKWebView 不下载），
  // 改为上传到服务器拿真实 https URL 后用页面导航打开；桌面端仍走本地 blob 下载。
  Pages._saveBlobRobust = async (blob, name) => {
    const ua = navigator.userAgent || '';
    const isWeixin = /MicroMessenger/i.test(ua);
    const isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
    if (isWeixin || isMobile) {
      const fd = new FormData();
      fd.append('file', blob, name || 'file.bin');
      const token = API.getToken();
      const up = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      if (!up.ok) throw new Error('文件上传失败（' + up.status + '）');
      const j = await up.json();
      // 优先使用后端签好的带 sig 的下载 URL（#536），免登录也能打开；签名默认 10 分钟过期。
      // 若后端未签（兼容旧版），回退到 /uploads + /api/download 拼接（仍需登录态）。
      let downloadUrl;
      if (j.signedUrls && j.signedUrls[0]) {
        downloadUrl = j.signedUrls[0];
      } else {
        const url = (j.urls && j.urls[0]) || j.url;
        if (!url) throw new Error('未获得文件地址');
        const stored = url.replace(/^\/uploads\//, '');
        downloadUrl = '/api/download/' + stored + '?filename=' + encodeURIComponent(name || 'file.bin');
      }
      // 用页面导航打开（非弹窗，规避 iOS 微信对 window.open 的拦截）
      // 微信内 Office/PDF → 自动转到 kkFileView 在线预览页；其余类型直连
      const t = Pages._wechatOpenTarget(location.origin + downloadUrl, name);
      window.location.href = t.url;
      return t.mode;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'file.bin';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'download';
  };

  // 首屏优化：html2canvas / jspdf 仅「导出 PDF」用到，改为按需懒加载，避免 ~550KB 阻塞首屏
  let _pdfLibsPromise = null;
  function ensurePdfLibs() {
    if (window.html2canvas && window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    if (_pdfLibsPromise) return _pdfLibsPromise;
    const v = (document.querySelector('meta[name="build-version"]') || {}).content || '';
    const inject = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v;
      s.onload = resolve;
      s.onerror = () => reject(new Error('PDF 组件加载失败：' + src));
      document.head.appendChild(s);
    });
    _pdfLibsPromise = Promise.all([inject('vendor/html2canvas.min.js'), inject('vendor/jspdf.umd.min.js')])
      .then(() => { if (!(window.html2canvas && window.jspdf && window.jspdf.jsPDF)) throw new Error('PDF 组件未就绪'); });
    return _pdfLibsPromise;
  }
  // PDF 生成：拉取纯 HTML 简报 → 整页渲染为一张长图 → 按「条目边界」智能切片分页
  // 彻底规避旧版两个缺陷：
  //  ① 测量宿主未注入报告 CSS → 测高偏矮、装太满被 overflow 裁掉（条目缺失）
  //  ② 把 <li> 从 <ol> 抽出分页 → 序号丢失、单条目超高溢出被裁（条目截断）
  Pages.downloadMonthlyReportPDF = async (qs, fname) => {
    try {
      UI.loading(true);
      await ensurePdfLibs();
      const token = API.getToken();
      const res = await fetch('/api/stats/monthly-html?' + qs, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || '生成失败'); }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const A4W_PX = 794;  // A4 逻辑宽度 px（72dpi）
      const A4H_PX = 1123; // A4 逻辑高度 px
      const SCALE = 2;

      // 离屏宿主：注入报告样式（关键！否则测量与渲染不一致）
      let measure = document.getElementById('pdf-measure-host');
      if (!measure) { measure = document.createElement('div'); measure.id = 'pdf-measure-host'; document.body.appendChild(measure); }
      measure.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + A4W_PX + 'px;overflow:visible;background:#fff;';
      measure.innerHTML = '';
      const styleEl = doc.querySelector('style');
      if (styleEl) { const s = document.createElement('style'); s.textContent = styleEl.textContent; measure.appendChild(s); }

      // 完整报告放入宿主（保留原始 <ol> 序号，不拆分条目）
      const report = doc.body.querySelector('.report') || doc.body;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:' + A4W_PX + 'px;box-sizing:border-box;background:#fff;';
      wrap.appendChild(report.cloneNode(true));
      measure.appendChild(wrap);

      // 等图片加载 + 布局稳定（含图条目测高偏矮会装太满被裁）
      const imgs = Array.from(wrap.querySelectorAll('img'));
      await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = () => r(); })));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // 计算安全切页线：优先在 条目/标题/模块 的「结束处」切，避免切断内容
      const wrapRect = wrap.getBoundingClientRect();
      const cutLines = new Set([0]);
      Array.from(wrap.querySelectorAll('.brief-item, .section-title, .stat, .summary, .header, .note')).forEach(el => {
        const r = el.getBoundingClientRect();
        cutLines.add(Math.round(r.bottom - wrapRect.top));
        cutLines.add(Math.round(r.top - wrapRect.top));
      });

      // 整页一次性截图（保证内容 0 丢失）
      const full = await html2canvas(wrap, { scale: SCALE, backgroundColor: '#ffffff', useCORS: true, logging: false, width: A4W_PX, windowWidth: A4W_PX });
      const cw = full.width;
      // ⚠️ 权威总高来自「真实渲染画布」：getBoundingClientRect 测高偶尔比实际渲染矮
      //    （字体/亚像素差异），会导致末页内容被裁、底部条目缺失。改用画布实际高度。
      const totalH = Math.round(full.height / SCALE);
      cutLines.add(totalH);
      const lines = Array.from(cutLines).sort((a, b) => a - b);

      // 按 A4 高度分页：每页结束点落在「最近的条目边界线」上（不切断条目）
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const A4W_MM = 210, A4H_MM = 297;
      let top = 0, first = true, guard = 0;
      while (top < totalH - 2 && guard++ < 200) {
        const target = top + A4H_PX;
        let bottom = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] > top + 4 && lines[i] <= target + 4) { bottom = lines[i]; break; }
        }
        if (bottom < 0) bottom = Math.min(target, totalH); // 兜底：单条目超高，硬切（不丢内容）
        if (bottom <= top) bottom = Math.min(target, totalH);
        if (bottom > totalH) bottom = totalH; // 夹取：测量线超出真实画布时不越界读取

        const sy = Math.round(top * SCALE);
        const sh = Math.max(1, Math.round((bottom - top) * SCALE));
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = cw; pageCanvas.height = sh;
        const pctx = pageCanvas.getContext('2d');
        pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, cw, sh);
        pctx.drawImage(full, 0, sy, cw, sh, 0, 0, cw, sh);
        const imgData = pageCanvas.toDataURL('image/jpeg', 0.92);

        // 适配 A4：先按宽度铺满；若本页比 A4 还高则等比缩放到页高（绝不裁切）
        let w = A4W_MM, h = A4W_MM * sh / cw;
        if (h > A4H_MM) { h = A4H_MM; w = A4H_MM * cw / sh; }
        if (!first) pdf.addPage(); first = false;
        pdf.addImage(imgData, 'JPEG', (A4W_MM - w) / 2, 0, w, h);
        top = bottom;
      }

      // 安全兜底：若因浮点/夹取仍有残余内容，补最后一页（保证 0 丢失）
      if (top < totalH - 2) {
        const sy = Math.round(top * SCALE);
        const sh = Math.max(1, full.height - sy);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = cw; pageCanvas.height = sh;
        const pctx = pageCanvas.getContext('2d');
        pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, cw, sh);
        pctx.drawImage(full, 0, sy, cw, sh, 0, 0, cw, sh);
        const imgData = pageCanvas.toDataURL('image/jpeg', 0.92);
        let w = A4W_MM, h = A4W_MM * sh / cw;
        if (h > A4H_MM) { h = A4H_MM; w = A4H_MM * cw / sh; }
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', (A4W_MM - w) / 2, 0, w, h);
      }

      const safeName = fname || '质量工作简报.pdf';
      const blob = pdf.output('blob');
      await Pages._saveBlobRobust(blob, safeName);
      UI.toast('已生成 PDF（共 ' + pdf.getNumberOfPages() + ' 页），正在打开 / 下载…');
    } catch (e) { UI.toast(e.message); }
    finally { UI.loading(false); }
  };

  // ─── 小红花优秀榜 ─────────────────────────
  async function flowers() {
    // 院长/系统管理员可见「红花奖惩管理」入口（兼容 extraRoles，P7）
    const canAdjust = App.user && (App.user.role === 'admin' || App.user.role === 'dean' || (App.user.extraRoles || []).includes('admin') || (App.user.extraRoles || []).includes('dean'));
    app().innerHTML = `
      ${topbar('小红花优秀榜', { back: true })}
      <div class="page" id="flowers-body"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>
      ${tabbar('admin')}`;
    try {
      const nowY = new Date().getFullYear();
      const nowM = new Date().getMonth() + 1;
      const [list, me, board, bimonth] = await Promise.all([
        API.get('/api/flowers/summary'),
        API.get('/api/flowers/me?year=' + nowY).catch(() => ({ count: 0, month: 0, year: 0, bimonth: 0, bimonthAdj: 0, dissemB: 0, pdcaB: 0, rrjB: 0, quizB: 0, dissem: 0, pdca: 0, rrj: 0, quiz: 0, adjust: 0, adjustments: [] })),
        API.get('/api/flowers/adjust-board').catch(() => []),
        API.get('/api/flowers/bimonth?year=' + nowY).catch(() => []),
      ]);
      const isLeader = App.user && ['chief', 'dean'].includes(App.user.role);
      let mode = 'bimonth'; // 默认打开「质量双月」榜单（页签亦排第一）

      // 月冠军结算权限：院长 / 系统管理员 / 专总（与后端 POST /settle-month 一致）
      const canSettle = App.user && (['admin', 'dean', 'chief'].includes(App.user.role) || ['admin', 'dean', 'chief'].some(r => (App.user.extraRoles || []).includes(r)));
      // 特权用户（院长/系统管理员/专总）加载时自动结算上月月冠军（幂等）。
      // 为避免反复进入管理页反复发请求，加「当天只结算一次」节流（结算结果不变，下次刷新体现）。
      if (canSettle) {
        const _today = new Date().toISOString().slice(0, 10);
        if (Pages._lastSettleDate !== _today) {
          Pages._lastSettleDate = _today;
          API.post('/api/flowers/settle-month').catch(() => {});
        }
      }
      const mgrBtnHtml = (canAdjust ? `<button class="btn btn-block btn-lg mt8" onclick="location.hash='#/flower-adjust'">⚖️ 红花奖惩管理（授予 / 减扣）</button>` : '')
        + (canSettle ? `<button class="btn btn-block btn-lg mt8 btn-settle" id="btn-settle-month">🏆 结算上月月冠军</button>` : '');

      // 顶部个人结算卡：随切换页签（按月/按年度/按奖惩）联动展示对应周期的「我的小红花」
      const personalCardHtml = (m) => {
        if (m === 'bimonth') {
          const dissemB = me.dissemB || 0, pdcaB = me.pdcaB || 0, rrjB = me.rrjB || 0, quizB = me.quizB || 0;
          const bAdj = me.bimonthAdj || 0;
          return `
          <div class="flower-settle" onclick="location.hash='#/my-flowers'">
            <div class="settle-total">🏵️ ${me.bimonth || 0} <span>我的小红花（${nowY} 年 9–10 月 质量双月）</span></div>
            <div class="settle-sub">📢 宣贯 ${dissemB} · 📋 PDCA ${pdcaB} · 🎤 人人讲 ${rrjB} · 🧪 测验 ${quizB} · ⚖️ 奖惩 ${bAdj > 0 ? '+' : ''}${bAdj}</div>
            ${isLeader ? '<div class="text-muted" style="font-size:var(--fs-t5);margin-top:4px">您为院领导，不参与小红花统计</div>' : ''}
          </div>`;
        }
        if (m === 'reward') {
          return `
          <div class="flower-settle">
            <div class="settle-total">⚖️ ${me.adjust > 0 ? '+' : ''}${me.adjust} <span>我的质量工作奖惩（净）</span></div>
            <div class="settle-sub">${isLeader ? '您为院领导，不参与小红花统计' : '「按月 / 按年度」页签查看本月、本年小红花'}</div>
          </div>`;
        }
        const isYear = m === 'year';
        const dissem = isYear ? (me.dissemY || 0) : (me.dissemM || 0);
        const pdca = isYear ? (me.pdcaY || 0) : (me.pdcaM || 0);
        const rrj = isYear ? (me.rrjY || 0) : (me.rrjM || 0);
        const quizv = isYear ? (me.quizY || 0) : (me.quizM || 0);
        const adjv = isYear ? (me.adjustY || 0) : (me.adjustM || 0);
        const total = isYear ? (me.year || 0) : (me.month || 0);
        return `
        <div class="flower-settle" onclick="location.hash='#/my-flowers'">
          <div class="settle-total">🏵️ ${total} <span>我的小红花（${isYear ? '本年' : '本月'}）</span></div>
          <div class="settle-sub">📢 宣贯 ${dissem} · 📋 PDCA ${pdca} · 🎤 人人讲 ${rrj} · 🧪 测验 ${quizv} · ⚖️ 奖惩 ${adjv > 0 ? '+' : ''}${adjv}</div>
          ${isYear && me.champions ? `<div class="settle-sub">👑 月冠军 ×${me.champions}（历年累计）</div>` : ''}
          ${isLeader ? '<div class="text-muted" style="font-size:var(--fs-t5);margin-top:4px">您为院领导，不参与小红花统计</div>' : ''}
        </div>`;
      };

      // 四个切换页签（质量双月 / 按月 / 按年度 / 按奖惩），结构统一
      const tabsHtml = () => `
        <div class="flower-tabs">
          <button class="ftab ${mode === 'bimonth' ? 'active' : ''}" data-flower-mode="bimonth">质量双月</button>
          <button class="ftab ${mode === 'month' ? 'active' : ''}" data-flower-mode="month">按月</button>
          <button class="ftab ${mode === 'year' ? 'active' : ''}" data-flower-mode="year">按年度</button>
          <button class="ftab ${mode === 'reward' ? 'active' : ''}" data-flower-mode="reward">按奖惩</button>
        </div>`;
      const bindTabs = () => {
        document.querySelectorAll('[data-flower-mode]').forEach(btn => {
          btn.onclick = () => {
            const nm = btn.getAttribute('data-flower-mode');
            if (nm === mode) return;
            mode = nm;
            if (nm === 'reward') renderReward();
            else if (nm === 'bimonth') renderBimonth();
            else renderByMode(nm);
          };
        });
      };

      // 统一外壳：个人卡 + 管理入口 + 标题 + 页签 + 引导 + 列表
      const renderShell = (m, intro, listHtml) => {
        const body = document.getElementById('flowers-body');
        body.innerHTML = personalCardHtml(m) + mgrBtnHtml + `
          <div class="card-title">${m === 'reward' ? '质量工作奖惩榜' : (m === 'bimonth' ? '质量双月排行榜' : '小红花排行榜')}</div>
          ${tabsHtml()}
          <p class="text-muted" style="font-size:var(--fs-t5);margin:0 2px 12px">${intro}</p>
          ${listHtml}`;
        bindTabs();
        const sb = document.getElementById('btn-settle-month');
        if (sb) sb.onclick = () => {
          sb.disabled = true; sb.textContent = '结算中…';
          API.post('/api/flowers/settle-month').then(() => { UI.toast('上月月冠军已结算'); })
            .catch(e => UI.toast(e.message || '结算失败'))
            .finally(() => { location.reload(); });
        };
      };

      // 按月 / 按年度：排行逻辑完全一致，仅排序指标与展示周期切换
      // 每行仅展示「当前周期」的 宣贯 / PDCA / 人人讲 / 测验 / 质量工作奖惩 五项，不再并列展示本月/本年总数
      const renderByMode = (m) => {
        const isYear = m === 'year';
        const metric = isYear ? 'year' : 'month';
        const sorted = list.slice().sort((a, b) =>
          (b[metric] - a[metric]) || (b.count - a.count) || (a.userName < b.userName ? -1 : 1));
        // 竞争排名：指标相同则名次相同（如 5,5,3 → 第1,第1,第3）
        let rank = 0, prevKey = null;
        const ranked = sorted.map((x, i) => {
          const key = x[metric];
          if (i === 0 || key !== prevKey) { rank = i + 1; prevKey = key; }
          return Object.assign({}, x, { rank, metricVal: key });
        });
        const rankCount = {};
        ranked.forEach(x => { rankCount[x.rank] = (rankCount[x.rank] || 0) + 1; });
        const html = ranked.length ? ranked.map((x) => {
          // 仅当「指标>0」才授牌/编号；指标为 0（如新月份尚未产生）显示「—」，避免全员金牌
          const isMonthLeader = (!isYear) && x.rank === 1 && x.metricVal > 0;
          const medalsCls = ['gold', 'silver', 'bronze'];
          let medal;
          if (x.metricVal <= 0) medal = '—';
          else if (isMonthLeader) medal = '⭐';
          else if (x.rank <= 3) medal = `<span class="medal ${medalsCls[x.rank - 1]}">${x.rank}</span>`;
          else medal = x.rank;
          const tie = (x.metricVal > 0 && rankCount[x.rank] > 1) ? '<span class="badge badge-tie">并列</span>' : '';
          // 按年榜：每人展示历史累计「月冠军」次数 👑×N（每月结束自动结算写入）
          const champBadge = (isYear && x.champions > 0) ? `<span class="badge badge-crown">👑×${x.champions}</span>` : '';
          const leaderBadge = isMonthLeader ? '<span class="badge badge-lead">⭐ 本月领先</span>' : '';
          const dissem = isYear ? (x.dissemY || 0) : (x.dissemM || 0);
          const pdca = isYear ? (x.pdcaY || 0) : (x.pdcaM || 0);
          const rrj = isYear ? (x.rrjY || 0) : (x.rrjM || 0);
          const quiz = isYear ? (x.quizY || 0) : (x.quizM || 0);
          const adjv = isYear ? (x.adjustY || 0) : (x.adjustM || 0);
          const total = x[metric];
          return `
          <div class="list-item reward-card">
            <div class="reward-main flower-row reward-row">
              <div class="flower-rank">${medal}</div>
              <div class="li-head" style="flex:1;min-width:0;margin-bottom:0">
                <div class="li-title">${esc(x.userName)} ${tie} ${leaderBadge} ${champBadge}</div>
              </div>
              <div class="flower-count">🏵️ ${total}</div>
            </div>
            <div class="rank-summary"><span>📢 宣贯 ${dissem}</span><span>📋 PDCA ${pdca}</span><span>🎤 人人讲 ${rrj}</span><span>🧪 测验 ${quiz}</span><span>⚖️ 奖惩 ${adjv > 0 ? '+' : ''}${adjv}</span></div>
          </div>`;
        }).join('')
          : '<div class="empty"><div class="ei">🌸</div><div class="et">还没有小红花</div><div class="es">去发布质量宣贯、闭环 PDCA 或请专总/院长精选人人讲吧～</div></div>';
        const intro = isYear
          ? '当前按「年度」统计：展示每人本年累计的 宣贯 / PDCA / 人人讲 / 测验 / 质量工作奖惩 五项小红花。质量宣贯审核通过 +3 🏵️（室主任发布 +1）；人人讲院选 +3 🏵️；普通 PDCA 闭环 +2 🏵️；检验池测验不自动发花，由管理员经「质量工作奖惩」手动加花；院长可基于额外理由授予/减扣。姓名后的 👑×N 为该人历年累计「月冠军」次数（每月结束自动结算）。'
          : '当前按「月」统计：展示每人 ' + nowY + ' 年 ' + nowM + ' 月 的 宣贯 / PDCA / 人人讲 / 测验 / 质量工作奖惩 五项小红花。当月成分为 0 表示暂未产生；当月领先者标记为「本月领先」⭐（月冠军于每月 1 号结算后明确为 👑）。';
        renderShell(m, intro, html);
      };

      // 按奖惩：按净奖惩从加分到减分排列，展开每人的逐条加减分（仅原因 + 花数，不含操作人与时间）
      const renderReward = () => {
        const html = board.length ? board.map((p, i) => {
          const recs = p.records.map(r => `
            <div class="adj-line">
              <span class="flower-count ${r.delta > 0 ? 'pos' : 'neg'}">${r.delta > 0 ? '+' : ''}${r.delta}</span>
              <span class="adj-reason">${esc(r.reason)}</span>
            </div>`).join('');
          return `
          <div class="list-item reward-card">
            <div class="reward-main flower-row reward-row">
              <div class="flower-rank">${i + 1}</div>
              <div class="li-head" style="flex:1;min-width:0;margin-bottom:0">
                <div class="li-title">${esc(p.userName)}</div>
              </div>
              <div class="flower-count reward-count">⚖️ ${p.adjust > 0 ? '+' : ''}${p.adjust}</div>
            </div>
            ${recs ? `<div class="adj-records">${recs}</div>` : ''}
          </div>`;
        }).join('')
          : '<div class="empty"><div class="ei">📑</div><div class="et">暂无质量工作奖惩记录</div></div>';
        const intro = '按「质量工作奖惩」净额从加分到减分排列；下方每项含原因与花数。当前共 ' + board.length + ' 人有奖惩记录。';
        renderShell('reward', intro, html);
      };

      // 质量双月：统计当年 8 月 + 9 月小红花数量的总和排名（含宣贯/PDCA/人人讲/测验/质量工作奖惩五项）
      const renderBimonth = () => {
        const metric = 'bimonth';
        const sorted = (bimonth || []).slice().sort((a, b) =>
          (b[metric] - a[metric]) || (b.count - a.count) || (a.userName < b.userName ? -1 : 1));
        // 竞争排名：指标相同则名次相同
        let rank = 0, prevKey = null;
        const ranked = sorted.map((x, i) => {
          const key = x[metric];
          if (i === 0 || key !== prevKey) { rank = i + 1; prevKey = key; }
          return Object.assign({}, x, { rank, metricVal: key });
        });
        const rankCount = {};
        ranked.forEach(x => { rankCount[x.rank] = (rankCount[x.rank] || 0) + 1; });
        const html = ranked.length ? ranked.map((x) => {
          const medalsCls = ['gold', 'silver', 'bronze'];
          let medal;
          if (x.metricVal <= 0) medal = '—';
          else if (x.rank <= 3) medal = `<span class="medal ${medalsCls[x.rank - 1]}">${x.rank}</span>`;
          else medal = x.rank;
          const tie = (x.metricVal > 0 && rankCount[x.rank] > 1) ? '<span class="badge badge-tie">并列</span>' : '';
          // 已结算双月冠军 → 👑 质量双月冠军；未结算前的实时第一 → ⭐ 双月领先（与月冠军逻辑一致：结算后才明确夺冠）
          const isBiLeader = x.rank === 1 && x.metricVal > 0;
          let leaderBadge = '';
          if (x.bimonthChampion) leaderBadge = '<span class="badge badge-crown">👑 质量双月冠军</span>';
          else if (isBiLeader) leaderBadge = '<span class="badge badge-lead">⭐ 双月领先</span>';
          const dissem = x.dissem || 0;
          const pdca = x.pdca || 0;
          const rrj = x.rrj || 0;
          const quiz = x.quiz || 0;
          const adjv = x.adjust || 0;
          const total = x[metric];
          return `
          <div class="list-item reward-card">
            <div class="reward-main flower-row reward-row">
              <div class="flower-rank">${medal}</div>
              <div class="li-head" style="flex:1;min-width:0;margin-bottom:0">
                <div class="li-title">${esc(x.userName)} ${tie} ${leaderBadge}</div>
              </div>
              <div class="flower-count">🏵️ ${total}</div>
            </div>
            <div class="rank-summary"><span>📢 宣贯 ${dissem}</span><span>📋 PDCA ${pdca}</span><span>🎤 人人讲 ${rrj}</span><span>🧪 测验 ${quiz}</span><span>⚖️ 奖惩 ${adjv > 0 ? '+' : ''}${adjv}</span></div>
          </div>`;
        }).join('')
          : '<div class="empty"><div class="ei">🌸</div><div class="et">' + nowY + ' 年 9–10 月还没有小红花记录</div><div class="es">双月评优将在月底自动汇总</div></div>';
        const intro = '当前为「质量双月」榜单：统计 ' + nowY + ' 年 9 月与 10 月小红花数量的总和排名（含 宣贯 / PDCA / 人人讲 / 测验 / 质量工作奖惩 五项）。质量双月是一年中最核心的"质量月"活动期，双月合计最高者即为 👑 质量双月冠军（每年 11 月 1 日结算 10 月时一并结算）。';
        renderShell('bimonth', intro, html);
      };

      // 首次渲染：按当前 mode 分发（默认 bimonth = 质量双月）
      if (mode === 'reward') renderReward();
      else if (mode === 'bimonth') renderBimonth();
      else renderByMode(mode);
    } catch (e) { UI.toast(e.message); }
  }
  Pages.flowers = flowers;

  // ─── 我的小红花结算界面（所有人）─────────────
  Pages.myFlowers = async () => {
    app().innerHTML = `
      ${topbar('我的小红花', { back: true })}
      <div class="page" id="my-flowers-body"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>
      ${tabbar((App.caps.canDesign || App.caps.canManage) ? 'admin' : 'home')}`;
    try {
      const me = await API.get('/api/flowers/me');
      const body = document.getElementById('my-flowers-body');
      const rfMeta = { dissem: { icon: '📢', label: '质量宣贯' }, pdca: { icon: '📋', label: 'PDCA 闭环' }, rrj: { icon: '🎤', label: '人人讲院选' }, quiz: { icon: '🧪', label: '测验' } };
      const nowY = new Date().getFullYear();
      const nowM = new Date().getMonth() + 1;
      const monthPrefix = nowY + '-' + String(nowM).padStart(2, '0');
      // 记录区周期范围：month=本月（剔除上个月及更早） / year=本年 / all=全部
      let recordScope = 'month';
      const rfItemHtml = (r) => {
        const m = rfMeta[r.kind] || { icon: '🏵️', label: '小红花' };
        return `
        <div class="list-item adj-item">
          <div class="li-head" style="flex:1;min-width:0">
            <div class="li-title">${m.icon} ${m.label}</div>
            <div class="li-meta"><span>📝 ${esc(r.ref_title || m.label)}</span></div>
            <div class="li-meta"><span>${esc(r.created_at)}</span></div>
          </div>
          <div class="flower-count pos">+${r.amount}</div>
        </div>`;
      };
      const adjItemHtml = (a) => `
        <div class="list-item adj-item">
          <div class="li-head" style="flex:1;min-width:0">
            <div class="li-title">${a.delta > 0 ? '➕ 授予' : '➖ 减扣'} ${Math.abs(a.delta)} 🏵️ <span class="badge badge-adjust">质量工作奖惩</span></div>
            <div class="li-meta"><span>📝 ${esc(a.reason)}</span></div>
            <div class="li-meta"><span>👤 ${esc(a.operator_name)}</span><span>${esc(a.created_at)}</span></div>
          </div>
          <div class="flower-count ${a.delta > 0 ? 'pos' : 'neg'}">${a.delta > 0 ? '+' : ''}${a.delta}</div>
        </div>`;
      const inScope = (ts) => {
        if (recordScope === 'all') return true;
        if (!ts) return false;
        return recordScope === 'month' ? String(ts).startsWith(monthPrefix) : String(ts).startsWith(String(nowY));
      };
      const renderRecords = () => {
        const rfItems = (me.redflowers || []).filter(r => inScope(r.created_at));
        const adjItems = (me.adjustments || []).filter(a => inScope(a.created_at));
        const rfHtml = rfItems.map(rfItemHtml).join('');
        const adjHtml = adjItems.map(adjItemHtml).join('');
        const recordsHtml = (rfHtml || adjHtml) ? (rfHtml + adjHtml) : '<div class="empty"><div class="ei">🌸</div><div class="et">暂无小红花记录</div><div class="es">参与质量工作即可获得小红花</div></div>';
        const wrap = document.getElementById('my-records-wrap');
        if (wrap) wrap.innerHTML = recordsHtml;
        document.querySelectorAll('[data-rec-scope]').forEach(b => b.classList.toggle('active', b.getAttribute('data-rec-scope') === recordScope));
      };
      body.innerHTML = `
        <div class="flower-settle">
          <div class="settle-total">🏵️ ${me.count} <span>总红花</span></div>
          <div class="settle-sub">本月 ${me.month} · 本年 ${me.year}</div>
        </div>
        <div class="card-title">构成明细</div>
        <div class="settle-breakdown">
          <div class="sb-item"><div class="sb-num">📢 ${me.dissem}</div><div class="sb-label">质量宣贯</div></div>
          <div class="sb-item"><div class="sb-num">📋 ${me.pdca}</div><div class="sb-label">PDCA 闭环</div></div>
          <div class="sb-item"><div class="sb-num">🎤 ${me.rrj}</div><div class="sb-label">人人讲院选</div></div>
          <div class="sb-item"><div class="sb-num">🧪 ${me.quiz}</div><div class="sb-label">测验</div></div>
          <div class="sb-item"><div class="sb-num">⚖️ ${me.adjust > 0 ? '+' : ''}${me.adjust}</div><div class="sb-label">质量工作奖惩</div></div>
        </div>
        <div class="records-head">
          <div class="card-title" style="margin-top:16px">我的小红花记录</div>
          <div class="rec-scope-tabs">
            <button class="rstab ${recordScope === 'month' ? 'active' : ''}" data-rec-scope="month">本月</button>
            <button class="rstab ${recordScope === 'year' ? 'active' : ''}" data-rec-scope="year">本年</button>
            <button class="rstab ${recordScope === 'all' ? 'active' : ''}" data-rec-scope="all">全部</button>
          </div>
        </div>
        <div id="my-records-wrap"></div>`;
      renderRecords();
      document.querySelectorAll('[data-rec-scope]').forEach(b => b.onclick = () => {
        recordScope = b.getAttribute('data-rec-scope');
        renderRecords();
      });
    } catch (e) { UI.toast(e.message); }
  };

  // ─── 红花奖惩管理（仅院长/系统管理员）────────
  Pages.flowerAdjust = async () => {
    if (!(App.user && (App.user.role === 'admin' || App.user.role === 'dean' || (App.user.extraRoles || []).includes('admin') || (App.user.extraRoles || []).includes('dean')))) { location.hash = '#/flowers'; return; }
    app().innerHTML = `
      ${topbar('红花奖惩管理', { back: true })}
      <div class="page" id="adj-body"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>
      ${tabbar('admin')}`;
    try {
      const [users, records, eligibleIds] = await Promise.all([
        API.get('/api/admin/users?active=1'),
        API.get('/api/flowers/adjustments').catch(() => []),
        API.get('/api/flowers/eligible-ids').catch(() => []),
      ]);
      // 排除 专总/院长/管理员（不参与小红花），但例外白名单（经指定的专总）仍可选
      const EXCLUDE = ['chief', 'dean', 'chief_engineer', 'admin', 'leader'];
      const targets = (users || []).filter(u => u.id != null && ((u.role && !EXCLUDE.includes(u.role)) || eligibleIds.includes(u.id)));
      const body = document.getElementById('adj-body');
      body.innerHTML = `
        <div class="card-title">红花奖惩（仅院长 / 系统管理员）</div>
        <p class="text-muted" style="font-size:var(--fs-t5);margin:0 2px 12px">基于额外理由授予或减扣小红花；专总/院长/总工/系统管理员一般不参与，个别经指定的专总（×××、×××、×××）可参与。增减计入对方排行榜与个人结算，并备注「质量工作奖惩」。</p>
        <div class="field">
          <label>选择人员</label>
          <select id="adj-user" class="input">
            <option value="">— 请选择 —</option>
            ${targets.map(u => `<option value="${u.id}|${esc(u.realName)}">${esc(u.realName)}（${esc(UI.roleLabel(u))}）</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>增减数量（正=授予，负=减扣）</label>
          <div class="adj-num-row">
            <button class="adj-step" data-d="-1">−1</button>
            <button class="adj-step" data-d="-2">−2</button>
            <button class="adj-step" data-d="-3">−3</button>
            <input id="adj-delta" class="input adj-num" type="number" value="1">
            <button class="adj-step" data-d="1">+1</button>
            <button class="adj-step" data-d="2">+2</button>
            <button class="adj-step" data-d="3">+3</button>
          </div>
        </div>
        <div class="field">
          <label>原因（必填）</label>
          <textarea id="adj-reason" class="input" rows="3" placeholder="如：配合质量月活动组织 +3；图纸复查延误 −2"></textarea>
        </div>
        <button class="btn btn-block btn-lg" id="adj-submit">提交奖惩</button>
        <div class="card-title" style="margin-top:18px">近期奖惩记录</div>
        <div id="adj-records">${records && records.length ? records.map(r => `
          <div class="list-item adj-item">
            <div class="li-head" style="flex:1;min-width:0">
              <div class="li-title">${esc(r.target_name)} ${r.delta > 0 ? '➕' : '➖'} ${Math.abs(r.delta)} 🏵️</div>
              <div class="li-meta"><span>📝 ${esc(r.reason)}</span></div>
              <div class="li-meta"><span>👤 ${esc(r.operator_name)}</span><span>${esc(r.created_at)}</span></div>
            </div>
            <div class="flower-count ${r.delta > 0 ? 'pos' : 'neg'}">${r.delta > 0 ? '+' : ''}${r.delta}</div>
          </div>`).join('') : '<div class="empty"><div class="ei">🔧</div><div class="et">暂无调整记录</div></div>'}</div>
      `;
      body.querySelectorAll('.adj-step').forEach(b => b.onclick = () => {
        const cur = parseInt(document.getElementById('adj-delta').value, 10) || 0;
        document.getElementById('adj-delta').value = cur + parseInt(b.getAttribute('data-d'), 10);
      });
      document.getElementById('adj-submit').onclick = async () => {
        const sel = document.getElementById('adj-user').value;
        if (!sel) return UI.toast('请选择人员');
        const [uid, uname] = sel.split('|');
        const delta = parseInt(document.getElementById('adj-delta').value, 10);
        const reason = document.getElementById('adj-reason').value.trim();
        if (!delta || delta === 0) return UI.toast('增减数量不能为 0');
        if (!reason) return UI.toast('请填写原因');
        try {
          UI.loading(true);
          await API.post('/api/flowers/adjust', { targetUserId: parseInt(uid, 10), targetName: uname, delta, reason });
          UI.toast('已提交奖惩');
          Pages.flowerAdjust();
        } catch (e) { UI.toast(e.message); }
        finally { UI.loading(false); }
      };
    } catch (e) { UI.toast(e.message); }
  };

  // ─── 人人讲院选（专总/院长精选）────────────────
  Pages.toggleRrj = async (id, checked) => {
    try {
      UI.loading(true);
      const r = await API.post('/api/pdca/problems/' + id + '/select-rrj', { selected: checked });
      UI.toast(r.message);
      admin(); // 刷新管理页（重算小红花与院选状态）
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // 人人讲「不选」：标记该候选为不选（从待选栏目消失）；rejected=false 用于撤销（重新纳入候选）
  Pages.rrjReject = async (id, rejected = true) => {
    try {
      UI.loading(true);
      const r = await API.post('/api/pdca/problems/' + id + '/rrj-reject', { rejected });
      UI.toast(r.message);
      admin();
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ─── 管理者调整院选候选的专业/地区/类型 + 备注 ───────────────
  function rrjParseArr(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string' && x) { try { const v = JSON.parse(x); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
    return [];
  }
  Pages.rrjCandidateEdit = async (id) => {
    try {
      UI.loading(true);
      const [p, dv] = await Promise.all([
        API.get('/api/pdca/problems/' + id),
        API.get('/api/divisions').catch(() => ({ divisions: [], divisionSubs: {} })),
      ]);
      UI.loading(false);
      const divisions = (dv.divisions || []).map(d => String(d).replace(/室$/, ''));
      const subs = dv.divisionSubs || {};
      const selDiv = rrjParseArr(p.divisions);
      const selSub = rrjParseArr(p.sub_divisions);
      const regions = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
      const cats = ['标准规范', '质量要求', '优秀经验', '惨痛教训', '质量问答'];
      UI.modal('调整专业/地区/类型 · 院选备注', `
        <div class="field"><label>一级专业（可多选，勾选后可展开二级）</label><div class="filter-chks" id="rrj-div-wrap">${UI.subDivCascadingMulti(divisions, subs, selDiv, selSub, 'rrjDiv')}</div></div>
        <div class="field"><label>地区</label><select class="select" id="rrj-region">${regions.map(r => `<option value="${r}" ${(p.region || '') === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div class="field"><label>类型</label><select class="select" id="rrj-cat">${cats.map(c => `<option value="${c}" ${(p.category || '') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>备注</label><textarea class="textarea" id="rrj-note" placeholder="可选：给该人人讲帖的批注">${esc(p.manager_note || '')}</textarea></div>
        <p class="text-muted" style="font-size:var(--fs-t5)">调整仅影响列表 / 首页筛选分类与院选备注，不会改动已同步 IMA 的内容。</p>
        <button class="btn btn-block" id="rrj-save">保存调整</button>
      `, (mask, close) => {
        // 级联多选：勾选一级专业时，若该专业有二级，其下才展开二级勾选项
        const wrap = mask.querySelector('#rrj-div-wrap');
        if (wrap) wrap.querySelectorAll('input.casc-major').forEach(cb => {
          cb.addEventListener('change', () => {
            const major = cb.dataset.major;
            const subsWrap = wrap.querySelector('.casc-subs[data-major="' + (window.CSS && CSS.escape ? CSS.escape(major) : major) + '"]');
            if (cb.checked) {
              if (!subsWrap) {
                const div = document.createElement('div');
                div.className = 'casc-subs';
                div.dataset.major = major;
                div.innerHTML = UI.subDivCascadingSubsHtml(major, subs, [], 'rrjDiv');
                cb.closest('label').insertAdjacentElement('afterend', div);
              }
            } else if (subsWrap) {
              subsWrap.querySelectorAll('input[data-sub]').forEach(s => { s.checked = false; });
              subsWrap.remove();
            }
          });
        });
        mask.querySelector('#rrj-save').onclick = async () => {
          const { divisions: dSel, subDivisions: sSel } = UI.collectSubDivCascading(wrap);
          const body = {
            divisions: dSel, subDivisions: sSel,
            region: mask.querySelector('#rrj-region').value,
            category: mask.querySelector('#rrj-cat').value,
            note: mask.querySelector('#rrj-note').value.trim(),
          };
          try {
            UI.loading(true);
            const r = await API.put('/api/pdca/problems/' + id + '/note', body);
            UI.loading(false);
            UI.toast(r.message || '已保存');
            close();
            admin();
          } catch (e) { UI.loading(false); UI.toast(e.message); }
        };
      });
    } catch (e) { UI.loading(false); UI.toast(e.message); }
  };

  Pages.createUser = () => {
    UI.modal('新建账号', `
      <div class="field"><label>用户名(登录用)<span class="req">*</span></label><input class="input" id="cu-username" placeholder="如拼音首字母 zhangsan"></div>
      <div class="field"><label>真实姓名<span class="req">*</span></label><input class="input" id="cu-name"></div>
      <div class="field"><label>角色</label><select class="select" id="cu-role"><option value="designer">设计师</option><option value="section_leader">室主任（管理+设计）</option><option value="chief">专总</option><option value="chief_engineer">总工（资深专家，仅专总/院长可邀请）</option><option value="dean">院长</option><option value="admin">系统管理员</option><option value="expert">专家（仅答疑，无管理权限）</option></select></div>
      <div class="field"><label>职务标签</label><input class="input" id="cu-title" placeholder="如：专总/室主任（选填）"></div>
      <div class="field"><label>科室</label><input class="input" id="cu-dept" placeholder="如：建筑室"></div>
      <p class="text-muted" style="font-size:var(--fs-t5);margin-bottom:12px">初始密码统一为 ChangeMe123!，用户首次登录须修改</p>
      <button class="btn btn-block" id="cu-submit">创建账号</button>
    `, (mask, close) => {
      mask.querySelector('#cu-submit').onclick = async () => {
        const username = mask.querySelector('#cu-username').value.trim();
        const realName = mask.querySelector('#cu-name').value.trim();
        if (!username || !realName) return UI.toast('用户名和姓名必填');
        try { UI.loading(true);
          const res = await API.post('/api/admin/users', { users: [{ username, realName, role: mask.querySelector('#cu-role').value, titleTag: mask.querySelector('#cu-title').value, department: mask.querySelector('#cu-dept').value }] });
          if (res.errors && res.errors.length) return UI.toast(res.errors[0].error);
          close(); UI.toast('账号已创建'); admin();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };
  Pages.resetPwd = async (el) => {
    const id = el.getAttribute('data-uid');
    const name = el.getAttribute('data-name') || '';
    if (!(await UI.confirm(`确定重置 ${name} 的密码为 ChangeMe123!？`))) return;
    try { UI.loading(true); await API.put(`/api/admin/users/${id}/reset-pwd`, {}); UI.toast('密码已重置为 ChangeMe123!'); admin(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };
  Pages.toggleUser = async (id) => {
    try { UI.loading(true); const r = await API.put(`/api/admin/users/${id}/toggle-active`, {}); UI.toast(r.message); admin(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 管理页：宣贯审核（审批）─────────────────
  const parseArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const remindTypeBadge = (t) => {
    const m = { '校审': 'badge-urgent', '提资': 'badge-dept', '要点': 'badge-normal' };
    const c = m[t] || '';
    return `<span class="badge ${c}">${UI.esc(t || '通用')}</span>`;
  };
  async function loadAdminReview(el, cntEl) {
    if (!App.caps.canManage || !el) return;
    try {
      const list = await API.get('/api/quality-dissem/pending');
      if (cntEl) cntEl.textContent = list.length;
      // 同步导航卡徽标（列表真实加载完成后的数量才是准的；标题行本身已隐藏）
      const nb = document.getElementById('adm-badge-review');
      if (nb) { nb.textContent = list.length; nb.style.display = list.length ? '' : 'none'; }
      el.innerHTML = list.length ? list.map(d => `
        <div class="ann-card" style="border-left:3px solid #f0a020">
          <div class="li-head"><div class="li-title">${esc(d.title)}</div></div>
          <div class="li-meta">${d.category ? `<span class="tag">${esc(d.category)}</span>` : ''}${parseArr(d.divisions).length ? `<span>🏢 ${parseArr(d.divisions).map(esc).join(' / ')}</span>` : '<span>🏢 全院</span>'}${parseArr(d.regions).length ? `<span>📍 ${parseArr(d.regions).map(esc).join(' / ')}</span>` : ''}</div>
          <div class="li-desc">${esc(d.content)}</div>
          <div class="li-meta"><span>✍️ ${esc(d.publisher || '')}</span></div>
          <div class="row-btns mt8">
            ${App.caps.isGuest ? '<span class="text-muted">（只读，无审核权限）</span>' : `<button class="btn btn-sm btn-primary" onclick="Pages.approveDissem(${d.id})">通过并放出</button>
            <button class="btn btn-sm btn-outline" onclick="Pages.rejectDissem(${d.id})">驳回</button>`}
          </div>
        </div>`).join('') : '<div class="empty"><div class="ei">📝</div><div class="et">暂无待审核宣贯</div></div>';
    } catch (e) { el.innerHTML = ''; }
  }

  // ── 管理页：PDCA 待办（仅 PDCA 流程类提醒，纯消息在「我的」）─────────────────
  async function loadAdminInbox(el, cntEl) {
    if (!el) return;
    try {
      const inbox = await API.get('/api/reminders/inbox');
      // 只保留 PDCA 流程相关（related_problem_id 非空）；纯人发消息不在此显示
      // 排除「自己发给自己」的提醒（自问自答护栏，双保险）
      const pending = inbox.filter(r => r.state !== 'done' && r.related_problem_id && r.sender_name !== App.user.realName);
      if (cntEl) cntEl.textContent = pending.length;
      // 同步导航卡徽标 + 高亮（0 条时取消 hl，避免「无待办却高亮」）
      const nb = document.getElementById('adm-badge-inbox');
      if (nb) { nb.textContent = pending.length; nb.style.display = pending.length ? '' : 'none'; }
      const navRowEl = document.querySelector('.adm-row[data-sec="sec-inbox"]');
      if (navRowEl) navRowEl.classList.toggle('hl', pending.length > 0);
      el.innerHTML = pending.length ? pending.map(r => `
        <div class="remind-item">
          <div class="li-head"><div class="li-title">${esc(r.title || '（无标题）')}</div></div>
          ${r.content ? `<div class="li-desc">${esc(r.content)}</div>` : ''}
          <div class="li-meta"><span>📤 ${esc(r.sender_name)}</span></div>
          <div class="row-btns mt8">
            <button class="btn btn-sm btn-primary" onclick="Pages.openReminderTarget(${r.id}, ${r.related_problem_id})">点击处理</button>
            <button class="btn btn-sm btn-outline" onclick="Pages.reminderDone(${r.id})">标记完成</button>
          </div>
        </div>`).join('') : '<div class="empty"><div class="ei">🔍</div><div class="et">暂无 PDCA 待办</div></div>';
    } catch (e) { el.innerHTML = ''; }
  }

  // 院长专属：最近活跃（名字 + 最近活跃时间；最近活跃含 token 续期进来的使用，反映真实情况）
  // 后端一次返回近 30 天全量；前端默认折叠展示近 7 天，点击"展开近 30 天"显示完整列表。
  async function loadLoginActivity(el) {
    if (!el) return;
    const fmt = (t) => { const s = String(t || ''); return s.length >= 16 ? s.slice(0, 16) : s; };
    // 后端 datetime() 返回北京时间字符串 "YYYY-MM-DD HH:MM:SS"（已含秒）。
    // 只需补 +08:00 偏移解析；切勿再拼 ":00"，否则秒段重复变成非法时间，
    // 在 Safari / 微信 iOS WebView（JavaScriptCore 解析更严）下整段解析失败，
    // 导致"近 7 天"永远算空、默认只显示"最近一周暂无活跃记录"。
    const within7 = (t) => {
      const s = String(t || '').trim();
      if (s.length < 10) return false;
      let iso = s.replace(' ', 'T');
      if (!iso.includes('+') && !iso.includes('Z')) iso += '+08:00';
      const d = new Date(iso);
      if (isNaN(d)) return false;
      return (Date.now() - d.getTime()) <= 7 * 86400000;
    };
    const itemHtml = (x) => `
        <div class="list-item" style="cursor:default">
          <div class="li-head"><div class="li-title">${esc(x.name)}</div><span class="text-muted" style="font-size:var(--fs-t5)">@${esc(x.username)}</span></div>
          <div class="li-meta">
            <span>🟢 最近活跃：${esc(fmt(x.lastActiveAt))}</span>
            ${x.lastLoginAt && x.lastLoginAt !== x.lastActiveAt ? `<span class="text-muted">🔑 最后登入：${esc(fmt(x.lastLoginAt))}</span>` : ''}
          </div>
        </div>`;
    try {
      const data = await API.get('/api/admin/login-activity');
      const list = (data && data.list) || [];
      if (!list.length) {
        el.innerHTML = '<div class="empty"><div class="ei">📈</div><div class="et">最近一个月暂无活跃记录</div><div class="es">参与质量工作会记录在这里</div></div>';
        return;
      }
      const recent = list.filter(x => within7(x.lastActiveAt));
      const older = list.filter(x => !within7(x.lastActiveAt));
      el.innerHTML =
        (recent.length ? recent.map(itemHtml).join('') : '<div class="empty"><div class="ei">📈</div><div class="et">最近一周暂无活跃记录</div><div class="es">参与质量工作会记录在这里</div></div>') +
        (older.length ? `<div class="more-link" id="la-expand" style="margin:8px 0;cursor:pointer" onclick="Pages._expandLoginActivity()">展开近 30 天（含 ${older.length} 位更早活跃）▾</div><div id="la-older" style="display:none">${older.map(itemHtml).join('')}</div>` : '');
    } catch (e) { el.innerHTML = '<div class="load-fail"><div class="lf-t">登录动态加载失败</div><button class="btn btn-sm btn-gray lf-a" onclick="Pages.retryLoginActivity()">重试</button></div>'; }
  }
  Pages.retryLoginActivity = () => { const el = document.getElementById('login-activity-list'); if (el) loadLoginActivity(el); };

  // 展开"近 30 天"更早活跃列表
  Pages._expandLoginActivity = () => {
    const older = document.getElementById('la-older');
    const btn = document.getElementById('la-expand');
    if (!older) return;
    const hide = older.style.display !== 'none';
    older.style.display = hide ? 'none' : 'block';
    if (btn) btn.textContent = hide ? '展开近 30 天▾' : '收起▴';
  };

  // 挂载到 Pages
  Object.assign(Pages, { profile, admin });
})();

// ── IMA 同步状态横幅（主动感知：IMA Key 过期/失效时全局提示，弥补此前静默失败）──
(function () {
  function renderImaBanner() {
    try {
      // 该接口服务端挂了 authMiddleware（需登录），裸 fetch 不带令牌必 401，
      // 会导致横幅判断永远拿不到 status='fail' —— 即 IMA 监控在前端静默失效。
      // 故：未登录不发请求；已登录走 API.get（自动附 Bearer 令牌、统一异常处理）。
      if (!API.getToken()) return;
      API.get('/api/ima/status').then(d => {
        let el = document.getElementById('qcImaBanner');
        if (d && d.status === 'fail') {
          if (!el) {
            el = document.createElement('div');
            el.id = 'qcImaBanner';
            el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;font-size:var(--fs-t5);line-height:1.4;padding:8px 14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.25)';
            document.body.appendChild(el);
          }
          const when = d.last_check_at ? ('（' + d.last_check_at + '）') : '';
          el.textContent = '⚠️ IMA 知识库同步异常' + when + '：' + (d.last_error || '同步失败') + ' —— 多为 IMA Key 过期（有效期约1个月），需更新服务器 .env 的 IMA_CLIENT_ID/IMA_API_KEY 后 pm2 restart qc-app';
        } else if (el) {
          el.remove();
        }
      }).catch(() => {});
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderImaBanner);
  else renderImaBanner();
  window.addEventListener('hashchange', renderImaBanner); // 登录/切页后即时探测（登录往往伴随 hash 变化）
  setInterval(renderImaBanner, 5 * 60 * 1000);
})();
