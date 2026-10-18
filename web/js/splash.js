/**
 * 开场小红花动画（质量管理部门 · 质量千里行）
 *
 * - 何时显示：每次「整页加载」都显示一次——包括新标签打开链接、刷新页面、关闭网页后再打开。
 *   SPA 内部切 tab / hash 路由跳转不重载页面，不会重复触发（天然符合「在 tab 中各种选择不算首次」）。
 * - 同一页面加载内只显示一次（shownThisLoad 瞬时守卫，防止 App.init 冷启动与登录回调重复触发）；
 *   不做任何跨刷新的 localStorage 持久化标记，所以刷新/重开必会再次出现。
 * - 一朵 🌸（与小红花榜 fb-bloom 同一朵樱花、同一绽放节奏）由小放大+轻微旋转绽放，下方显示当前「本月」领先者姓名
 *   （与红花榜「本月领先」口径一致：summary.month，含质量工作奖惩）
 * - 纯装饰层（pointer-events:none），约 3.2s 后自动淡出，不阻塞任何操作
 * - 尊重 prefers-reduced-motion：关闭动画直接显示静态花朵
 */
(function () {
  'use strict';

  // 同一「整页加载」内只显示一次的瞬时守卫（防止 App.init 冷启动与登录成功回调在同一加载里重复触发）。
  // 不做跨刷新持久化：刷新 / 关闭重开都算新的整页加载，会重新出现——这是预期行为。
  var shownThisLoad = false;

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

  function show() {
    try {
      var api = getApi();
      if (!api) return;

      // 同一整页加载内只放一次（瞬时守卫，不跨刷新）；刷新/重开都算新加载，会再次出现
      if (shownThisLoad) return;
      shownThisLoad = true;

      injectStyle();

      var ov = document.createElement('div');
      ov.className = 'qc-splash';
      ov.innerHTML =
        '<div class="qc-glow"></div>' +
        '<div class="qc-bloom">🌸</div>' +
        '<div class="qc-name"></div>' +
        '<div class="qc-caption">本月小红花领先</div>';

      document.body.appendChild(ov);

      // 下一帧再加 .show，确保过渡动画生效
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { ov.classList.add('show'); });
      });

      // 拉取当前「本月」领先者（与小红花榜「本月领先」口径一致：summary.month，含质量工作奖惩）
      api.get('/api/flowers/summary').then(function (list) {
        var nameEl = ov.querySelector('.qc-name');
        var capEl = ov.querySelector('.qc-caption');
        if (Array.isArray(list) && list.length) {
          // 按本月(month)降序；并列按总数(count)，再按姓名，取真正的本月领先者
          var sorted = list.slice().sort(function (a, b) {
            return (b.month - a.month) || (b.count - a.count) || (a.userName < b.userName ? -1 : 1);
          });
          var top = sorted[0];
          var nm = (top.userName || '').trim();
          if (nm === '匿名') nm = '';
          var monthVal = top.month || 0;
          if (monthVal > 0 && nm) {
            // 真实存在本月领先者：显示姓名 + 本月领先
            if (nameEl) nameEl.textContent = nm;
            if (capEl) capEl.innerHTML = '⭐ 本月领先 · ' + monthVal + ' 朵小红花';
          } else {
            // 本月暂无人产生红花：绝不杜撰姓名，显示品牌占位
            if (nameEl) nameEl.textContent = '🌸';
            if (capEl) capEl.textContent = '本月小红花榜进行中';
          }
        } else {
          if (nameEl) nameEl.textContent = '🌸';
          if (capEl) capEl.textContent = '质量千里行';
        }
      }).catch(function () {
        var nameEl = ov.querySelector('.qc-name');
        var capEl = ov.querySelector('.qc-caption');
        if (nameEl) nameEl.textContent = '🌸';
        if (capEl) capEl.textContent = '质量千里行';
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
    } catch (e) {
      // 任何异常都不应影响主程序
    }
  }

  window.QCSplash = { show: show };
})();
