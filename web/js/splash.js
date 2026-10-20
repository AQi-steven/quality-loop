/**
 * 开场小红花动画（质量管理部门 · 质量千里行）
 *
 * - 频率（2026-10-18 大会加固，用户拍板）：每台设备**每天仅一次**
 *   （localStorage 记日期，同一天内刷新/重开/新标签不再演出，跨天自动恢复；
 *   隐私模式等 localStorage 不可用时退回"每次整页加载都演出"的旧行为）。
 * - 时机（2026-10-18 大会加固，用户拍板）：遮罩**立即**演出（不再空等接口），
 *   「本月领先者」并行拉取后填入姓名位——姓名淡入有 0.78s 动画延迟，接口通常
 *   ~300ms 内返回，几乎总能准时随花出现；遮罩 3.2s 后自动淡出，不阻塞任何操作。
 * - SPA 内部切 tab / hash 路由跳转不重载页面，不会重复触发。
 * - 一朵 🌸（与小红花榜 fb-bloom 同一朵樱花、同一绽放节奏）由小放大+轻微旋转绽放，
 *   下方显示当前「本月」领先者姓名（与红花榜「本月领先」口径一致：summary.month，
 *   含质量工作奖惩）。
 * - 纯装饰层（pointer-events:none），约 3.2s 后自动淡出，不阻塞任何操作
 * - 尊重 prefers-reduced-motion：关闭动画直接显示静态花朵
 */
