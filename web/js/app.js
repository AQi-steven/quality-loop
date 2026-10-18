/**
 * 应用入口 + 哈希路由
 *
 * DEMO_MODE：无后端时用浏览器内存演示（localStorage）
 * 部署到腾讯云后把 DEMO_MODE 改为 false 即走真实 API
 */

// ★ 演示开关：true=浏览器演示（mock数据），false=真实后端（Express+SQLite）
// 部署到腾讯云后保持 false 即可；本地联调也用 false（Express 同源托管前端+API）
window.DEMO_MODE = false;

// 能力模型（与后端 rbac.js 保持一致）：角色只是标签，界面看能力
const DESIGN_ROLES = ['designer', 'section_leader', 'chief', 'dean', 'chief_engineer', 'expert'];
const MANAGE_ROLES = ['section_leader', 'chief', 'dean', 'admin', 'leader'];
const PUBLISH_ALL_ROLES = ['dean', 'chief'];
// 与后端 rbac.js 的 SUPER 保持一致：系统管理员（admin 或 leader 旧别名）
const SUPER_ROLES = ['admin', 'leader'];
// 可删除任意质量宣贯的角色：系统管理员 + 院长 + 专总
const DELETE_DISSEM_ROLES = ['admin', 'leader', 'dean', 'chief'];
// 与后端 rbac.js 的 PUBLISH_DIV 保持一致：室主任（限本室）+ 院长/专总（可任选任意室）
const PUBLISH_DIV_ROLES = ['section_leader', 'dean', 'chief'];
// 与后端 rbac.js 的 PUBLISH_DISSEM 保持一致：院长 + 专总 + 室主任
const PUBLISH_DISSEM_ROLES = ['dean', 'chief', 'section_leader'];
// 入参：role 字符串 或 用户对象 {role, extraRoles}
function rolesOf(input) {
  if (typeof input === 'string') return [input];
  if (!input || !input.role) return [];
  const set = [input.role];
  const ex = input.extraRoles;
  if (Array.isArray(ex)) set.push(...ex);
  else if (typeof ex === 'string' && ex) { try { set.push(...JSON.parse(ex)); } catch (e) {} }
  return set;
}

