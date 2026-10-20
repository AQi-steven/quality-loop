/**
 * 页面渲染器
 *
 * 每个函数返回 HTML 字符串或负责渲染到 #app
 * 页面：login / changePwd / home / profile / admin（report/tickets/ideas 等孤儿页已废弃移除）
 */

const Pages = (() => {
  // 防御：任何情况下都返回有效的 #app 元素（绝不 null），防止 HTML 解析异常导致白屏
  const app = () => {
    let el = document.getElementById('app');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  };
  const esc = UI.esc;

  // 质量宣贯栏目：查看端筛选（专业室 / 地区）。默认全看，选择持久化到 localStorage。
  const QC_REGIONS_HOME = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
  let dissemFilter = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('dissemFilter')) || {};
      raw.divisions = (raw.divisions || []).map(d => String(d).replace(/室$/, ''));
      raw.regions = (raw.regions || []).map(String);
      return raw;
    }
    catch (e) { return { divisions: [], regions: [] }; }
  })();
  function saveDissemFilter() {
    try { localStorage.setItem('dissemFilter', JSON.stringify(dissemFilter)); } catch (e) {}
  }
  // 首页「质量人人讲（院选）」版块的专业 / 地区筛选状态（与宣贯筛选同构）
  let rrjFilter = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('rrjFilter')) || {};
      raw.divisions = (raw.divisions || []).map(d => String(d).replace(/室$/, ''));
      raw.regions = (raw.regions || []).map(String);
      return raw;
    } catch (e) { return { divisions: [], regions: [] }; }
  })();
  function saveRrjFilter() {
    try { localStorage.setItem('rrjFilter', JSON.stringify(rrjFilter)); } catch (e) {}
  }
  let homeRrj = []; // 首页院选数据缓存，供筛选重渲染使用
  function parseArr(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

  // ─── 通用组件 ───────────────────────────────
  // 顶栏（方案A 2026-09-11「登录页与顶栏优化方案」§2）：对角渐变 + 右上装饰圆 + 半透白头像。
  // opts.tall：首页 64px，其余 56px；back/action 统一半透白胶囊样式。
  function topbar(title, opts = {}) {
    // 返回键：只在「二 / 三级页面」出现（opts.back）。一级栏目（底部 5 个 tab）一律不传 back。
    // 点击走 Pages.goUp()（确定性回上一层），不用 history.back() —— 后者会被 ui.js 的历史守卫记录
    // 吞掉，表现为「点了没反应」（详见 goUp 注释）。
    const back = opts.back ? `<span class="back" onclick="Pages.goUp()" aria-label="返回上一层">‹</span>` : '';
    const action = opts.action ? `<span class="action" onclick="${opts.action.onclick}">${opts.action.text}</span>` : '';
    // 头像：半透白圆 + 白色线条人形 SVG（替换原 👤 emoji，各机型渲染一致）
    const avatar = opts.noAvatar ? '' : `<span class="avatar-btn" onclick="location.hash='#/profile'"><svg class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="4" fill="#fff"/><path d="M4 20C4 15.5817 7.58172 12 12 12C16.4183 12 20 15.5817 20 20" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg><span class="avatar-badge" id="avatar-badge"></span></span>`;
    const cls = `topbar${opts.center ? ' center' : ''}${opts.tall ? ' tall' : ''}`;
    const html = `<div class="${cls}"><span class="ah-deco"></span>${back}<h1>${esc(title)}</h1>${action}${avatar}</div>`;
    return html;
  }

  // ── 返回上一层（确定性路由，用户 2026-09-15 裁定）──────────────
  // 背景：原来顶栏返回键写的是 history.back()。全站为拦住微信「边缘右滑退程序」在历史栈底压了
  // 一条守卫记录（ui.js initSwipeBack），在一级 tab 页点返回只会 pop 到守卫、什么都不发生 →
  // 用户体感「很多返回键没有作用」。故改为显式「上一层是谁」的映射，点了一定能退到对的地方。
  //
  // 页面层级（用户裁定：只有二级/三级才需要返回键，一级栏目不需要）：
  //   一级（底部 tab，无返回键）：#/home 首页 · #/pdca PDCA · #/work 质量库 · #/memo 质量专题（旧项目备忘数字深链仍兼容）· #/admin 管理评价
  //   二级： #/profile 个人中心 · #/change-pwd 修改密码 · #/flowers 小红花优秀榜 · #/my-flowers 我的小红花
  //   三级： #/flower-adjust 红花奖惩管理
  //   详情： #/pdca/<id>（回 PDCA）· #/memo/topic/<id>（回质量专题列表）· #/memo/<id>（旧项目备忘）
  const UP_MAP = {
    'profile': '#/home',            // 头像可从任意顶栏进入，统一回首页（唯一确定的上层）
    'change-pwd': '#/profile',      // 由「个人中心 → 修改密码」进入
    'flowers': '#/admin',           // 由「管理评价 → 小红花优秀榜」进入
    'my-flowers': '#/flowers',      // 由「小红花优秀榜 → 我的小红花」进入
    'flower-adjust': '#/flowers',   // 由「小红花优秀榜 → 红花奖惩管理」进入
  };
  function goUp() {
    const seg = String(location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    const page = seg[0] || '';
    const sub = seg[1] || '';
    // ① 二级详情路由（#/<栏目>/<id>）：回到该栏目的列表
    if (sub && page === 'pdca') { location.hash = '#/pdca'; return; }
    // 质量专题：#/memo（列表）、#/memo/topic/<id>（专题详情）、#/memo/schedule（项目工期）→ 都回专题列表
    if (sub && page === 'memo' && (sub === 'topic' || sub === 'schedule')) { location.hash = '#/memo'; return; }
    // 旧项目备忘详情 #/memo/<数字>：回旧项目列表（#/memo/legacy），不回已被改造的专题列表
    if (sub && page === 'memo') { location.hash = '#/memo/legacy'; return; }
    // ② 已知的「上一层」映射
    const up = UP_MAP[page];
    if (up) { location.hash = up; return; }
    // ③ 兜底：回首页 —— 保证任何情况都有去处，绝不「点了没反应」
    location.hash = '#/home';
  }

  // V3 §5 / 设计稿底部 tabbar（用户裁定 2026-09-11）：五个图标按设计稿重绘 ——
  // 首页＝纯房子轮廓（无内门）· PDCA＝文档三条横线 · 项目传递＝文件夹 · 质量库＝翻开的书 · 管理＝太阳放射
  const TAB_ICONS = {
    home:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 10.4 12 3.6l8.6 6.8v9.1a1.5 1.5 0 0 1-1.5 1.5H4.9a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
    pdca:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.8" width="14" height="18.4" rx="2.2"/><line x1="8.6" y1="8" x2="15.4" y2="8"/><line x1="8.6" y1="12" x2="15.4" y2="12"/><line x1="8.6" y1="16" x2="13.2" y2="16"/></svg>',
    memo:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    work:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7.2C10.4 5.9 8.1 5.2 5.4 5.2c-1 0-2 .1-2.7.3v12.3c.7-.2 1.7-.3 2.7-.3 2.7 0 5 .7 6.6 2 1.6-1.3 3.9-2 6.6-2 1 0 2 .1 2.7.3V5.5c-.7-.2-1.7-.3-2.7-.3-2.7 0-5 .7-6.6 2z"/><path d="M12 7.2v12.3"/></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4"/><line x1="12" y1="2.8" x2="12" y2="5.6"/><line x1="12" y1="18.4" x2="12" y2="21.2"/><line x1="2.8" y1="12" x2="5.6" y2="12"/><line x1="18.4" y1="12" x2="21.2" y2="12"/><line x1="5.5" y1="5.5" x2="7.5" y2="7.5"/><line x1="16.5" y1="16.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="16.5" y2="7.5"/><line x1="5.5" y1="18.5" x2="7.5" y2="16.5"/></svg>',
  };

  // ── 二级圆形子 Tab（V3「圆形子Tab与首页标语方案」2026-09-11 §2）──
  // 与 PDCA Step 同族：圆环 + 下方文案；但圆环略小(44px)且改用「图标」而非数字，
  // 避免与 PDCA 的 1/2/3 混淆。图标语义按方案 §2.3 选型，统一 24×24 viewBox、
  // stroke=currentColor（颜色由 CSS .ct-icon 的 color 控制，激活态转白）。
  const CT_SVG = (inner) => `<svg class="ct-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const CIRCLE_TAB_ICONS = {
    // 质量库：两本书（标准/知识库）
    library: CT_SVG('<rect x="3.3" y="4.5" width="7.4" height="15" rx="1.3"/><rect x="13.3" y="4.5" width="7.4" height="15" rx="1.3"/><line x1="6.6" y1="8.4" x2="8.4" y2="8.4"/><line x1="16.6" y1="8.4" x2="18.4" y2="8.4"/>'),
    // 检验池：锥形瓶（检验/试验）
    exam: CT_SVG('<line x1="9.3" y1="3.2" x2="14.7" y2="3.2"/><path d="M9.9 3.4v4.8L5.8 16.4a2.2 2.2 0 0 0 1.9 3.2h8.6a2.2 2.2 0 0 0 1.9-3.2L14.1 8.2V3.4z"/><line x1="7.1" y1="15.5" x2="16.9" y2="15.5"/>'),
    // 质量问答：放大镜（2026-10-11 新增第三子tab）
    qa: CT_SVG('<circle cx="10.8" cy="10.8" r="6.3"/><line x1="15.6" y1="15.6" x2="20.6" y2="20.6"/>'),
    // 管理：齿轮
    mgmt: CT_SVG('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    // 项目信息传递：文件夹（与底部 tab 同族）
    memo: CT_SVG('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    // 项目工期：时钟
    schedule: CT_SVG('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.1V12l3.4 2"/>'),
  };

  // 生成圆形子 Tab 组：items = [{icon,label,active,onclick,id,sub}]
  const circleTabs = (items, wrapId) => `<div class="circle-tabs"${wrapId ? ` id="${wrapId}"` : ''}>${
    items.map(it => `<div class="circle-tab${it.active ? ' active' : ''}"${it.id ? ` id="${it.id}"` : ''}${it.sub ? ` data-sub="${it.sub}"` : ''} onclick="${it.onclick}"><div class="ct-circle">${CIRCLE_TAB_ICONS[it.icon] || ''}</div><div class="ct-label">${it.label}</div></div>`).join('')
  }</div>`;

  function tabbar(active) {
    const c = App.caps || { canDesign: false, canManage: false };
    // 两层身份（设计师 / 管理人）版面：公告宣贯 / PDCA / 质量库 / 信息传递 / 管理评价
    // 仅权限范围不同（管理者可看全部、可管公告等）。tabbar 显示名 2026-09-13 改名（仅 label，路由 hash / tab key 不动）。
    const tabs = [
      { key: 'home', label: '公告宣贯' },
      { key: 'pdca', label: 'PDCA' },
    ];
    // 质量库：第 3 个 tab（正中间，2026-09-11 用户裁定，与项目传递互换位置）；凸起圆 2026-09-13。
    // 游客（纯只读）也显示「质量库 / 管理」tab，可进入查看（尤其小红花榜），但无操作入口。
    if (c.canDesign || c.canManage) {
      tabs.push({ key: 'work', label: '质量库' });
    }
    // 项目信息传递：置于 质量库 与 管理 之间；与质量库同权限范围。
    // 非游客正常显示；游客默认隐藏（后端 memos 对游客 403），例外（2026-09-11 用户裁定 guest1/guest2；
    // 2026-09-13 追加 guest9）：这些游客后端已只读放开 GET → 前端同样放行，使其可见完整 tab，与超级管理员同视野。
    //   · guest9 = 院领导(院长)视野游客，按用户要求与超级管理员视野统一、仅只读（写操作后端仍 403）。
    //   · 2026-09-17 追加：可考试只读游客（EXAMGUEST1~EXAMGUEST9，caps.canExam）同样可见（后端 memos 与质量专题均同步只读放开 GET）。
    const GUEST_MEMO_TAB = ['guest1', 'guest2', 'guest9'];
    const uname = String((App.user && App.user.username) || '').toLowerCase();
    if ((c.canDesign || c.canManage) && (!c.isGuest || c.canExam || GUEST_MEMO_TAB.includes(uname))) {
      tabs.push({ key: 'memo', label: '质量专题' });
    }
    if (c.canDesign || c.canManage) {
      tabs.push({ key: 'admin', label: '管理评价' });
    }
    // 底部 tab 红点映射（各类提醒对号入座）：
    //   · 管理 tab = 宣贯审核待通过 + 人人讲院选待精选（仅管理者可见）
    //   · PDCA tab = 我的流程待办（被请教 / 共议邀请 / 待补充）
    //   · 我的(头像) 红点 在 topbar 内单独渲染
    const adminN = (c.canDesign || c.canManage) ? (App.pendingAdmin || 0) : 0;
    const pdcaN = App.pendingPdca || 0;
    const html = `<div class="tabbar">${tabs.map(t => {
      const isActive = active === t.key;
      if (t.key === 'work') {
        // 质量库凸起圆：halo 衬环 + 实心/白底圆；保留 location.hash 路由跳转（红线：hash / tab key 不动）。
        return `<div class="tab tab-lib${isActive ? ' active' : ''}" onclick="location.hash='#/work'" data-tab="lib" aria-label="${t.label}">
          <span class="lib-halo" aria-hidden="true">
            <span class="lib-circle"><span class="lib-icon">${TAB_ICONS.work}</span><span class="lib-label">${t.label}</span></span>
          </span>
        </div>`;
      }
      return `<div class="tab${isActive ? ' active' : ''}" onclick="location.hash='#/${t.key}'"${t.grey ? ' style="color:var(--text-muted);opacity:.6"' : ''}>
        <span class="icon">${TAB_ICONS[t.key] || ''}</span>
        <span class="tab-label">${t.label}</span>
        ${t.sub ? `<span class="tab-sub">${t.sub}</span>` : ''}
        ${t.key === 'admin' && adminN > 0 ? `<span class="nav-badge" id="nav-badge">${adminN > 99 ? '99+' : adminN}</span>` : ''}
        ${t.key === 'pdca' && pdcaN > 0 ? `<span class="nav-badge" id="nav-badge-pdca">${pdcaN > 99 ? '99+' : pdcaN}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
    return html;
  }

  // ─── 登录页（重设计 2026-09-11：渐变 + 装饰圆 + 白徽标塔吊 SVG + 居中卡片）───
  // 红线：登录/游客逻辑、表单校验、跳转一律不动，仅换视觉层。
  function login() {
    app().innerHTML = `
      <div class="login-page">
        <div class="lp-deco lp-deco-tl"></div>
        <div class="lp-deco lp-deco-ring"></div>
        <div class="lp-deco lp-deco-br"></div>
        <div class="lp-body">
          <div class="lp-badge">
            <svg class="lp-crane" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M14 40V12L34 8M14 12L34 16M34 8V16M34 16V22" stroke="#0A7A66" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M10 40H20M14 40V36M14 36H18M18 36V40" stroke="#0A7A66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="34" cy="25" r="2.4" fill="#E8A33D"/>
              <path d="M34 22V16" stroke="#E8A33D" stroke-width="1.6"/>
            </svg>
          </div>
          <div class="lp-title-sm">${(window.APP_CONFIG || {}).orgName || '质量信息管理平台'}</div>
          <div class="lp-title">质量千里行</div>
          <div class="lp-subtitle">质量信息管理平台</div>
          <div class="lp-card">
            <label for="lg-user">用户名</label>
            <input class="lp-input" id="lg-user" placeholder="请输入用户名" autocomplete="username">
            <label for="lg-pwd">密码</label>
            <input class="lp-input" id="lg-pwd" type="password" placeholder="请输入密码" autocomplete="current-password">
            <button class="lp-btn" id="lg-btn">登 录</button>
            <div class="lp-guest">游客账户（GUEST1 / GUEST2 / EXAMGUEST1~EXAMGUEST9）免密登录</div>
          </div>
        </div>
        <div class="lp-footer">
          <div class="lp-slogan">人人都是质量参与者</div>
          <div class="lp-ver">${(window.APP_CONFIG || {}).domain || ''}</div>
        </div>
      </div>`;

    const doLogin = async () => {
      let username = document.getElementById('lg-user').value.trim();
      const password = document.getElementById('lg-pwd').value;
      // 游客账户大小写归一（GUEST1/guest1/Uk1 均按 GUEST1 处理）
      const guestM = username.toUpperCase().match(/^(UK|LS)(\d+)$/);
      if (guestM) username = guestM[1] + guestM[2];
      const isGuestLogin = /^(UK|LS)\d+$/i.test(username);
      if (!username) return UI.toast('请输入用户名');
      if (!isGuestLogin && !password) return UI.toast('请输入密码');
      try {
        UI.loading(true);
        const res = await API.post('/api/auth/login', { username, password });
        API.setToken(res.token);
        App.user = res.user;
        App.caps = deriveCaps(App.user); // P3⑩ 修复：传全 user 对象（含 extraRoles），与 app.js init 一致，消除双身份用户登录后 caps 短暂缺 extraRoles
        // 登录成功后也触发开场小红花（覆盖「打开链接→登录」路径，仅首访一次由持久标记控制）
        if (window.QCSplash) window.QCSplash.show();
        if (res.mustChangePwd) { location.hash = '#/change-pwd'; }
        else { location.hash = '#/work'; }
        UI.toast('欢迎回来，' + res.user.realName);
      } catch (e) { UI.toast(e.message); }
      finally { UI.loading(false); }
    };
    document.getElementById('lg-btn').onclick = doLogin;
    document.getElementById('lg-pwd').addEventListener('keypress', (e) => { if (e.key === 'Enter') doLogin(); });
  }

  // ─── 首次改密码 ─────────────────────────────
  function changePwd() {
    app().innerHTML = `
      ${topbar('修改密码', { back: true })}
      <div class="page">
        <div class="card">
          <p class="text-muted" style="margin-bottom:16px">首次登录请修改初始密码</p>
          <div class="field"><label>旧密码</label><input class="input" id="cp-old" type="password" placeholder="初始密码"></div>
          <div class="field"><label>新密码</label><input class="input" id="cp-new" type="password" placeholder="至少6位"></div>
          <div class="field"><label>确认新密码</label><input class="input" id="cp-new2" type="password"></div>
          <button class="btn btn-block btn-lg" id="cp-btn">确认修改</button>
        </div>
      </div>`;
    document.getElementById('cp-btn').onclick = async () => {
      const oldP = document.getElementById('cp-old').value;
      const n1 = document.getElementById('cp-new').value;
      const n2 = document.getElementById('cp-new2').value;
      if (!oldP || !n1) return UI.toast('请填写完整');
      if (n1.length < 6) return UI.toast('新密码至少6位');
      if (n1 !== n2) return UI.toast('两次密码不一致');
      try {
        UI.loading(true);
        await API.post('/api/auth/change-pwd', { oldPassword: oldP, newPassword: n1 });
        UI.toast('修改成功');
        location.hash = '#/work';
      } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
    };
  }

  // ─── 提醒类型徽标（首页/备忘查询共用）────────────
  function reminderTypeBadge(t) {
    const m = { '校审': 'badge-urgent', '提资': 'badge-dept', '要点': 'badge-normal' };
    const c = m[t] || '';
    return `<span class="badge ${c}">${UI.esc(t || '通用')}</span>`;
  }

  // 附件 chips（委托 UI.attChips，统一实现；透传 zoom 开关）
  function attChips(atts, zoom) { return UI.attChips(atts, zoom); }

  // 图片/拍摄框：选择即上传，缩略图网格可删除（accept=image/* 且去掉 capture，移动端可拍照/相册）
  function bindPhotoInput(mask, inputId, gridId, store) {
    const input = mask.querySelector('#' + inputId);
    const grid = mask.querySelector('#' + gridId);
    if (!input || !grid) return;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      try {
        UI.loading(true);
        const r = await API.upload(files);
        for (const f of (r.files || [])) store.push(f);
        UI.renderPhotoGrid(grid, input, store);
      } catch (err) { UI.toast(err.message); } finally { UI.loading(false); }
      e.target.value = '';
    };
    UI.renderPhotoGrid(grid, input, store);
  }

  // 点击卡片展开查看全文（公示 / 宣贯）：弹窗显示完整内容，不再受 2 行截断限制
  function openContentModal(title, data, metaHtml, imaSynced, imaPath, canEdit, onEdit, noteHtml, extraHtml, onExtra) {
    let phs = data.photos;
    if (typeof phs === 'string') { try { phs = JSON.parse(phs); } catch (e) { phs = []; } }
    if (!Array.isArray(phs)) phs = [];
    const editBtn = canEdit ? `<button class="btn btn-sm btn-outline" id="oc-edit" style="margin-bottom:12px">✏️ 修改</button>` : '';
    UI.modal(title, `
      ${editBtn}
      ${metaHtml ? `<div class="li-meta" style="margin-bottom:10px">${metaHtml}</div>` : ''}
      ${noteHtml || ''}
      <div class="lib-detail">${esc(data.content || '')}</div>
      ${UI.photoGrid(phs)}
      ${UI.attChips(data.attachments)}
      ${extraHtml || ''}
      ${imaSynced ? '<div class="li-meta mt12">' + UI.imaTag(imaPath || [(window.IMA_KB||'SHARE-知识库')], data.ima_url || data.imaUrl || '') + '</div>' : ''}
    `, (mask, close) => {
      if (canEdit) {
        const b = mask.querySelector('#oc-edit');
        if (b) b.onclick = () => { close(); if (typeof onEdit === 'function') onEdit(); };
      }
      // 已阅区默认展开（autoOpen）：面板已 display:block，这里按DOM 上的 data-ack 补拉一次名单。
      //   loadAck 幂等，用户手动收起再展开也不会重复请求。
      const ackAuto = mask.querySelector('.ack-panel[data-ack][style*="display: block"]');
      if (ackAuto) {
        setTimeout(() => Pages.loadAck(ackAuto.getAttribute('data-ack-type'), Number(ackAuto.getAttribute('data-ack-id')), ackAuto.getAttribute('data-ack-instance') || ''), 0);
      }
      if (typeof onExtra === 'function') onExtra(mask, close);
    });
  }

  // 备注区（仅管理者对设计师帖可见）：展示现有备注 + 加/编辑按钮
  // 注：noteSectionHtml 已移至 ui.js（UI.noteSectionHtml），供 pages.js / pages4.js 跨 IIFE 共用。

  async function viewAnnouncement(id) {
    try {
      const a = await API.get('/api/announcements/' + id);
      const scopeTag = a.scope === 'division' && a.division ? `<span class="badge badge-div">🏢 ${esc(a.division)}</span> ` : '';
      const meta = `${scopeTag}<span>📣 ${esc(a.publisher || '')}</span><span>${UI.relTime(a.created_at)}</span><span>公示至 ${esc((a.expiry_date || '').slice(0, 10) || '长期')}</span>`;
      const ackCanRemind = (App.caps.canManage && !App.caps.isGuest) || (App.user && a.publisher_id === App.user.id);
      const ackHtml = Pages.ackBlockHtml('announcement', a.id, { requireAck: a.require_ack, canRemind: ackCanRemind, instance: 'modal', autoOpen: true });
      openContentModal(a.title, a, meta, a.ima_synced, [(window.IMA_KB||'SHARE-知识库'),'00千里行质量公告'], a.canEdit, () => Pages.editAnnouncement(a.id), '', ackHtml, () => Pages.loadAck('announcement', a.id, 'modal'));
    } catch (e) { UI.toast(e.message); }
  }

  async function viewDissem(id) {
    try {
      const d = await API.get('/api/quality-dissem/' + id);
      const divs = d.divisions || []; const regs = d.regions || []; const subs = d.subDivisions || [];
      const meta = [
        d.category ? `<span class="tag">${esc(d.category)}</span>` : '',
        divs.length ? `<span>🏢 ${divs.map(esc).join('/')}</span>` : '',
        subs.length ? `<span>🔻 ${subs.map(s => UI.subDivLabel(s)).join(' / ')}</span>` : '',
        regs.length ? `<span>📍 ${regs.map(esc).join('/')}</span>` : '',
        `<span>📣 ${esc(d.publisher || '')}</span>`,
        `<span>公示至 ${esc((d.expiry_date || '').slice(0, 10) || '长期')}</span>`
      ].filter(Boolean).join(' ');
      // 宣贯备注：与院选一致，置于条文最上方；全员可见批注内容，仅管理者可编辑
      const noteHtml = (d.manager_note && String(d.manager_note).trim()) ? UI.noteSectionHtml('dissem', d.id, d.manager_note, d.manager_note_by, d.manager_note_at, App.caps.canManage) : '';
      const ackCanRemind = (App.caps.canManage && !App.caps.isGuest) || (App.user && d.publisher_id === App.user.id);
      const ackHtml = Pages.ackBlockHtml('dissem', d.id, { requireAck: d.require_ack, canRemind: ackCanRemind, instance: 'modal', autoOpen: true });
      openContentModal(d.title, d, meta, d.ima_media_id, [(window.IMA_KB||'SHARE-知识库'),'01千里行质量宣贯'], d.canEdit, () => Pages.editDissem(d.id), noteHtml, ackHtml, () => Pages.loadAck('dissem', d.id, 'modal'));
    } catch (e) { UI.toast(e.message); }
  }


  // 附件选择框：选择即上传，返回 {url,name}，渲染可删除列表
  // ⚠️ 同 pages4.js：必须「隐藏 input(.sr-only-file) + 可见按钮调 input.click()」，
  //    直接暴露的原生 <input type="file"> 在微信内置浏览器里点不动。
  function bindAttachInput(mask, inputId, listId, store) {
    const input = mask.querySelector('#' + inputId);
    const listEl = mask.querySelector('#' + listId);
    if (!input) return;
    const render = () => {
      if (!listEl) return;
      listEl.innerHTML = '';
      store.forEach((a, i) => {
        const span = document.createElement('span');
        span.className = 'att-item';
        span.appendChild(document.createTextNode('📎 ' + (a.name || '附件') + ' '));
        const x = document.createElement('span');
        x.className = 'att-x'; x.textContent = '✕';
        x.onclick = () => { store.splice(i, 1); render(); };
        span.appendChild(x);
        listEl.appendChild(span);
      });
      const add = document.createElement('span');
      add.className = 'att-add';
      add.textContent = store.length ? '＋ 继续添加附件' : '＋ 添加附件';
      add.onclick = () => input.click();
      listEl.appendChild(add);
    };
    // 常驻错误行：上传失败时留在附件区。
    // 原本只弹 2 秒 toast，用户很容易错过，进而以为「按钮点了没反应」。
    let errEl = mask.querySelector('.att-err[data-for="' + inputId + '"]');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'att-err';
      errEl.setAttribute('data-for', inputId);
      errEl.style.display = 'none';
      (listEl && listEl.parentNode ? listEl.parentNode : mask).appendChild(errEl);
    }
    const showErr = (m) => { errEl.textContent = '⚠️ ' + m; errEl.style.display = 'block'; };
    const clearErr = () => { if (errEl.style.display !== 'none') { errEl.textContent = ''; errEl.style.display = 'none'; } };

    // 检测「电脑端内置浏览器」(微信/企业微信/钉钉/飞书 PC)：这类环境调不起系统文件框、
    // 剪贴板被沙箱，表现为「＋添加附件」点了没反应、文字 Ctrl+V 粘贴失败。给一行常驻提示，
    // 避免误以为按钮坏。移动端微信 webview 能调起相册/相机，故仅「非移动 + 命中内置浏览器 UA」时提示。
    const isEmbeddedPc = (() => {
      const ua = navigator.userAgent || '';
      const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
      return !mobile && /(MicroMessenger|wxwork|DingTalk|Feishu|Lark)/i.test(ua);
    })();
    if (isEmbeddedPc) {
      const note = document.createElement('div');
      note.className = 'att-note';
      note.textContent = '⚠️ 当前为电脑端微信/企业微信等内置浏览器，无法选择文件上传，文字 Ctrl+V 粘贴也可能受限。请用手机，或电脑版 Chrome/Edge 打开本页上传附件；文字回复可直接打字提交。';
      (listEl && listEl.parentNode ? listEl.parentNode : mask).appendChild(note);
    }

    const doUpload = async (files) => {
      if (!files || !files.length) return;
      // 与服务端一致的上限（server/src/routes/upload.js: 50MB）先拦一道，避免大文件白传一遍才失败
      const tooBig = files.find((f) => f.size > 50 * 1024 * 1024);
      if (tooBig) return showErr('「' + (tooBig.name || '文件') + '」超过 50MB 上限');
      try {
        UI.loading(true); clearErr();
        const r = await API.upload(files);
        for (const f of (r.files || [])) store.push(f);
        render();
      } catch (err) { showErr(err.message || '上传失败'); }
      finally { UI.loading(false); input.value = ''; }
    };

    input.onchange = (e) => doUpload(Array.from(e.target.files || []));

    // 粘贴即附件：截图 / 复制的文件可直接贴进文本框。
    // 仅在剪贴板「带文件」时接管；纯文字粘贴 files 为空 → 直接放行，绝不干预正常文字粘贴。
    Array.from(mask.querySelectorAll('textarea')).forEach((ta) => {
      if (ta.getAttribute('data-att-paste') === inputId) return;
      ta.setAttribute('data-att-paste', inputId);
      ta.addEventListener('paste', (e) => {
        const cd = e.clipboardData; if (!cd) return;
        const fs = Array.from(cd.files || []);
        if (!fs.length) return;
        e.preventDefault();
        doUpload(fs);
      });
    });

    render(); // 初始渲染（空列表也显示「＋ 添加附件」）
  }

  // ─── 质量宣贯栏目渲染 / 筛选 ──────────────────
  function dissemCardHtml(d) {
    const divs = parseArr(d.divisions), regs = parseArr(d.regions), subs = parseArr(d.subDivisions);
    const canDelete = App.caps.canDeleteDissem || isSuperAdmin();
    const isOwner = App.user && d.publisher_id === App.user.id;
    const statusBadge = d.status === 'pending' ? '<span class="tag" style="background:#fff3cd;color:#8a6d00">待审核</span>'
      : d.status === 'rejected' ? '<span class="tag" style="background:#fde2e2;color:#a00">未通过</span>' : '';
    // 系统管理员/院长/专总/超级管理员 可删任意；其余角色仅可撤回自己尚未发布(pending/rejected)的宣贯
    const editBtn = d.canEdit ? `<span class="badge-edit" title="修改" onclick="event.stopPropagation();Pages.editDissem(${d.id})">✏️</span>` : '';
    const delBtn = canDelete ? `<span class="badge-x" onclick="event.stopPropagation();Pages.deleteDissem(${d.id})">✕</span>`
      : (isOwner && d.status !== 'active' ? `<span class="badge-x" onclick="event.stopPropagation();Pages.deleteDissem(${d.id})">✕</span>` : '');
    return `
      <div class="ann-card clickable" onclick="Pages.viewDissem(${d.id})">
        <div class="li-head"><div class="li-title">${esc(d.title)}</div>${editBtn}${delBtn}</div>
        <div class="li-meta">${d.category ? `<span class="tag">${esc(d.category)}</span>` : ''}${statusBadge}${divs.length ? `<span>🏢 ${divs.map(esc).join(' / ')}</span>` : ''}${subs.length ? `<span>🔻 ${subs.map(s => UI.subDivLabel(s)).join(' / ')}</span>` : ''}${regs.length ? `<span>📍 ${regs.map(esc).join(' / ')}</span>` : ''}${d.ima_media_id ? UI.imaTag([(window.IMA_KB||'SHARE-知识库'),'01千里行质量宣贯'], d.ima_url || '') : ''}</div>
        <div class="li-desc">${esc(d.content)}</div>
        ${UI.photoGrid(d.photos, false)}
        ${attChips(d.attachments, false)}
        <div class="li-meta"><span>📣 ${esc(d.publisher || '')}</span><span>公示至 ${esc((d.expiry_date || '').slice(0, 10) || '长期')}</span></div>
        ${Pages.ackBlockHtml('dissem', d.id, { requireAck: d.require_ack, canRemind: ((App.caps.canManage && !App.caps.isGuest) || (App.user && d.publisher_id === App.user.id)) })}
      </div>`;
  }

  // 管理者审核队列：拉取待审核宣贯并渲染「通过 / 驳回」
  async function loadDissemReview() {
    const el = document.getElementById('dissem-review');
    if (!el || !App.caps.canManage) return;
    try {
      const list = await API.get('/api/quality-dissem/pending');
      const cnt = document.getElementById('dissem-review-count');
      if (cnt) cnt.textContent = list.length;
      el.innerHTML = list.length ? list.map(d => `
        <div class="ann-card clickable" style="border-left:3px solid #f0a020" onclick="Pages.viewDissem(${d.id})">
          <div class="li-head"><div class="li-title">${esc(d.title)}</div></div>
          <div class="li-meta">${d.category ? `<span class="tag">${esc(d.category)}</span>` : ''}${(parseArr(d.divisions)).length ? `<span>🏢 ${(parseArr(d.divisions)).map(esc).join(' / ')}</span>` : '<span>🏢 全院</span>'}${(parseArr(d.regions)).length ? `<span>📍 ${(parseArr(d.regions)).map(esc).join(' / ')}</span>` : ''}</div>
          <div class="li-desc">${esc(d.content)}</div>
          <div class="li-meta"><span>✍️ ${esc(d.publisher || '')}</span></div>
          <div class="row-btns mt8">
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();Pages.approveDissem(${d.id})">通过并放出</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();Pages.rejectDissem(${d.id})">驳回</button>
          </div>
        </div>`).join('') : '<div class="empty"><div class="ei">📝</div><div class="et">暂无待审核宣贯</div><div class="es">大家都在按时提交，暂无需审核</div></div>';
    } catch (e) { el.innerHTML = '<div class="load-fail"><div class="lf-t">宣贯审核加载失败</div><button class="btn btn-sm btn-gray lf-a" onclick="Pages.loadDissemReview()">重试</button></div>'; }
  }

  // 按当前筛选重新拉取并渲染质量宣贯列表（不选=全看）
  async function loadDissem() {
    const el = document.getElementById('dissem-list');
    if (!el) return;
    try {
      const q = new URLSearchParams();
      if (dissemFilter.divisions.length) q.set('division', dissemFilter.divisions.join(','));
      if (dissemFilter.regions.length) q.set('region', dissemFilter.regions.join(','));
      const list = await API.get('/api/quality-dissem' + (q.toString() ? '?' + q.toString() : ''));
      // 作者本人提交的「待审核 / 未通过」项始终显示（不被 cap 折叠隐藏）；
      // 已发布(active) 宣贯按 6 条收起 +「展开更多」展开，超量不截断。
      const authorId = App.user && App.user.id;
      const active = list.filter(x => x.status === 'active');
      const mine = authorId ? list.filter(x => x.publisher_id === authorId && x.status !== 'active') : [];
      const mineHtml = mine.length ? mine.map(dissemCardHtml).join('') : '';
      const activeHtml = active.length ? capSectionHtml(active, dissemCardHtml, 6, 10) : '';
      const emptyHtml = (!active.length && !mine.length) ? '<div class="empty"><div class="ei">📢</div><div class="et">暂无符合条件的质量宣贯</div><div class="es">试试调整上方的筛选条件</div></div>' : '';
      el.innerHTML = mineHtml + activeHtml + emptyHtml;
      fillAckCounts();   // 重新渲染后回填已阅计数（含公告卡，已在 DOM 中）
    } catch (e) {
      el.innerHTML = '<div class="load-fail"><div class="lf-t">质量宣贯加载失败</div><button class="btn btn-sm btn-gray lf-a" onclick="Pages.loadDissem()">重试</button></div>';
    }
  }

  // S5 首页「待办提醒」：标记已读（调 reminders 完成接口）并移除该条
  // ⚠ 必须用 function 声明 + 经 return 暴露为 Pages.reminderDismiss；
  //   不可在 const Pages IIFE 内部写 Pages.xxx = —— 初始化期 Pages 处于 TDZ，会导致全站白屏
  async function reminderDismiss(ev, id) {
    if (ev) ev.stopPropagation();
    if (!id) return;
    try {
      await API.post(`/api/reminders/${id}/done`, {});
      const list = document.getElementById('rb-list');
      const box = document.getElementById('remind-box');
      const btn = list ? list.querySelector(`[data-id="${id}"]`) : null;
      const row = btn ? btn.closest('.rb-item') : null;
      if (row) row.remove();
      const left = list ? list.querySelectorAll('.rb-item').length : 0;
      const cnt = document.getElementById('rb-count');
      if (cnt) cnt.textContent = left > 3 ? `（共 ${left} 条）` : '';
      if (box && left === 0) box.remove();
    } catch (e) { UI.toast(e.message); }
  }

  // ─── V3 §3.1：横向 chips 筛选条（全部 / 专业多选 / ⌄地区 下拉）──────────
  // 与旧版「14 个复选框」行为完全等价：写回 localStorage + 触发列表刷新，功能零丢失。
  //   「全部」= 清空专业选择（回到全看）
  //   专业 chip = 多选切换（维度内 OR）
  //   「⌄地区」chip = 展开/收起地区复选面板（面板内仍为 7 地区复选，维度内 OR）
  function chipsHtml(divs, state) {
    return `<span class="filter-chip${state.divisions.length ? '' : ' active'}" data-role="all">全部</span>`
      + divs.map(d => `<span class="filter-chip${state.divisions.includes(d) ? ' active' : ''}" data-role="div" data-val="${esc(d)}">${esc(d)}</span>`).join('')
      + `<span class="filter-chip${state.regions.length ? ' active' : ''}" data-role="region"><span class="fc-caret">⌄</span>地区${state.regions.length ? `<span class="fc-n">${state.regions.length}</span>` : ''}</span>`;
  }
  // 原地同步高亮/计数（不重建 DOM —— 避免 overflow-x 滚动位置被重置到最左）
  function syncChips(bar, state) {
    if (!bar) return;
    bar.querySelectorAll('.filter-chip').forEach(c => {
      const role = c.dataset.role;
      if (role === 'all') c.classList.toggle('active', !state.divisions.length);
      else if (role === 'div') c.classList.toggle('active', state.divisions.includes(c.dataset.val));
      else if (role === 'region') {
        c.classList.toggle('active', state.regions.length > 0);
        c.innerHTML = `<span class="fc-caret">⌄</span>地区` + (state.regions.length ? `<span class="fc-n">${state.regions.length}</span>` : '');
      }
    });
  }
  function regionPanelHtml(regions, state) {
    return `<div class="filter-label">只看地区（不选 = 全看）</div><div class="filter-chks">`
      + regions.map(r => `<label class="filter-chk"><input type="checkbox" value="${esc(r)}" ${state.regions.includes(r) ? 'checked' : ''}> ${esc(r)}</label>`).join('')
      + `</div>`;
  }
  // chip 点击：全部 / 专业切换 / 地区面板开关。onChanged 由调用方提供（落盘 + 刷新列表）
  function bindChips(bar, panel, state, onChanged) {
    bar.onclick = (ev) => {
      const c = ev.target.closest && ev.target.closest('.filter-chip');
      if (!c) return;
      const role = c.dataset.role;
      if (role === 'all') state.divisions = [];
      else if (role === 'div') {
        const v = c.dataset.val;
        state.divisions = state.divisions.includes(v) ? state.divisions.filter(x => x !== v) : state.divisions.concat([v]);
      } else if (role === 'region') { if (panel) panel.hidden = !panel.hidden; return; }
      onChanged();
    };
    if (panel) {
      panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.onchange = () => {
          const v = cb.value;
          state.regions = cb.checked ? (state.regions.includes(v) ? state.regions : state.regions.concat([v])) : state.regions.filter(x => x !== v);
          onChanged();
        };
      });
    }
  }

  // 渲染质量宣贯筛选条（专业室 / 地区），点击即写回并刷新列表
  async function renderDissemFilter() {
    const bar = document.getElementById('dissem-filter');
    const panel = document.getElementById('dissem-region-panel');
    if (!bar) return;
    let divs = [];
    try { const f = await API.get('/api/quality-dissem/filters'); divs = f.divisions || []; } catch (e) {}
    bar.innerHTML = chipsHtml(divs, dissemFilter);
    if (panel) {
      panel.innerHTML = regionPanelHtml(QC_REGIONS_HOME, dissemFilter);
      panel.hidden = !dissemFilter.regions.length;   // 已选地区时默认展开，便于看到/取消
    }
    bindChips(bar, panel, dissemFilter, () => {
      saveDissemFilter();
      syncChips(bar, dissemFilter);
      if (panel) panel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = dissemFilter.regions.includes(cb.value); });
      loadDissem();
    });
  }

  // ─── 公示期控件 / 折叠 / 院选卡片 辅助函数 ───────────────
  function addDaysLocal(dateStr, days) {
    const d = new Date((dateStr || '') + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + Number(days));
    // 用本地年月日格式化，避免 toISOString() 的 UTC 偏移导致 UTC+8 下日期差一天
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // 由已有 expiry_date 反推应选中的公示期选项（2月 / 1周 / 1月 / 3月 / 自定义）
  function durFromExpiry(exp, pub) {
    if (!exp) return '60'; // 无公示期（旧「长久」）：按 2 个月处理
    const e = String(exp).slice(0, 10);
    if (e === addDaysLocal(pub, 7)) return '7';
    if (e === addDaysLocal(pub, 30)) return '30';
    if (e === addDaysLocal(pub, 60)) return '60';
    if (e === addDaysLocal(pub, 90)) return '90';
    return '0';
  }
  // 渲染公示期下拉（2 个月为默认），prefix 区分不同表单的 id。2026-09-13 起取消「长久（永久）」选项。
  function durFieldHtml(prefix, selVal, customVal) {
    return `<div class="field"><label>公示期</label>
      <select class="input" id="${prefix}-dur">
        <option value="60" ${(!selVal || selVal === '60' || selVal === 'long') ? 'selected' : ''}>2 个月（默认）</option>
        <option value="7" ${selVal === '7' ? 'selected' : ''}>1 周</option>
        <option value="30" ${selVal === '30' ? 'selected' : ''}>1 个月</option>
        <option value="90" ${selVal === '90' ? 'selected' : ''}>3 个月</option>
        <option value="0" ${selVal === '0' ? 'selected' : ''}>自定义到期日</option>
      </select>
      <input class="input mt8" id="${prefix}-exp" type="date" style="display:${selVal === '0' ? 'block' : 'none'}" value="${customVal || ''}" placeholder="选择到期日期">
    </div>`;
  }
  function bindDur(mask, prefix) {
    const durEl = mask.querySelector('#' + prefix + '-dur');
    const expEl = mask.querySelector('#' + prefix + '-exp');
    if (durEl && expEl) durEl.onchange = () => { expEl.style.display = durEl.value === '0' ? 'block' : 'none'; };
  }
  function readDur(mask, prefix) {
    const durEl = mask.querySelector('#' + prefix + '-dur');
    const expEl = mask.querySelector('#' + prefix + '-exp');
    const dur = durEl ? durEl.value : '60';
    const expiry = (dur === '0' && expEl && expEl.value) ? expEl.value : '';
    return { durationDays: dur, expiry_date: expiry };
  }
  // 首页列表「两级展开」：base(折叠默认) → 第一级 l1 → 全部。
  // 宣贯/院选 base 6、l1 10；公告 base 4、l1 5。一律不截断——超量只折叠不丢条目。
  function capSectionHtml(items, renderOne, base, l1) {
    if (!items.length) return '';
    const n = items.length;
    if (n <= base) return items.map(renderOne).join('');
    const shown = items.slice(0, base).map(renderOne).join('');
    if (n <= l1) {
      // 一个折叠层级即可到全部
      const rest = items.slice(base).map(renderOne).join('');
      const cnt = n - base;
      return `<div class="cap-wrap">` + shown
        + `<div class="capped-rest" style="display:none">${rest}</div>`
        + `<div class="cap-toggle" data-act="expand" data-label-expand="展开更多（${cnt}）" onclick="Pages.toggleCap(this)">展开更多（${cnt}）</div>`
        + `</div>`;
    }
    const l1part = items.slice(base, l1).map(renderOne).join('');
    const rest = items.slice(l1).map(renderOne).join('');
    const cnt1 = l1 - base, cnt2 = n - l1;
    return `<div class="cap-wrap">` + shown
      + `<div class="capped-rest-1" style="display:none">${l1part}</div>`
      + `<div class="cap-toggle" data-act="l1" onclick="Pages.toggleCap(this)">展开更多（${cnt1}）</div>`
      + `<div class="capped-rest-2" style="display:none">${rest}</div>`
      + `<div class="cap-toggle" data-act="all" style="display:none" data-label-all="展开全部（${cnt2}）" onclick="Pages.toggleCap(this)">展开全部（${cnt2}）</div>`
      + `</div>`;
  }
  // 首页公告卡片（供 9 条折叠复用）
  // 置顶（2026-09-14）：置顶公告卡显示「📌 置顶」徽标；置顶/取消开关仅超级管理员可见（isSuperAdmin）。
  function annCardHtml(a) {
    const pinToggle = isSuperAdmin()
      ? `<span class="pin-btn${a.pinned ? ' on' : ''}" title="${a.pinned ? '取消置顶' : '置顶（恒排第一条、不受公示期影响）'}" onclick="event.stopPropagation();Pages.togglePinAnnouncement(${a.id}, ${a.pinned ? 1 : 0})">${a.pinned ? '取消置顶' : '置顶'}</span>`
      : '';
    return `<div class="ann-card clickable${a.pinned ? ' pinned' : ''}" onclick="Pages.viewAnnouncement(${a.id})">
      <div class="li-head"><div class="li-title">${a.pinned ? '<span class="badge-pin">📌 置顶</span> ' : ''}${a.scope === 'division' ? `<span class="badge badge-div">🏢 ${esc(a.division || '专业')}</span> ` : ''}${esc(a.title)}</div>${pinToggle}${a.canEdit ? `<span class="badge-edit" title="修改" onclick="event.stopPropagation();Pages.editAnnouncement(${a.id})">✏️</span>` : ''}${(a.canDelete) ? `<span class="badge-x" onclick="event.stopPropagation();Pages.deleteAnnouncement(${a.id})">✕</span>` : ''}</div>
      <div class="li-desc">${esc(a.content)}</div>
      ${UI.photoGrid(a.photos, false)}
      ${attChips(a.attachments, false)}
      <div class="li-meta"><span>📣 ${esc(a.publisher || '')}</span><span>${UI.relTime(a.created_at)}</span>${a.pinned ? '<span>📌 长期置顶展示</span>' : `<span>公示至 ${esc((a.expiry_date || '').slice(0, 10) || '长期')}</span>`}${a.ima_synced ? UI.imaTag([(window.IMA_KB||'SHARE-知识库'),'00千里行质量公告'], a.ima_url || '') : ''}</div>
        ${Pages.ackBlockHtml('announcement', a.id, { requireAck: a.require_ack, canRemind: ((App.caps.canManage && !App.caps.isGuest) || (App.user && a.publisher_id === App.user.id)) })}
    </div>`;
  }

  // 首页院选版块：专业 / 地区筛选（V3 §3.1 chips，客户端过滤 homeRrj；行为与旧复选框等价）
  function renderRrjFilter(divList) {
    const bar = document.getElementById('rrj-filter');
    const panel = document.getElementById('rrj-region-panel');
    if (!bar) return;
    bar.innerHTML = chipsHtml(divList || [], rrjFilter);
    if (panel) {
      panel.innerHTML = regionPanelHtml(QC_REGIONS_HOME, rrjFilter);
      panel.hidden = !rrjFilter.regions.length;
    }
    bindChips(bar, panel, rrjFilter, () => {
      saveRrjFilter();
      syncChips(bar, rrjFilter);
      if (panel) panel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = rrjFilter.regions.includes(cb.value); });
      renderRrjList();
    });
  }
  function rrjCardHtml(p) {
    return `<div class="ann-card clickable" onclick="Pages.pdcaDetail(${p.id})">
      ${p.manager_note ? `<div class="rrj-note">📝 ${esc(p.manager_note)}</div>` : ''}
      <div class="li-head"><div class="li-title">${esc(p.title)}</div><span class="tag tag-rrj">院选 🏵️3</span></div>
      <div class="li-desc">${esc(p.description || '').slice(0, 80)}</div>
      <div class="li-meta"><span>👤 ${esc(p.reporter)}</span>${p.rrj_selected_by ? `<span>精选人 ${esc(p.rrj_selected_by)}</span>` : ''}<span>${UI.relTime(p.closed_at || p.created_at)}</span></div>
        ${Pages.ackBlockHtml('pdca', p.id, { requireAck: p.require_ack, canRemind: ((App.caps.canManage && !App.caps.isGuest) || (App.user && p.reporter_user_id === App.user.id)) })}
    </div>`;
  }
  function renderRrjList() {
    const el = document.getElementById('rrj-list');
    if (!el) return;
    const all = homeRrj || [];
    const filtered = all.filter(p => {
      const divs = parseArr(p.divisions);
      const okDiv = !rrjFilter.divisions.length || divs.some(d => rrjFilter.divisions.includes(d));
      const okReg = !rrjFilter.regions.length || (p.region && rrjFilter.regions.includes(p.region));
      return okDiv && okReg;
    });
    // 院选按 6 条收起 +「展开更多」展开，超量不截断（用户要求：收起/展开而非截断）
    el.innerHTML = filtered.length
      ? capSectionHtml(filtered, rrjCardHtml, 6, 10)
      : '<div class="empty"><div class="ei">🎤</div><div class="et">暂无符合条件的院选人人讲</div><div class="es">试试调整上方的筛选条件</div></div>';
    fillAckCounts();   // 重新渲染后回填已阅计数
  }

  // ─── 首页已阅计数批量回填 ──────────────────────
  // 首页各卡片已渲染已阅区占位（ack-count-type-id），此处一次性向 /counts 拉全屏计数回填，避免 N+1。
  // 折叠卡（capSectionHtml 的 capped-rest）仍在 DOM 中，querySelectorAll 一并覆盖。
  async function fillAckCounts() {
    const nodes = document.querySelectorAll('[id^="ack-count-"]');
    if (!nodes.length) return;
    const targets = [];
    const keyOf = (n) => {
      const m = n.id.match(/^ack-count-(.+)-(\d+)$/);
      return m ? (m[1] + ':' + m[2]) : null;
    };
    nodes.forEach(n => { const k = keyOf(n); if (k) targets.push(k); });
    if (!targets.length) return;
    try {
      const data = await API.get('/api/read-acks/counts?targets=' + encodeURIComponent(targets.join(',')));
      const counts = (data && data.counts) || {};
    nodes.forEach(n => {
      const k = keyOf(n);
      if (!k) return;
      const c = counts[k];
      if (!c) return;
      n.textContent = c.requireAck ? ((c.acked || 0) + '/' + (c.total || 0)) : '无需确认';
      // 元素 id 渲染时用「type-id」连字符（如 ack-me-dissem-47），而 k 为「type:id」冒号，
      // 须拆开再拼连字符，否则 getElementById 查不到（既影响 me 徽标也影响 mini 色块）。
      const _ids = k.split(':');
      const elId = _ids[0] + '-' + _ids[1];
      // 本人是否已阅徽标（仅当本人是应阅人时显示；非应阅人/游客/无需确认则不显示）
      const me = document.getElementById('ack-me-' + elId);
      if (me) {
        if (!c || !c.requireAck || !c.meInPool) { me.textContent = ''; me.className = 'ack-me'; }
        else if (c.meAcked) { me.textContent = '你已阅'; me.className = 'ack-me ack-me-done'; }
        else { me.textContent = '你待阅'; me.className = 'ack-me ack-me-todo'; }
      }
      // 个人已阅色块（仅质量库列表卡片有 ack-mini 占位；首页卡片无此元素则跳过）：
      // 绿=已阅 / 橙红=待阅 / 隐藏=非应阅人（或无需确认）。同步写 data-mine 供「我的待阅」筛选。
      const mini = document.getElementById('ack-mini-' + elId);
      if (mini) {
        if (c.requireAck && c.meInPool) {
          mini.className = 'ack-mini ' + (c.meAcked ? 'done' : 'todo');
        } else {
          mini.className = 'ack-mini';
        }
        const card = mini.closest('.lib-item');
        if (card) card.setAttribute('data-mine', (c.meInPool ? (c.meAcked ? 'done' : 'todo') : 'none'));
      }
    });
    } catch (e) { /* 计数失败不阻断首页 */ }
  };

  // ─── 首页（仅 公告 + 质量宣贯）──────────────────
  // ── Hero 标语「打字机逐行浮现」（2026-09-22，用户裁定）──
  // 标语逐行呈现：每一行先「人人都是」淡入，紧接着该行关键词逐字打出，再下一行
  // （逐行匹配，只打一次、不循环）。系统开启「减少动态效果」时直接保留全文、不播动画。
  function typeHeroKeywords() {
    const rows = Array.prototype.slice.call(document.querySelectorAll('#home-body .hh-line'));
    if (!rows.length) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      rows.forEach(function (row) {
        const d = row.querySelector('.hh-dim'), k = row.querySelector('.hh-key');
        if (d) d.classList.add('shown');
        if (k) { k.classList.add('shown'); if (!k.dataset.text) k.dataset.text = k.textContent; k.textContent = k.dataset.text; }
      });
      return;
    }
    if (typeHeroKeywords._timers) typeHeroKeywords._timers.forEach(clearTimeout);
    typeHeroKeywords._timers = [];
    const DIM = 320;   // 人人都是淡入时长(ms)
    const STEP = 170;  // 每字间隔(ms)——比初版略慢，打字更从容
    const GAP = 220;   // 行间停顿(ms)
    let t = 0;
    rows.forEach(function (row) {
      const dim = row.querySelector('.hh-dim');
      const key = row.querySelector('.hh-key');
      const full = key.dataset.text || key.textContent;
      key.dataset.text = full;
      const run = function () {
        if (dim) dim.classList.add('shown');          // 人人都是淡入
        const typeId = setTimeout(function () {        // 淡入完成后才开始打字
          key.textContent = '';
          key.classList.add('typing', 'shown');
          let n = 0;
          const tick = function () {
            n++;
            key.textContent = full.slice(0, n);
            if (n < full.length) {
              typeHeroKeywords._timers.push(setTimeout(tick, STEP));
            } else {
              key.classList.remove('typing'); // 保留 shown，维持显形
            }
          };
          tick();
        }, DIM);
        typeHeroKeywords._timers.push(typeId);
      };
      typeHeroKeywords._timers.push(setTimeout(run, t));
      t += DIM + full.length * STEP + GAP;
    });
  }

  async function home() {
    const canManage = App.caps.canManage;
    app().innerHTML = `${topbar((window.APP_CONFIG || {}).platformName || '质量千里行', { tall: true })}<div class="page" id="home-body"><div class="empty"><div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div></div></div>${tabbar('home')}`;
    try {
      const [anns, stats, rrj, divs, reminders] = await Promise.all([
        API.get('/api/announcements').catch(() => []),
        API.get('/api/stats/home').catch(() => ({ announcements: { total: 0, month: 0 }, dissem: { total: 0, month: 0 }, rrj: { total: 0, month: 0 } })),
        API.get('/api/pdca/problems?rrj_selected=1').catch(() => []),
        API.get('/api/divisions').catch(() => ({ divisions: [], divisionSubs: {} })),
        API.get('/api/reminders/inbox').catch(() => []),
      ]);
      homeRrj = rrj;
      const u = App.user;
      const pendingReminders = App.caps.isGuest ? [] : (reminders || []).filter(r => r.state !== 'done');
      document.getElementById('home-body').innerHTML = `
        ${App.caps.isGuest ? '<div class="guest-banner" id="guest-banner"><span class="gb-lock">🔒</span><span class="gb-txt">你当前为访客身份，仅可浏览</span></div>' : ''}
        <div class="home-hero-v2">
          <div class="hh-greeting">你好，${esc(u.realName)}${u.titleTag?` · ${esc(u.titleTag)}`:''}</div>
          <div class="hh-slogan">
            <svg class="hh-quote" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 14C4 10 7 8 10 8V11C8 11 7 12 7 14H10V18H4V14Z"/><path d="M13 14C13 10 16 8 19 8V11C17 11 16 12 16 14H19V18H13V14Z"/></svg>
            <div class="hh-lines">
              ${['质量参与者、', '质量宣贯者、', '质量监督者、', '质量受益者！'].map(k => `<div class="hh-line"><span class="hh-dim">人人都是</span><span class="hh-key">${k}</span></div>`).join('')}
            </div>
            <svg class="hh-quote hh-quote-end" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 14C4 10 7 8 10 8V11C8 11 7 12 7 14H10V18H4V14Z"/><path d="M13 14C13 10 16 8 19 8V11C17 11 16 12 16 14H19V18H13V14Z"/></svg>
          </div>
          <div class="hh-badge">质量宣言</div>
        </div>
        ${pendingReminders.length ? `<section class="card remind-box" id="remind-box">
          <div class="rb-head"><span class="rb-title">待办提醒</span><span class="rb-count" id="rb-count">${pendingReminders.length > 3 ? `（共 ${pendingReminders.length} 条）` : ''}</span></div>
          <div id="rb-list">
            ${pendingReminders.slice(0, 3).map(t => `<div class="rb-item"><div class="rb-item-title">${esc(t.title || t.type || '提醒')}</div>${t.content ? `<div class="rb-item-content">${esc(t.content)}</div>` : ''}<div class="rb-item-foot"><span class="rb-time">${UI.relTime(t.created_at)}</span><button class="memo-dismiss" data-id="${t.id}" aria-label="标记已读" onclick="Pages.reminderDismiss(event, ${t.id})">×</button></div></div>`).join('')}
          </div>
        </section>` : ''}

        <div class="card-title">公告 ${(canManage && !App.caps.isGuest) ? `<span class="more-link" onclick="Pages.publishAnnouncement()">＋发布</span>` : ''}<span class="count-pill">本月 ${stats.announcements.month} / 共 ${stats.announcements.total}</span></div>
        ${anns.length ? capSectionHtml(anns, annCardHtml, 4, 5) : '<div class="empty"><div class="ei">📭</div><div class="et">暂无公告</div><div class="es">有新的公告会第一时间出现在这里</div></div>'}

        <div class="card-title">质量宣贯 ${App.caps.isGuest ? '' : `<span class="more-link" onclick="Pages.publishDissem()">＋发布</span>`}<span class="count-pill">本月 ${stats.dissem.month} / 共 ${stats.dissem.total}</span></div>
        <div class="filter-bar" id="dissem-filter"></div>
        <div class="filter-panel" id="dissem-region-panel" hidden></div>
        <div id="dissem-list"><div class="empty"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div></div></div>

        <div class="card-title">质量人人讲（院选）<span class="count-pill">本月 ${stats.rrj.month} / 共 ${stats.rrj.total}</span></div>
        <div class="filter-bar" id="rrj-filter"></div>
        <div class="filter-panel" id="rrj-region-panel" hidden></div>
        <div id="rrj-list"><div class="empty"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div></div></div>
      `;
      typeHeroKeywords();
      renderDissemFilter();
      await loadDissem();
      renderRrjFilter((divs && divs.divisions) || []);
      renderRrjList();
    } catch (e) { UI.toast(e.message); }
  }

  // ── 发布公告（首页＋发布 / 管理页复用）──────────
  async function publishAnnouncement() {
    const caps = App.caps;
    const me = App.user;
    const role = me.role;
    const extra = me.extraRoles || [];
    const isDean = role === 'dean' || extra.includes('dean');
    const isChief = role === 'chief' || extra.includes('chief');
    const isFreePicker = isDean || isChief;     // 院长/专总 → 专业室可任选目标室
    const canAll = caps.canPublishAll;          // 院长/专总 → 可发全员
    const canDiv = caps.canPublishDivision;     // 室主任 → 可发专业室(本室)
    const showAll = canAll;
    const showDivision = canDiv;
    if (!showAll && !showDivision) return UI.toast('无发布权限');
    const defScope = (canDiv && !canAll) ? 'division' : 'all';

    let divisions = [];
    if (isFreePicker) {
      try { divisions = await API.get('/api/announcements/divisions'); } catch (e) { divisions = []; }
    }
    const myDiv = me.division || '';

    // 专业室范围选择区：院长/专总出下拉选室，室主任锁定本室
    const divWrap = (scope) => {
      if (scope !== 'division') return '';
      if (isFreePicker && divisions.length) {
        return `<select class="input" id="an-div">${divisions.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>`;
      }
      if (myDiv) return `<div class="text-muted" style="margin-top:4px">发往：${esc(myDiv)}</div>`;
      return '';
    };

    UI.modal('发布公告', `
      <div class="field"><label>发布范围</label>
        <div class="seg" id="an-scope">
          ${showAll ? `<button type="button" class="seg-btn ${defScope === 'all' ? 'active' : ''}" data-scope="all">全员</button>` : ''}
          ${showDivision ? `<button type="button" class="seg-btn ${defScope === 'division' ? 'active' : ''}" data-scope="division">专业室</button>` : ''}
        </div>
        <div class="text-muted" style="margin-top:4px">${isFreePicker ? '可任选目标专业室；本室设计师与管理者可见' : '仅本室设计师与管理者可见'}</div>
        <div id="an-div-wrap" style="margin-top:8px">${divWrap(defScope)}</div>
      </div>
      <div class="field"><label>标题<span class="req">*</span></label><input class="input" id="an-title" placeholder="一句话概括"></div>
      <div class="field"><label>内容<span class="req">*</span></label><textarea class="textarea" id="an-content" placeholder="公告正文…"></textarea></div>
      <div class="field"><label>图片（拍摄或相册，可选；详情页直接展示，最多 9 张）</label>
        <input type="file" id="an-photos" accept="image/*" multiple class="sr-only-file">
        <div id="an-photos-grid" class="photo-grid"></div>
      </div>
      <div class="field"><label>附件（文档 / 表格等，可选；点开可下载；发布后自动同步到 IMA 质量库）</label>
        <input type="file" id="an-attach" multiple class="sr-only-file">
        <div id="an-attach-list" class="att-list"></div>
      </div>
      ${durFieldHtml('an')}
      <div class="field"><label class="chk"><input type="checkbox" id="an-ack" checked> 需要已阅确认（关闭则不在该公告中显示已阅功能）</label></div>
      <button class="btn btn-block btn-lg" id="an-submit">发布</button>
    `, (mask, close) => {
      const durEl = mask.querySelector('#an-dur');
      const expEl = mask.querySelector('#an-exp');
      if (durEl && expEl) durEl.onchange = () => { expEl.style.display = durEl.value === '0' ? 'block' : 'none'; };
      const scopeEl = mask.querySelector('#an-scope');
      if (scopeEl) scopeEl.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
        scopeEl.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const w = mask.querySelector('#an-div-wrap');
        if (w) w.innerHTML = divWrap(b.dataset.scope);
      });
      const anAtts = [];
      bindAttachInput(mask, 'an-attach', 'an-attach-list', anAtts);
      const anPhotos = [];
      bindPhotoInput(mask, 'an-photos', 'an-photos-grid', anPhotos);
      mask.querySelector('#an-submit').onclick = async () => {
        const title = mask.querySelector('#an-title').value.trim();
        const content = mask.querySelector('#an-content').value.trim();
        if (!title || !content) return UI.toast('标题和内容必填');
        const active = mask.querySelector('#an-scope .seg-btn.active');
        const scope = active ? active.dataset.scope : 'all';
        let division = null;
        if (scope === 'division') {
          if (isFreePicker) {
            const sel = mask.querySelector('#an-div');
            division = sel ? sel.value : null;
          } else {
            division = myDiv;
          }
        }
        const dur = durEl ? durEl.value : '60';
        const expiry = dur === '0' ? (expEl && expEl.value ? expEl.value : '') : '';
        if (dur === '0' && !expiry) return UI.toast('请选择到期日期');
        const requireAck = mask.querySelector('#an-ack').checked ? 1 : 0;
        try {
          UI.loading(true);
          const r = await API.post('/api/announcements', { title, content, scope, division, durationDays: dur, expiry_date: expiry, attachments: anAtts, photos: anPhotos, require_ack: requireAck });
          close();
          if (r.imaSynced) UI.toast('✅ 已发布并同步到 IMA「00千里行质量公告」');
          else UI.toast('已发布（IMA 同步失败，请稍后在服务端重试）');
          if (location.hash === '#/home' || location.hash === '#/admin') home();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  // ── 置顶 / 取消置顶公告（仅超级管理员；置顶恒排第一条且覆盖公示期）──
  async function togglePinAnnouncement(id, cur) {
    const next = cur ? 0 : 1;
    try {
      UI.loading(true);
      const r = await API.post('/api/announcements/' + id + '/pin', { pinned: next });
      UI.toast(r.message || (next ? '已置顶' : '已取消置顶'));
      const h = location.hash || '#/home';
      if (h === '#/home' || h === '#/admin') home();
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 删除公告（仅管理者）────────────────────
  async function deleteAnnouncement(id) {
    if (!(await UI.confirm('确定删除这条公告？'))) return;
    try {
      UI.loading(true);
      await API.del('/api/announcements/' + id);
      UI.toast('已删除');
      if (location.hash === '#/home' || location.hash === '#/admin') home();
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 修改已发布公告（院长改全部；专总/室主任改自己+设计师发的）────────
  async function editAnnouncement(id) {
    let a;
    try { a = await API.get('/api/announcements/' + id); } catch (e) { return UI.toast(e.message); }
    if (!a.canEdit) return UI.toast('无权限修改该公告');
    const anAtts = Array.isArray(a.attachments) ? a.attachments.slice() : [];
    const anPhotos = Array.isArray(a.photos) ? a.photos.slice() : [];
    UI.modal('修改公告', `
      <div class="field"><label>标题<span class="req">*</span></label><input class="input" id="ea-title" value="${esc(a.title || '')}"></div>
      <div class="field"><label>内容<span class="req">*</span></label><textarea class="textarea" id="ea-content">${esc(a.content || '')}</textarea></div>
      <div class="field"><label>图片（可选；详情页直接展示）</label>
        <input type="file" id="ea-photos" accept="image/*" multiple class="sr-only-file">
        <div id="ea-photos-grid" class="photo-grid"></div>
      </div>
      <div class="field"><label>附件（可选；点开可下载）</label>
        <input type="file" id="ea-attach" multiple class="sr-only-file">
        <div id="ea-attach-list" class="att-list"></div>
      </div>
      ${durFieldHtml('ea', durFromExpiry(a.expiry_date, a.publish_date || a.created_at), (a.expiry_date || '').slice(0, 10))}
      <div class="field"><label class="chk"><input type="checkbox" id="ea-ack" ${a.require_ack === 0 ? '' : 'checked'}> 需要已阅确认（关闭则不在该公告中显示已阅功能）</label></div>
      <button class="btn btn-block btn-lg" id="ea-submit">保存修改</button>
    `, (mask, close) => {
      bindAttachInput(mask, 'ea-attach', 'ea-attach-list', anAtts);
      bindPhotoInput(mask, 'ea-photos', 'ea-photos-grid', anPhotos);
      bindDur(mask, 'ea');
      mask.querySelector('#ea-submit').onclick = async () => {
        const title = mask.querySelector('#ea-title').value.trim();
        const content = mask.querySelector('#ea-content').value.trim();
        if (!title || !content) return UI.toast('标题和内容必填');
        const { durationDays: eaDur, expiry_date: eaExp } = readDur(mask, 'ea');
        const eaAck = mask.querySelector('#ea-ack').checked ? 1 : 0;
        try {
          UI.loading(true);
          await API.put('/api/announcements/' + id, { title, content, attachments: anAtts, photos: anPhotos, durationDays: eaDur, expiry_date: eaExp, require_ack: eaAck });
          close();
          UI.toast('✅ 已保存修改');
          if (location.hash === '#/home' || location.hash === '#/admin') home();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  // ── 发布质量宣贯（所有人可提交；设计身份需审核）─────────────
  const publishDissem = async () => {
    let divisions = [];
    let divisionSubs = {};
    try { const dv = await API.get('/api/divisions'); divisions = dv.divisions || []; divisionSubs = dv.divisionSubs || {}; } catch (e) { divisions = []; }
    const cats = ['标准规范', '质量要求', '优秀经验', '惨痛教训', '质量问答'];
    const regions = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
    const isDesignerOnly = !App.caps.canPublishDissem;
    UI.modal('发布质量宣贯', `
      ${isDesignerOnly ? `<div class="notice" style="margin-bottom:10px">📮 你以设计身份提交，内容将先送对应专业室主任 / 专总审核，通过后才会放出。</div>` : ''}
      <div class="field"><label>标题<span class="req">*</span></label><input class="input" id="qd-title" placeholder="如：两级校审要点宣贯"></div>
      <div class="field"><label>内容<span class="req">*</span></label><textarea class="textarea" id="qd-content" placeholder="宣贯正文…"></textarea></div>
      <div class="field"><label>图片（拍摄或相册，可选；详情页直接展示，最多 9 张）</label>
        <input type="file" id="qd-photos" accept="image/*" multiple class="sr-only-file">
        <div id="qd-photos-grid" class="photo-grid"></div>
      </div>
      <div class="field"><label>附件（文档 / 表格等，可选；点开可下载；审核通过后自动同步到 IMA 质量库）</label>
        <input type="file" id="qd-attach" multiple class="sr-only-file">
        <div id="qd-attach-list" class="att-list"></div>
      </div>
      <div class="field"><label>类型</label><select class="input" id="qd-cat">${cats.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
      <div class="field"><label>面向专业（可多选：先勾一级专业，有二级才展开二级；不选=全院）</label>
        <div id="qd-divs">${UI.subDivCascadingMulti(divisions, divisionSubs, [], [], 'dissemDiv')}</div>
      </div>
      <div class="field"><label>面向地区（可多选，不选=全部地区）</label>
        <div class="chk-group" id="qd-regs">${regions.map(r => `<label class="chk"><input type="checkbox" value="${esc(r)}"> ${esc(r)}</label>`).join('')}</div>
      </div>
      ${durFieldHtml('qd', '90')}
      <div class="field"><label class="chk"><input type="checkbox" id="qd-ack" checked> 需要已阅确认（关闭则不在该宣贯中显示已阅功能）</label></div>
      <button class="btn btn-block btn-lg" id="qd-submit">发布</button>
    `, (mask, close) => {
      const durEl = mask.querySelector('#qd-dur');
      const expEl = mask.querySelector('#qd-exp');
      durEl.onchange = () => { expEl.style.display = durEl.value === '0' ? 'block' : 'none'; };
      const qdAtts = [];
      bindAttachInput(mask, 'qd-attach', 'qd-attach-list', qdAtts);
      const qdPhotos = [];
      bindPhotoInput(mask, 'qd-photos', 'qd-photos-grid', qdPhotos);
      const qdWrap = mask.querySelector('#qd-divs');
      if (qdWrap) qdWrap.querySelectorAll('input.casc-major').forEach(cb => {
        cb.addEventListener('change', () => {
          const major = cb.dataset.major;
          const subsWrap = qdWrap.querySelector('.casc-subs[data-major="' + (window.CSS && CSS.escape ? CSS.escape(major) : major) + '"]');
          if (cb.checked) {
            if (!subsWrap) {
              const div = document.createElement('div');
              div.className = 'casc-subs'; div.dataset.major = major;
              div.innerHTML = UI.subDivCascadingSubsHtml(major, divisionSubs, [], 'dissemDiv');
              cb.closest('label').insertAdjacentElement('afterend', div);
            }
          } else if (subsWrap) {
            subsWrap.querySelectorAll('input[data-sub]').forEach(s => { s.checked = false; });
            subsWrap.remove();
          }
        });
      });
      mask.querySelector('#qd-submit').onclick = async () => {
        const title = mask.querySelector('#qd-title').value.trim();
        const content = mask.querySelector('#qd-content').value.trim();
        if (!title || !content) return UI.toast('标题和内容必填');
        const category = mask.querySelector('#qd-cat').value;
        const ds = UI.collectSubDivCascading(mask.querySelector('#qd-divs'));
        const divs = ds.divisions;
        const regions = [...mask.querySelectorAll('#qd-regs input:checked')].map(c => c.value);
        const subDivs = ds.subDivisions;
        const dur = durEl.value;
        const expiry = dur === '0' ? (expEl.value || '') : '';
        if (dur === '0' && !expiry) return UI.toast('请选择到期日期');
        const requireAck = mask.querySelector('#qd-ack').checked ? 1 : 0;
        try {
          UI.loading(true);
          const r = await API.post('/api/quality-dissem', { title, content, category, divisions: divs, regions, subDivisions: subDivs, durationDays: dur, expiry_date: expiry, attachments: qdAtts, photos: qdPhotos, require_ack: requireAck });
          close();
          if (r.status === 'pending') UI.toast('已提交，待专业室主任 / 专总审核通过后放出');
          else if (r.imaSynced) UI.toast('✅ 已发布并同步到 IMA「01千里行质量宣贯」');
          else UI.toast('已发布（IMA 同步失败，请稍后重试）');
          if (location.hash === '#/home') home();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  // ── 删除质量宣贯（管理者 / 作者删自己的待审核项）────────────────
  const deleteDissem = async (id) => {
    if (!(await UI.confirm('确定删除这条质量宣贯？'))) return;
    try {
      UI.loading(true);
      await API.del('/api/quality-dissem/' + id);
      UI.toast('已删除');
      if (location.hash === '#/home') home();
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 修改已发布质量宣贯（院长改全部；专总/室主任改自己+设计师发的）────────
  const editDissem = async (id) => {
    let d;
    try { d = await API.get('/api/quality-dissem/' + id); } catch (e) { return UI.toast(e.message); }
    if (!d.canEdit) return UI.toast('无权限修改该宣贯');
    let divisions = []; let divisionSubs = {};
    try { const dv = await API.get('/api/divisions'); divisions = dv.divisions || []; divisionSubs = dv.divisionSubs || {}; } catch (e) { divisions = []; }
    const cats = ['标准规范', '质量要求', '优秀经验', '惨痛教训', '质量问答'];
    const regions = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
    const selCats = d.category || '通用';
    const selDivs = Array.isArray(d.divisions) ? d.divisions : [];
    const selRegs = Array.isArray(d.regions) ? d.regions : [];
    const selSubs = Array.isArray(d.subDivisions) ? d.subDivisions : [];
    const qdAtts = Array.isArray(d.attachments) ? d.attachments.slice() : [];
    const qdPhotos = Array.isArray(d.photos) ? d.photos.slice() : [];
    UI.modal('修改质量宣贯', `
      <div class="field"><label>标题<span class="req">*</span></label><input class="input" id="ed-title" value="${esc(d.title || '')}"></div>
      <div class="field"><label>内容<span class="req">*</span></label><textarea class="textarea" id="ed-content">${esc(d.content || '')}</textarea></div>
      <div class="field"><label>分类</label><select class="input" id="ed-cat">${cats.map(c => `<option value="${esc(c)}" ${c === selCats ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label>面向专业（可多选：先勾一级专业，有二级才展开二级）</label>
        <div id="ed-divs">${UI.subDivCascadingMulti(divisions, divisionSubs, selDivs, selSubs, 'dissemDiv')}</div>
      </div>
      <div class="field"><label>地区（可多选）</label><div id="ed-regs" class="chk-group">${regions.map(rg => `<label class="chk"><input type="checkbox" value="${esc(rg)}" ${selRegs.includes(rg) ? 'checked' : ''}> ${esc(rg)}</label>`).join('')}</div></div>
      ${durFieldHtml('ed', durFromExpiry(d.expiry_date, d.publish_date || d.created_at), (d.expiry_date || '').slice(0, 10))}
      <div class="field"><label>图片（可选；详情页直接展示）</label>
        <input type="file" id="ed-photos" accept="image/*" multiple class="sr-only-file">
        <div id="ed-photos-grid" class="photo-grid"></div>
      </div>
      <div class="field"><label>附件（可选；点开可下载）</label>
        <input type="file" id="ed-attach" multiple class="sr-only-file">
        <div id="ed-attach-list" class="att-list"></div>
      </div>
      <button class="btn btn-block btn-lg" id="ed-submit">保存修改</button>
    `, (mask, close) => {
      bindAttachInput(mask, 'ed-attach', 'ed-attach-list', qdAtts);
      bindPhotoInput(mask, 'ed-photos', 'ed-photos-grid', qdPhotos);
      bindDur(mask, 'ed');
      const edWrap = mask.querySelector('#ed-divs');
      if (edWrap) edWrap.querySelectorAll('input.casc-major').forEach(cb => {
        cb.addEventListener('change', () => {
          const major = cb.dataset.major;
          const subsWrap = edWrap.querySelector('.casc-subs[data-major="' + (window.CSS && CSS.escape ? CSS.escape(major) : major) + '"]');
          if (cb.checked) {
            if (!subsWrap) {
              const div = document.createElement('div');
              div.className = 'casc-subs'; div.dataset.major = major;
              div.innerHTML = UI.subDivCascadingSubsHtml(major, divisionSubs, [], 'dissemDiv');
              cb.closest('label').insertAdjacentElement('afterend', div);
            }
          } else if (subsWrap) {
            subsWrap.querySelectorAll('input[data-sub]').forEach(s => { s.checked = false; });
            subsWrap.remove();
          }
        });
      });
      mask.querySelector('#ed-submit').onclick = async () => {
        const title = mask.querySelector('#ed-title').value.trim();
        const content = mask.querySelector('#ed-content').value.trim();
        if (!title || !content) return UI.toast('标题和内容必填');
        const edDivSub = UI.collectSubDivCascading(mask.querySelector('#ed-divs'));
        const edDivs = edDivSub.divisions;
        const edSubs = edDivSub.subDivisions;
        const edRegs = [...mask.querySelectorAll('#ed-regs input:checked')].map(c => c.value);
        const category = mask.querySelector('#ed-cat').value;
        const { durationDays: edDur, expiry_date: edExp } = readDur(mask, 'ed');
        try {
          UI.loading(true);
          await API.put('/api/quality-dissem/' + id, {
            title, content, category,
            divisions: edDivs, regions: edRegs, subDivisions: edSubs,
            attachments: qdAtts, photos: qdPhotos,
            durationDays: edDur, expiry_date: edExp,
          });
          close();
          UI.toast('✅ 已保存修改');
          if (location.hash === '#/home') home();
          else if (location.hash === '#/admin') Pages.admin();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  // ── 审核通过并放出（管理者；可附审批批注，类似院选人人讲最后的批注）────────────────
  const approveDissem = async (id) => {
    UI.modal('通过并放出（可附审批批注）', `
      <p class="text-muted" style="font-size:var(--fs-t5);margin:0 0 10px">通过后将放出至质量宣贯首页，并同步 IMA 质量宣贯库。非专总/室主任发布的宣贯，可在此附一条批注（展示在宣贯条下方，全员可见）。</p>
      <div class="field"><label>审批批注（可选）</label><textarea class="textarea" id="appr-note" placeholder="如：建议补充 XX 规范条文、注意与 XX 对齐…"></textarea></div>
      <div class="modal-actions"><button class="btn" id="appr-ok">通过并放出</button></div>
    `, (mask, close) => {
      const ok = mask.querySelector('#appr-ok');
      if (ok) ok.onclick = async () => {
        const note = mask.querySelector('#appr-note').value.trim();
        UI.loading(true);
        try {
          const r = await API.post('/api/quality-dissem/' + id + '/approve', { note });
          UI.toast(r.imaSynced ? '✅ 已审核通过并放出（已同步 IMA 质量宣贯库）' : '已审核通过并放出（IMA 同步失败）');
          close();
          if (location.hash === '#/admin') Pages.admin(); else home();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  // ── 驳回（管理者；提交人可见"未通过"）────────────────
  const rejectDissem = async (id) => {
    if (!(await UI.confirm('驳回这条质量宣贯？（提交人会看到"未通过"）'))) return;
    try {
      UI.loading(true);
      await API.post('/api/quality-dissem/' + id + '/reject');
      UI.toast('已驳回');
      if (location.hash === '#/admin') Pages.admin(); else home();
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 待我处理「点击处理」：跳到关联页面 ────────
  // 提醒若关联了 PDCA 问题 → 打开该问题详情（在 PDCA 解决问题栏）；否则跳到备忘/提醒列表
  async function openReminderTarget(reminderId, problemId) {
    // 点击处理仅跳转到关联内容，不自动标记为完成。
    // 否则专家/用户点开看一眼未实际处理、返回后待办即消失（应由用户显式点「标记完成」）。
    if (problemId) {
      location.hash = '#/pdca';
      setTimeout(() => Pages.pdcaDetail(problemId), 80);
    } else {
      location.hash = '#/work';
    }
  }

  return { login, changePwd, home, publishAnnouncement, deleteAnnouncement, togglePinAnnouncement, topbar, tabbar, circleTabs, openReminderTarget, goUp,
    publishDissem, deleteDissem, approveDissem, rejectDissem, viewAnnouncement, viewDissem,
    editAnnouncement, editDissem, fillAckCounts, loadDissem, reminderDismiss,
  // 下面在 pages2.js 补充
};
})();

// 首页 9 条折叠「展开更多 / 收起」：须定义在 IIFE 之外，否则初始化期引用 Pages 触发 TDZ 白屏
(() => {
  // 两级展开控制器：
  //  data-act="expand" 单层级场景(到全部)：切换 .capped-rest 显隐，文案在「展开更多(N)」↔「收起 ▲」
  //  data-act="l1"     第一级：展开 .capped-rest-1，隐藏自身、显示「展开全部」按钮
  //  data-act="all"    第二级：展开 .capped-rest-2 显「收起 ▲」；再点则整体收回到 第一级 状态
  Pages.toggleCap = (btn) => {
    const wrap = btn.closest('.cap-wrap');
    if (!wrap) return;
    const act = btn.dataset.act;
    if (act === 'expand') {
      const rest = wrap.querySelector('.capped-rest');
      const collapsed = rest.style.display === 'none';
      rest.style.display = collapsed ? 'block' : 'none';
      btn.textContent = collapsed ? '收起 ▲' : btn.dataset.labelExpand;
      return;
    }
    if (act === 'l1') {
      wrap.querySelector('.capped-rest-1').style.display = 'block';
      btn.style.display = 'none';
      const allBtn = wrap.querySelector('.cap-toggle[data-act="all"]');
      if (allBtn) allBtn.style.display = 'block';
      return;
    }
    if (act === 'all') {
      const rest2 = wrap.querySelector('.capped-rest-2');
      const collapsed = rest2.style.display === 'none';
      if (collapsed) {
        rest2.style.display = 'block';
        btn.textContent = '收起 ▲';
      } else {
        rest2.style.display = 'none';
        wrap.querySelector('.capped-rest-1').style.display = 'none';
        const l1Btn = wrap.querySelector('.cap-toggle[data-act="l1"]');
        if (l1Btn) l1Btn.style.display = 'block';
        btn.style.display = 'none';
        btn.textContent = btn.dataset.labelAll;
      }
    }
  };
})();

// 备注编辑：必须定义在 const Pages IIFE 之外，否则初始化期引用 Pages 会触发 TDZ 白屏
(() => {
  Pages.editNote = async function (source, id) {
    let current = '';
    try {
      const d = source === 'dissem' ? await API.get('/api/quality-dissem/' + id) : await API.get('/api/pdca/problems/' + id);
      current = d.manager_note || '';
    } catch (e) {}
    UI.modal('备注', `
      <div class="field">
        <label>审批批注（仅管理者可编辑；内容对全员可见）</label>
        <textarea class="textarea" id="note-input" placeholder="对该设计师帖的批注…">${UI.esc(current)}</textarea>
      </div>
      <div class="modal-actions">
        ${current ? '<button class="btn btn-outline" id="note-clear">清空</button>' : ''}
        <button class="btn" id="note-save">保存</button>
      </div>
    `, (mask, close) => {
      const save = mask.querySelector('#note-save');
      if (save) save.onclick = async () => {
        const v = mask.querySelector('#note-input').value.trim();
        UI.loading(true);
        try {
          const url = source === 'dissem' ? `/api/quality-dissem/${id}/note` : `/api/pdca/problems/${id}/note`;
          await API.put(url, { note: v });
          UI.toast(v ? '已保存备注' : '已清空备注');
          close();
          if (source === 'dissem') Pages.viewDissem(id); else Pages.pdcaDetail(id);
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
      const clr = mask.querySelector('#note-clear');
      if (clr) clr.onclick = () => { mask.querySelector('#note-input').value = ''; };
    });
  };
})();