(function () {
  'use strict';

  // 同一「整页加载」内只显示一次的瞬时守卫（防止 App.init 冷启动与登录成功回调在同一加载里重复触发）。
  var shownThisLoad = false;
  // 每天仅一次：记录上次演出日期（YYYY-MM-DD，本地时区）
  var SPLASH_DAY_KEY = 'qc_splash_last_day';

  function todayKey() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function alreadyShownToday() {
    try { return localStorage.getItem(SPLASH_DAY_KEY) === todayKey(); } catch (e) { return false; }
  }
  function markShownToday() {
    try { localStorage.setItem(SPLASH_DAY_KEY, todayKey()); } catch (e) { /* 隐私模式：不持久化，退回每次演出 */ }
  }

  // 解析 API 引用：api.js 用「顶层 const API」声明（经典脚本顶层 const 不会挂到 window），
  // 因此绝不能写 window.API，须直接引用全局词法环境中的 API；同时兼容个别环境挂到 window 的情况。
  function getApi() {
    try {
      if (typeof window !== 'undefined' && window.API && typeof window.API.get === 'function') return window.API;
    } catch (e) {}
    try {
      if (typeof API !== 'undefined' && typeof API.get === 'function') return API;
    } catch (e) {}
    return null;
  }

  function injectStyle() {
    if (document.getElementById('qc-splash-style')) return;
    var s = document.createElement('style');
    s.id = 'qc-splash-style';
    s.textContent = [
      '.qc-splash{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;',
      '  align-items:center;justify-content:center;pointer-events:none;opacity:0;',
      '  transition:opacity .55s ease;',
      '  background:radial-gradient(circle at 50% 46%, rgba(255,255,255,.97), rgba(244,249,248,.99));}',
      '.qc-splash.show{opacity:1;}',
      '.qc-glow{position:absolute;width:320px;height:320px;border-radius:50%;',
      '  background:radial-gradient(circle, rgba(233,30,99,.16), rgba(233,30,99,0) 70%);',
      '  filter:blur(10px);animation:qcGlow 2.6s ease-in-out infinite;}',
      '@keyframes qcGlow{0%,100%{transform:scale(.92);opacity:.65}50%{transform:scale(1.12);opacity:1}}',
      '.qc-bloom{font-size:120px;line-height:1;transform:scale(.35) rotate(-14deg);opacity:0;',
      '  text-shadow:0 8px 26px rgba(214,51,108,.30);',
      '  animation:qcBloom .9s cubic-bezier(.2,.8,.25,1) .08s forwards;}',
      /* 复用红花榜 fb-bloom 的绽放节奏（scale .35→1.04、旋转 -14deg→0），结尾定格不淡出，好让花心姓名停留 */
      '@keyframes qcBloom{0%{opacity:0;transform:scale(.35) rotate(-14deg)}',
      '  35%{opacity:.92;transform:scale(1.04) rotate(0)}',
      '  100%{opacity:1;transform:scale(1) rotate(0)}}',
      '.qc-name{margin-top:6px;font-size:27px;font-weight:800;color:#c2185b;letter-spacing:3px;',
      '  text-shadow:0 2px 0 rgba(255,255,255,.85);opacity:0;animation:qcFade .6s ease .78s forwards;}',
      '.qc-caption{margin-top:10px;font-size:15px;color:#0f7b6c;font-weight:600;',
      '  background:rgba(255,255,255,.85);padding:7px 18px;border-radius:999px;',
      '  box-shadow:0 2px 12px rgba(15,123,108,.14);opacity:0;animation:qcFade .6s ease 1s forwards;}',
      '@keyframes qcFade{to{opacity:1;}}',
      '@media (prefers-reduced-motion: reduce){',
      '  .qc-bloom{animation-duration:.01ms!important;animation-delay:0ms!important;opacity:1;transform:scale(1) rotate(0);}',
      '  .qc-name,.qc-caption{animation-duration:.01ms!important;opacity:1;}',
      '  .qc-glow{animation:none;opacity:.8;}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // 从 summary 列表挑真正的本月领先者（与红花榜「本月领先」口径一致：month 含质量工作奖惩）
  function pickLeader(list) {
    if (!Array.isArray(list) || !list.length) return { name: '', caption: '本月小红花榜进行中' };
    var sorted = list.slice().sort(function (a, b) {
      return (b.month - a.month) || (b.count - a.count) || (a.userName < b.userName ? -1 : 1);
    });
    var top = sorted[0];
    var nm = (top.userName || '').trim();
    if (nm === '匿名') nm = '';
    var monthVal = top.month || 0;
    if (monthVal > 0 && nm) {
      return { name: nm, caption: '⭐ 本月领先 · ' + monthVal + ' 朵小红花' };
    }
    // 本月暂无人产生红花：绝不杜撰姓名
    return { name: '', caption: '本月小红花榜进行中' };
  }

  // 数据就绪后立即放遮罩开始演出；领先者数据并行拉取，回来后填入姓名位
  // （姓名淡入有 0.78s 动画延迟，接口通常 ~300ms 内返回，几乎总能准时出现；
  //  极端慢网时姓名会晚一点 pop 出来，但遮罩不再空等接口）
  function renderSplash() {
    injectStyle();

    var ov = document.createElement('div');
    ov.className = 'qc-splash';
    ov.innerHTML =
      '<div class="qc-glow"></div>' +
      '<div class="qc-bloom">🌸</div>' +
      '<div class="qc-name"></div>' +
      '<div class="qc-caption">本月小红花领先</div>';

    document.body.appendChild(ov);

    var nameEl = ov.querySelector('.qc-name');
    var capEl = ov.querySelector('.qc-caption');

    // 数据回来 → 填入姓名（遮罩仍在则更新，已消失则忽略）
    function fillLeader(state) {
      if (!ov.parentNode) return;
      var nm = (state && state.name) || '';
      if (nm) {
        if (nameEl) nameEl.textContent = nm;
        if (capEl) capEl.innerHTML = state.caption;
      } else {
        if (nameEl) nameEl.textContent = '🌸';
        if (capEl) capEl.textContent = (state && state.caption) || '质量千里行';
      }
    }

    // 下一帧再加 .show，确保过渡动画生效
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { ov.classList.add('show'); });
    });

    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      ov.classList.remove('show');
      setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 600);
    }

    // 约 3.2 秒后自动淡出
    setTimeout(dismiss, 3200);

    // 开局 0.6s 后，首次交互可提前关闭（不拦截底层操作）
    setTimeout(function () {
      document.addEventListener('click', dismiss, { once: true });
      document.addEventListener('touchstart', dismiss, { once: true });
      document.addEventListener('keydown', dismiss, { once: true });
    }, 600);

    return fillLeader;
  }

  function show() {
    try {
      var api = getApi();
      if (!api) return;

      if (shownThisLoad) return;
      // 每天仅一次：今天已演出过则直接跳过（跨天自动恢复）
      if (alreadyShownToday()) return;
      shownThisLoad = true;
      markShownToday();

      // 先立即放遮罩演出，同时并行拉「本月」领先者（生产实测 ~14ms/外网 ~300ms）
      var fillLeader = renderSplash();
      try {
        api.get('/api/flowers/summary').then(function (list) {
          fillLeader(pickLeader(list));
        }).catch(function () {
          fillLeader({ name: '', caption: '质量千里行' });
        });
      } catch (e) {
        fillLeader({ name: '', caption: '质量千里行' });
      }
    } catch (e) {
      // 任何异常都不应影响主程序
    }
  }

  window.QCSplash = { show: show };
})();