// 移动端「添加到主屏幕」引导条：仅手机、且未以 standalone 方式打开（即尚未加到桌面）、
// 且未被用户关闭过时显示。微信内无法直接加到桌面，额外提示「在浏览器打开」。
function qcShowHomeHint() {
  try {
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    if (standalone) return;                 // 已加到桌面，无需提示
    if (window.self !== window.top) return; // iframe 内不显示
    const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (!isMobile) return;                  // 桌面端不显示
    try { if (localStorage.getItem('qc_homehint_dismissed') === '1') return; } catch (e) {}
    const ua = (navigator.userAgent || '').toLowerCase();
    const inWeChat = ua.indexOf('micromessenger') !== -1;
    const bar = document.createElement('div');
    bar.className = 'home-hint';
    bar.innerHTML = '<span class="home-hint-txt">' +
      (inWeChat
        ? '微信内无法直接加到桌面：点右上角 ⋯ →「在浏览器打开」，再「添加到主屏幕」'
        : '把千里行放到手机桌面：浏览器菜单 →「添加到主屏幕」（iPhone：分享 → 添加到主屏幕）') +
      '</span><button type="button" class="home-hint-x" aria-label="关闭">×</button>';
    document.body.appendChild(bar);
    bar.querySelector('.home-hint-x').addEventListener('click', () => {
      try { localStorage.setItem('qc_homehint_dismissed', '1'); } catch (e) {}
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
  } catch (e) {}
}

function deriveCaps(input) {
  // 游客账户：仍按自身角色（designer / section_leader / chief / dean + extra_roles）派生「视野」，
  // 使 guest1=设计师全视野、guest2=室主任全视野、guest3=专总视野、guest9=超级管理员（院长+专家）全视野——
  // 但「写能力」（发布/删除/管理动作）一律强制关闭，确保纯只读（后端 auth 中间件对非 GET 也 403 兜底）。
  const roles = rolesOf(input);
  const isGuest = !!(input && (input.isGuest || input.role === 'guest'));
  const caps = {
    canDesign: roles.some(r => DESIGN_ROLES.includes(r)),
    canManage: roles.some(r => MANAGE_ROLES.includes(r)),
    // 2026-07-26 修复 P0①：系统管理员(admin/leader) 经 SUPER_ROLES 一并获得三套发布能力（与后端 rbac 保持一致）
    canPublishAll: roles.some(r => PUBLISH_ALL_ROLES.includes(r)) || roles.some(r => SUPER_ROLES.includes(r)),
    canPublishDivision: roles.some(r => PUBLISH_DIV_ROLES.includes(r)) || roles.some(r => SUPER_ROLES.includes(r)),
    canPublishDissem: roles.some(r => PUBLISH_DISSEM_ROLES.includes(r)) || roles.some(r => SUPER_ROLES.includes(r)),
    canDeleteDissem: roles.some(r => DELETE_DISSEM_ROLES.includes(r)),
    // 公告发布权限（2026-09 收窄）：仅超级管理员 + 专总，与后端 announcements.js POST 门禁一致
    canPublishAnnouncement: (input.username === 'superadmin') || roles.some(r => r === 'chief'),
    isGuest,
    // 可考试游客（EXAMGUEST1~EXAMGUEST9）：纯只读基础上，唯一被放行的操作＝参加「检验池」考试 + 看排名
    // （后端 middleware/auth 同步放行 start/draft/submit 三个写接口，其余写操作仍 403）
    canExam: !!(input && input.canExam),
  };
  // 游客：纯只读——所有「发布/删除/管理写动作」能力强制关闭（仅保留视野 canDesign/canManage 决定可看哪些版面）
  if (isGuest) {
    caps.canPublishAll = false;
    caps.canPublishDivision = false;
    caps.canPublishDissem = false;
    caps.canDeleteDissem = false;
    caps.canPublishAnnouncement = false;
  }
  return caps;
}

// 全局：当前登录用户是否为超级管理员（超级用户，具任意条目任意状态的删除权）
// 与后端 rbac.isSuperAdmin 对齐；仅看 username / realName 字符串，不接受数字 id。
function isSuperAdmin() {
  return !!(App.user && (App.user.username === 'superadmin'));
}

const App = {
  user: null,
  caps: { canDesign: false, canManage: false, canDeleteDissem: false, isGuest: false, canExam: false },
  unreadReminders: 0,   // 「我的」(右上角头像) 红点 = 私信未读数
  pendingAdmin: 0,      // 「管理」tab 红点 = 宣贯审核待通过 + 人人讲院选待精选（纯管理动作）
  pendingPdca: 0,       // 「PDCA」tab 红点 = 我的流程待办（被请教 / 共议邀请 / 待补充，related_problem_id 非空）
  _routing: false,      // 路由互斥锁：防止 hashchange + 手动调用 并发导致白屏

  // 同步角标：① 手机主屏 App 图标红点(HTTPS+PWA) ② 右上角头像红点(我的) ③ 底部「管理」「PDCA」tab 红点
  // 设计原则：每类提醒对号入座到所属 tab，不混叠：
  //   · 我的(头像) = 纯私信未读（related_problem_id 为空）
  //   · PDCA tab   = 我的流程待办（被请教 / 共议邀请 / 待补充，related_problem_id 非空）
  //   · 管理 tab   = 宣贯审核待通过 + 人人讲院选待精选（纯管理动作，仅管理者可见）
  async syncBadge() {
    if (!this.user) return;
    try {
      const [inbox, dissemPending, rrjPending] = await Promise.all([
        API.get('/api/reminders/inbox').catch(() => []),
        API.get('/api/quality-dissem/pending').catch(() => []),
        API.get('/api/pdca/rrj-pending').catch(() => ({ count: 0 })),
      ]);
      // 「我的」(头像) 红点 = 仅纯私信未读（related_problem_id 为空）
      const unread = (inbox || []).filter((r) => r.state !== 'done' && !r.related_problem_id).length;
      // 「PDCA」tab 红点 = 我的流程待办（related_problem_id 非空）
      const pdcaTodo = (inbox || []).filter((r) => r.state !== 'done' && r.related_problem_id).length;
      // 「管理」tab 红点 = 宣贯审核待通过 + 人人讲院选待精选
      const dissemCount = Array.isArray(dissemPending) ? dissemPending.length : 0;
      const rrjCount = (rrjPending && typeof rrjPending.count === 'number') ? rrjPending.count : 0;
      this.unreadReminders = unread;                // 「我的」(头像)
      this.pendingPdca = pdcaTodo;                  // 「PDCA」tab
      this.pendingAdmin = dissemCount + rrjCount;   // 「管理」tab
      // App 图标角标：仅 HTTPS + 已安装 PWA 有效；显示全部未处理事项总数
      const total = this.pendingAdmin + this.pendingPdca + this.unreadReminders;
      const canBadge = ('setAppBadge' in navigator) && location.protocol === 'https:';
      if (canBadge) {
        try { total > 0 ? await navigator.setAppBadge(total) : await navigator.clearAppBadge(); } catch (e) {}
      }
      this.updateNavBadgeDOM();
    } catch (e) { /* 失败不影响主流程 */ }
  },

  // 直接更新底部「管理」「PDCA」tab 小红点与右上角头像(我的)小红点（无需整页重渲染）
  updateNavBadgeDOM() {
    const setBadge = (id, n) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (n > 0) { el.textContent = n > 99 ? '99+' : String(n); el.style.display = 'inline-block'; }
      else { el.style.display = 'none'; }
    };
    setBadge('nav-badge', this.pendingAdmin || 0);        // 管理 tab
    setBadge('nav-badge-pdca', this.pendingPdca || 0);    // PDCA tab
    setBadge('avatar-badge', this.unreadReminders || 0);  // 我的/头像
  },

  // 供其它页面（标记提醒完成后）调用，刷新角标
  updateReminderBadge() { return this.syncBadge(); },

  // 标记"最近活跃"：浏览/筛选/翻页也算活跃（不要求具体内容操作）。
  // 前端节流 30s，服务端再限频 1 分钟，避免频繁写入。
  markActive() {
    if (!this.user) return;
    const now = Date.now();
    if (this._lastActivePing && now - this._lastActivePing < 30000) return;
    this._lastActivePing = now;
    API.post('/api/auth/active').catch(() => {});
  },

  // 绑定"浏览即活跃"心跳：翻页、切换栏目、筛选、搜索、切回前台都计为活跃
  bindActiveHeartbeat() {
    const ping = () => this.markActive();
    const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
    const dPing = debounce(ping, 1500);
    window.addEventListener('hashchange', dPing);   // 切换栏目/翻页 = 浏览
    document.addEventListener('change', dPing);      // 筛选/勾选/下拉 = 筛选浏览
    document.addEventListener('submit', dPing);      // 搜索提交 = 浏览
    document.addEventListener('input', dPing);       // 搜索框输入 = 浏览
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
    // 长会话保持：每 4 分钟（仅前台可见时）刷新一次
    setInterval(() => { if (!document.hidden) ping(); }, 4 * 60 * 1000);
  },

  async init() {
    // Service Worker：注册「常驻 · 纯网络透传 · 零缓存」SW，仅用于满足
    // Chrome / Android「可安装到主屏幕」标准。本 SW 不缓存任何资源、不拦截响应，
    // 所有请求走网络，故不会重现旧版 cache-first SW 把 502 当静态缓存导致白屏的问题，
    // 也不阻碍部署更新即时生效（每次均走网络 + 入口页版本戳强制刷新）。
    // 旧版自杀型 SW 在同一作用域下会被本注册自动取代；其遗留缓存由新 SW 激活时清空。
    if ('serviceWorker' in navigator && location.protocol === 'https:' && window.self === window.top) {
      try { await navigator.serviceWorker.register('/sw.js'); } catch (e) {}
    }
    // 移动端「添加到主屏幕」引导条（桌面 / 已安装 / iframe 内不显示）
    qcShowHomeHint();
    window.addEventListener('hashchange', () => this.route());
    // 尝试恢复登录态
    if (API.getToken()) {
      try {
        this.user = await API.get('/api/auth/me');
        this.caps = deriveCaps(this.user);
      } catch (e) { API.clearToken(); }
    }
    // ── 默认落地：质量库(#/work) ───────────────────────────────────────────────
    // 背景：#/home（公告宣贯）是历史默认落地。微信网页版会把地址栏里的 hash 一路保留
    //   —— server 入口 302 与 index.html 版本自检都显式保留 hash（`var h = location.hash || ''`）
    //   —— 于是「地址栏带 #/home」的会话每次打开都停在公告宣贯，改多少次部署都不生效。
    // 规则：
    //   ① 打开链接/启动程序（导航类型 navigate）：把「栏目级」hash（空、#/home、#/work、
    //      #/pdca、#/memo、#/admin）统一落到 #/work；
    //   ② #/home 即使刷新(reload)也归一（它就是需要被顶掉的错误默认值）；
    //   ③ 其余情况（刷新/前进后退停在 #/pdca、#/memo、#/admin、#/work）尊重当前 hash
    //      —— 刷新仍在本界面；
    //   ④ 详情深链（#/pdca/<id>、#/memo/<id>）与特殊页（login/change-pwd/profile…）永不改写；
    //   ⑤ 仅对拥有「质量库」入口者（canDesign/canManage，与底部 tab 条件一致）归一。
    let navType = 'navigate';
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) navType = nav.type;
      else if (performance.navigation) navType = ({ 0: 'navigate', 1: 'reload', 2: 'back_forward' })[performance.navigation.type] || 'navigate';
    } catch (e) {}
    const TAB_LEVEL_HASH = ['', '#/home', '#/work', '#/pdca', '#/memo', '#/admin'];
    const canLib = !!(this.caps && (this.caps.canDesign || this.caps.canManage));
    const curHash = location.hash;
    const isTabLevel = TAB_LEVEL_HASH.includes(curHash);
    if (!curHash && !this.user) {
      location.hash = '#/login';
    } else if (canLib && isTabLevel && curHash !== '#/work' && (navType === 'navigate' || curHash === '#/home')) {
      location.hash = '#/work';
    } else if (!curHash) {
      location.hash = this.user ? '#/work' : '#/login';
    } else {
      this.route();
    }
    // 登录后同步一次角标；页面重新可见时也同步（应对后台收到新提醒）
    if (this.user) {
      this.syncBadge();
      this.bindActiveHeartbeat();
      // 开场小红花动画（展示当前质量双月领先者），仅在冷启动时触发
      if (window.QCSplash) window.QCSplash.show();
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.user) this.syncBadge();
    });
    // PWA / Service Worker 已停用：本内部工具启用 SW 后，后端偶发重启（如嵌套事务崩溃）
    // 时 SW 会把 502 响应当作静态资源缓存，导致刷新后永久白屏；且阻碍部署更新即时生效。
    // 故不再注册。如需离线壳层，需改用 navigation network-first + 静态资源 stale-while-revalidate
    // 且绝不缓存非 2xx 响应。
    // 平台欢迎弹窗（仅首次提示，用户点「我知道了」后永久不再弹；硬刷/重开均不再打扰）
    this.maybeShowWelcome();
  },

  maybeShowWelcome() {
    try {
      const KEY = 'qc_welcome_seen';
      let seen = false;
      try { seen = !!localStorage.getItem(KEY); } catch (e) {}
      if (seen) return;  // 已关闭过 → 永久不再弹（含硬刷、重新打开标签页）

      const title = '欢迎使用质量千里行';
      const body = `
        <div style="font-size:var(--fs-t4);line-height:1.75;color:#333;">
          <p>本平台作为本院质量公告、宣贯、质量问题研究和解决、质量优秀案例展示以及月度、季度、年度质量评价的总入口和信息交互平台。</p>
          <p>在这里，大家可以提问质量问题、共享质量做法、发布质量信息（获批），并获得小红花奖励（作为月度质量系数依据）。</p>
          <p>注意：对时效要求高的质量信息沟通仍旧可以使用线下当面、电话、微信等方式，但重要的、需要沉淀的信息要在这里长期留存，本平台的有效信息会自动存储于IMA 千里行质量库。</p>
          <p>质量工作上：人人都是参与者、人人都是宣贯者、人人都是监督者、人人都是受益者，有任何好的建议随时提出！</p>
        </div>
        <div style="margin-top:16px;text-align:right;font-size:var(--fs-t5);color:#999;">（本提示仅出现一次，关闭后不再弹出）</div>
        <div class="row-btns" style="margin-top:8px;">
          <button class="btn btn-primary" id="welcome-ok">我知道了</button>
        </div>`;
      UI.modal(title, body, (mask, close) => {
        const btn = mask.querySelector('#welcome-ok');
        if (btn) btn.addEventListener('click', () => {
          try { localStorage.setItem(KEY, '1'); } catch (e) {}
          close();
        });
      });
    } catch (e) {
      // 弹窗失败不应阻断主程序
    }
  },

  async route() {
    // 互斥锁：防止 init() 设置 hash 触发 hashchange + 同步 route() 并发执行
    // （两次 Pages.home() 同时跑，后一次覆盖 #app 导致前一次 await 后找不到 DOM 元素）
    // 在途导航标记：渲染期间若 hash 又变（用户切 tab），渲染完成后补一次 route()，避免「点了没反应」
    if (this._routing) { this._routeDirty = true; return; }
    this._routing = true;
    const targetHash = location.hash;
    try {
      const hash = location.hash.slice(1) || '/login';
      const [, page] = hash.match(/^\/([^/]*)\/?(.*)$/) || [];

      // 未登录守卫
      if (!this.user && page !== 'login') { location.hash = '#/login'; return; }
      if (this.user && page === 'login') { location.hash = '#/work'; return; }

      window.scrollTo(0, 0);

      let rendered;
      try {
        switch (page) {
          case 'login': rendered = Pages.login(); break;
          case 'change-pwd':
            // 游客账户纯只读，禁止进入改密码界面（后端写操作本就 403 兜底）
            if (this.caps.isGuest) { location.hash = '#/home'; return; }
            rendered = Pages.changePwd(); break;
          case 'home': case '': rendered = Pages.home(); break;
          case 'pdca': rendered = Pages.pdca(); break;
          case 'work': rendered = Pages.work(); break;
          case 'memo': rendered = Pages.memo(); break;
          case 'profile': rendered = Pages.profile(); break;
          case 'admin':
            // 游客（纯只读）可进入管理版面查看（尤其小红花榜），但无任何操作入口；
            // 其余按 canManage/canDesign 判定能否进入
            if (!this.caps.canManage && !this.caps.canDesign) { location.hash = '#/home'; return; }
            rendered = Pages.admin(); break;
          case 'flowers': rendered = Pages.flowers(); break;
          case 'my-flowers': rendered = Pages.myFlowers(); break;
          case 'flower-adjust': rendered = Pages.flowerAdjust(); break;
          default: rendered = Pages.home();
        }
      } catch (err) {
        return this.handleRenderError(err);
      }
      // 异步渲染若 rejected，也兜住，避免整页空白（白屏）
      if (rendered && typeof rendered.catch === 'function') {
        rendered.catch(err => this.handleRenderError(err));
      }
    } finally {
      // 用 setTimeout 解锁，确保微任务队列清空后再允许下次路由（避免 finally 立刻放行后被同步代码再次进入）
      setTimeout(() => {
        this._routing = false;
        // 渲染期间若有新的导航（用户切 tab），补偿一次路由，消除「需二次点击」
        if (this._routeDirty && location.hash !== targetHash) {
          this._routeDirty = false;
          this.route();
        }
      }, 0);
    }
  },

  // 全局兜底：任何页面渲染异常都只提示，绝不整页空白（防白屏）
  handleRenderError(err) {
    try { console.error('[route] render error:', err); } catch (e) {}
    try { if (typeof UI !== 'undefined' && UI.toast) UI.toast('页面渲染出错：' + (err && err.message ? err.message : err)); } catch (e) {}
  },

  logout() {
    API.clearToken();
    this.user = null;
    location.hash = '#/login';
    UI.toast('已退出登录');
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
