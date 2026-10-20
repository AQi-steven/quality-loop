/**
 * UI 工具函数：toast、loading、模态框、状态映射、转义
 */

const UI = (() => {
  let toastTimer;
  function toast(msg, dur = 2000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), dur);
  }

  let loadingCount = 0;
  function loading(show) {
    loadingCount += show ? 1 : -1;
    loadingCount = Math.max(0, loadingCount);
    document.getElementById('loading').style.display = loadingCount > 0 ? 'flex' : 'none';
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const STATUS_MAP = {
    submitted: '待分配', assigned: '待处理', processing: '处理中',
    resolved: '待验证', closed: '已关闭', rejected: '已打回',
  };
  function statusBadge(s) {
    return `<span class="badge badge-${s}">${STATUS_MAP[s] || s}</span>`;
  }
  function sevBadge(s) {
    return s === 'high' ? '<span class="badge badge-sev-high">紧急</span>' : '';
  }
  const ROLE_MAP = { leader: '系统管理员', admin: '系统管理员', designer: '设计师', section_leader: '室主任', chief: '专总', chief_engineer: '总工', dean: '院长', expert: '专家' };

  // 角色标签（支持双身份：专总·室主任）
  function roleLabel(u) {
    if (!u) return '';
    let roles = [u.role];
    let ex = u.extraRoles;
    if (typeof ex === 'string' && ex) { try { ex = JSON.parse(ex); } catch (e) { ex = []; } }
    if (Array.isArray(ex)) roles = roles.concat(ex);
    return roles.map(r => ROLE_MAP[r] || r).join('·');
  }

  // 指针类型判定：精确指针（鼠标/触控板）= 桌面端 → 点遮罩不关闭弹窗，只能点「取消/×」，
  // 防止桌面误点弹窗外空白导致输入白做；触屏设备保留「点空白关闭」的自然手势。
  // 按指针类型而非窗口宽度判断——与分辨率/缩放/窗口大小完全无关（2026-09-29 方案 B'）。
  const FINE_POINTER = (() => {
    try { return window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
    catch (e) { return false; }
  })();

  // 底部模态框
  // 右上角固定 × 为全站统一退出出口（2026-09-30）：
  // 桌面端按 FINE_POINTER 屏蔽了「点遮罩关闭」以防误触丢输入，若无显式出口则弹窗有进无出。
  // 头部(标题+×)不随内容滚动 → 长表单滚到底部时 × 依然可见可点。
  function modal(title, contentHtml, onMount) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal modal-sheet"><div class="modal-head"><div class="modal-title">${esc(title)}</div><button type="button" class="modal-x" aria-label="关闭" title="关闭">×</button></div><div class="modal-body">${contentHtml}</div></div>`;
    mask.addEventListener('click', (e) => { if (!FINE_POINTER && e.target === mask) close(); });
    document.body.appendChild(mask);
    function close() { mask.remove(); }
    const xBtn = mask.querySelector('.modal-x');
    if (xBtn) xBtn.onclick = (ev) => { ev.stopPropagation(); close(); };
    if (onMount) onMount(mask, close);
    return { close, el: mask };
  }

  // 替代原生 confirm()：微信 WebView 下原生 confirm 对话框被抑制，导致「按了无效果」。
  // 用底部模态框实现，返回 Promise<boolean>：点「确定」resolve(true)，点「取消」/遮罩 resolve(false)。
  function confirm(message, confirmText = '确定', cancelText = '取消') {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal modal-confirm">
        <div class="modal-title">${esc(message)}</div>
        <div class="row-btns mt12">
          <button class="btn btn-block btn-outline" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn btn-block btn-primary" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
      function close(v) { if (mask.parentNode) mask.remove(); resolve(v); }
      mask.addEventListener('click', (e) => {
        if (e.target === mask) { if (!FINE_POINTER) close(false); return; }
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'ok') close(true);
        else if (act === 'cancel') close(false);
      });
      document.body.appendChild(mask);
    });
  }

  // ── IMA 归档位置面包屑（全局共用：点「已同步IMA」标签查看层级）──
  function imaTag(pathArr, imaUrl) {
    if (!pathArr || !pathArr.length) return '';
    const ps = esc(JSON.stringify(pathArr));
    const u = imaUrl ? esc(String(imaUrl)) : '';
    return `<span class="tag tag-ima clickable" title="点击查看 IMA 归档位置" data-ima-path='${ps}' data-ima-url='${u}' onclick="UI.showImaSync(this)">✅ 已同步IMA</span>`;
  }
  function showImaSync(el) {
    let path = [];
    try { path = JSON.parse(el.dataset.imaPath || '[]'); } catch (e) {}
    const u = el.dataset.imaUrl || '';
    const crumbs = (path.length ? path : [(window.IMA_KB||'SHARE-知识库')]).map(s => esc(s)).join(' <span class="crumb-sep">›</span> ');
    const urlHtml = u ? `<a class="btn btn-block btn-ima mt12" href="${esc(u)}" target="_blank" rel="noopener noreferrer">📚 在 IMA 查看原文</a>` : '<p class="text-muted mt12">本条未返回 IMA 原文链接（可稍后重试同步）</p>';
    modal('📚 IMA 归档位置', `<div class="ima-path">${crumbs}</div>${urlHtml}`);
  }

  // 相对时间
  function relTime(str) {
    if (!str) return '';
    let parseStr = str;
    // 后端 datetime('now')/CURRENT_TIMESTAMP/toISOString 一律存 UTC；
    // 带时分秒的字符串按 UTC 解析（补 Z），否则会被当成本地时间、整差 8 小时。
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) {
      parseStr = str.replace(' ', 'T') + 'Z';
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) {
      // ISO 8601 形态（toISOString / 含 T）：已是 UTC，原样交给 Date 解析
      parseStr = str.includes('Z') ? str : str + 'Z';
    } else {
      parseStr = str.replace(/-/g, '/');
    }
    const t = new Date(parseStr).getTime();
    if (!t || isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + '天前';
    return str.slice(5, 10);
  }

  // ── 二级专业选择器 ──────────────────────────
  // 复合键形如 "暖通/空调"，显示时以 " › " 分隔
  function subDivLabel(key) {
    if (!key) return '';
    const s = esc(String(key)); // 内部先转义，杜绝二级专业注入 XSS（#535）
    const i = s.indexOf('/');
    return i === -1 ? s : (s.slice(0, i) + ' › ' + s.slice(i + 1));
  }

  // 可折叠分组多选（有二级分类的专业折叠，无则普通勾选）。
  //   divisions: 一级专业数组（来自服务端，已排除隐藏科室）
  //   divisionSubs: { 专业: [二级,...] }
  //   selected: 已选复合键数组（如 ["暖通/空调"]）
  //   dim: data-dim（供筛选 change 处理识别维度，库筛选用 'subDivs'）
  //   opts.onlyWithSubs: true 时只渲染"有二级分类"的专业（折叠组），不渲染无二级的普通专业
  //      ——用于发布表单（专业主选择已单独存在，避免重复）；false/省略则全部渲染（库筛选用）。
  // 返回 HTML 字符串；调用方用 UI.collectSubDiv(mask, containerId) 收集勾选项。
  function subDivMultiHtml(divisions, divisionSubs, selected, dim, opts) {
    const sel = new Set((selected || []).map(String));
    const subs = divisionSubs || {};
    const onlyWithSubs = !!(opts && opts.onlyWithSubs);
    const list = (divisions || []).filter(d => d);
    if (!list.length) return '<span class="text-muted">暂无专业</span>';
    const chk = (val, label) => `<label class="filter-chk"><input type="checkbox" data-dim="${dim || ''}" value="${esc(val)}" ${sel.has(String(val)) ? 'checked' : ''}> ${esc(label)}</label>`;
    let html = '';
    for (const d of list) {
      const subsOfMajor = subs[d];
      if (subsOfMajor && subsOfMajor.length) {
        html += `<details class="subgrp"><summary>${esc(d)} <span class="subgrp-caret">▾</span></summary><div class="subgrp-items">${subsOfMajor.map(s => chk(d + '/' + s, s)).join('')}</div></details>`;
      } else if (!onlyWithSubs) {
        html += chk(d, d);
      }
    }
    return html || '<span class="text-muted">暂无可选二级专业</span>';
  }

  // 收集某容器内所有勾选的复合键（value 含 "/"，或普通一级专业）
  function collectSubDiv(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value);
  }

  // 单级联下拉（一级专业 → 二级专业），用于"发现问题"表单（单标签）。
  //   divisions / divisionSubs 同上；selMajor / selSub 为回填值。
  //   · 一级选择 "不限 / 全院" 时二级禁用
  //   · 一级切到无二级的专业时二级清空禁用
  // 返回两段 <select>（id="pn-div" / id="pn-subdiv"），调用方绑定 pn-div.onchange 重建二级。
  function cascadingDivSub(divisions, divisionSubs, selMajor, selSub) {
    const subs = divisionSubs || {};
    const subOpts = (major, sel) => {
      const arr = subs[major] || [];
      if (!arr.length) return '';
      return arr.map(s => `<option value="${esc(major + '/' + s)}" ${sel === (major + '/' + s) ? 'selected' : ''}>${esc(s)}</option>`).join('');
    };
    const hasSub = !!(selMajor && subs[selMajor] && subs[selMajor].length);
    return `
      <select class="input" id="pn-div">${['', ...(divisions || [])].map(v => `<option value="${esc(v)}" ${selMajor === v ? 'selected' : ''}>${v || '不限 / 全院'}</option>`).join('')}</select>
      <select class="input mt8" id="pn-subdiv" ${hasSub ? '' : 'disabled style="display:none"'}>
        ${hasSub ? subOpts(selMajor, selSub) : ''}
      </select>`;
  }

  // 仅生成二级下拉的 option（供 pn-div.onchange 重建 pn-subdiv 时调用）
  function subOptionsHtml(divisionSubs, major, selSub) {
    const arr = (divisionSubs || {})[major] || [];
    if (!arr.length) return '';
    return arr.map(s => `<option value="${esc(major + '/' + s)}" ${selSub === (major + '/' + s) ? 'selected' : ''}>${esc(s)}</option>`).join('');
  }

  // 复合键（"暖通/空调"）拆成 {major, sub}
  function splitSubKey(key) {
    if (!key) return { major: '', sub: '' };
    const i = String(key).indexOf('/');
    if (i === -1) return { major: key, sub: '' };
    return { major: key.slice(0, i), sub: key.slice(i + 1) };
  }

  // ── 级联多选（先勾一级、有二级才展开二级）────────────
  //  一级专业勾选后，若该专业有二级专业，其下才展开二级勾选项（可多选）。
  //  divisions / divisionSubs：同上
  //  selectedDivisions：已选一级专业数组；selectedSubs：已选二级复合键数组
  //  dim：预留（库筛选用 'subDivs'），表单调用可传空
  //  返回 HTML；调用方用 UI.collectSubDivCascading(root) 收集 { divisions, subDivisions }。
  function subDivCascadingSubsHtml(major, divisionSubs, selectedSubs, dim) {
    const arr = (divisionSubs || {})[major] || [];
    if (!arr.length) return '';
    const sel = new Set((selectedSubs || []).map(String));
    return arr.map(s => {
      const key = major + '/' + s;
      return `<label class="filter-chk subchk" style="margin-left:20px"><input type="checkbox" data-sub="${esc(key)}" ${sel.has(key) ? 'checked' : ''}> ${esc(s)}</label>`;
    }).join('');
  }
  function selSubsSet(arr) { return new Set((arr || []).map(String)); }
  function subDivCascadingMulti(divisions, divisionSubs, selectedDivisions, selectedSubs, dim) {
    const selMajors = new Set((selectedDivisions || []).map(String));
    const sset = selSubsSet(selectedSubs);
    const subs = divisionSubs || {};
    const list = (divisions || []).filter(d => d);
    if (!list.length) return '<span class="text-muted">暂无专业</span>';
    let html = '';
    for (const d of list) {
      const hasSub = !!(subs[d] && subs[d].length);
      const checked = selMajors.has(d) ? 'checked' : '';
      const showSubs = selMajors.has(d) || (hasSub && (subs[d] || []).some(s => sset.has(d + '/' + s)));
      html += `<label class="filter-chk"><input type="checkbox" class="casc-major" data-major="${esc(d)}" ${checked}> ${esc(d)}</label>`;
      if (showSubs) html += `<div class="casc-subs" data-major="${esc(d)}">${subDivCascadingSubsHtml(d, divisionSubs, selectedSubs, dim)}</div>`;
    }
    return html;
  }
  function collectSubDivCascading(root) {
    if (!root) return { divisions: [], subDivisions: [] };
    const divisions = Array.from(root.querySelectorAll('input.casc-major:checked')).map(c => c.dataset.major);
    const subDivisions = Array.from(root.querySelectorAll('input[data-sub]:checked')).map(c => c.dataset.sub);
    return { divisions, subDivisions };
  }

  // 附件 chips：attachments 可为 [{url,name}] 或 JSON 字符串。
  // 图片类附件直接以 <img> 内联缩略图展示（发布即显示，而非文件名）；非图片仍以文件名 chip 展示。
  function isImageUrl(url) {
    if (!url) return false;
    const ext = (String(url).split('?')[0].split('.').pop() || '').toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  }
  // Office 文档（Word/Excel/PPT）浏览器无内置阅读器，会退回下载；
  // 改用 kkFileView（国内开源文档预览服务，Docker 部署在本机 :8012）在线预览，
  // 体验与 PDF 内联打开一致。kkFileView 要求 URL 参数做 Base64 编码（非 URL encode）。
  const OFFICE_VIEW_EXT = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
  function officeViewerHref(url) {
    if (!url) return url;
    const ext = (String(url).split('?')[0].split('.').pop() || '').toLowerCase();
    if (!OFFICE_VIEW_EXT.includes(ext)) return url; // 非 Office 文档保持原链接（PDF 内联打开、其余走浏览器默认）
    let abs = url;
    if (!/^https?:\/\//i.test(url)) {
      const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
      abs = origin + (url.charAt(0) === '/' ? '' : '/') + url;
    }
    // 统一走同源 /kkf 反代（kkFileView 经已开放的 3000 端口暴露，避免云防火墙拦截 8012）；
    // url 参数需 base64 且做 URL 编码（处理 + / = 特殊字符）
    var host = (typeof location !== 'undefined' && location.host) ? location.host : location.hostname;
    try {
      return location.protocol + '//' + host + '/kkf/onlinePreview?url=' + encodeURIComponent(btoa(abs));
    } catch (e) {
      return abs; // 兜底：直接打开原文件（浏览器会下载，但不报错）
    }
  }
  // 图片点击放大（lightbox）：首次调用时往 body 追加一次性覆盖层；点遮罩/×/右滑 关闭。
  // 支持：双指捏合缩放(1x~6x，松手保持)、单指拖动(已放大时)、双击/双触切换 2x 与复位、右滑关闭。
  function openImage(url, alt) {
    let ov = document.getElementById('img-lightbox');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'img-lightbox';
      ov.innerHTML = '<div class="lb-close" onclick="UI.closeImage()">×</div><img class="lb-img" src="" alt="">';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) UI.closeImage(); });
      attachPinch(ov.querySelector('.lb-img'));
      bindSwipeClose(ov, ov.querySelector('.lb-img'));
    }
    const img = ov.querySelector('.lb-img');
    img.src = url;
    img.alt = alt || '';
    resetImageTransform(img);
    ov.classList.add('show');
  }

  // 关闭放大层
  function closeImage() {
    const ov = document.getElementById('img-lightbox');
    if (ov) ov.classList.remove('show');
  }

  // 复位图片变换（缩放/位移）
  function resetImageTransform(img) {
    img._s = 1; img._tx = 0; img._ty = 0;
    applyImageTransform(img);
  }
  function applyImageTransform(img) {
    img.style.transform = 'translate(' + (img._tx || 0) + 'px,' + (img._ty || 0) + 'px) scale(' + (img._s || 1) + ')';
  }
  function midpoint(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }

  // 右滑/横向滑动关闭放大层：① 拦截微信内置「边缘右滑退程序」原生手势（preventDefault）
  // ② 在图片未放大(scale<=1)时，横向滑动超阈值即关闭，已放大时交给 pan 拖动不误关。
  function bindSwipeClose(ov, img) {
    let swiping = false, sx = 0, sy = 0;
    ov.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1 && (img._s || 1) <= 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; swiping = true; }
      else swiping = false;
    }, { passive: false });
    ov.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      e.preventDefault(); // 关键：阻止微信边缘右滑退出 webview
    }, { passive: false });
    ov.addEventListener('touchend', (e) => {
      if (!swiping) return;
      swiping = false;
      const ct = e.changedTouches[0];
      const dx = ct.clientX - sx, dy = ct.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) UI.closeImage();
    });
  }

  // 绑定图片的手势：双指捏合缩放(松手保持大小) + 单指拖动(已放大时) + 双击/双触切换 2x 与复位
  function attachPinch(img) {
    let mode = null, startDist = 1, startScale = 1, startTx = 0, startTy = 0, startMidX = 0, startMidY = 0, startX = 0, startY = 0;
    let lastTap = 0, tapSX = 0, tapSY = 0;
    function clampScale(s) { return Math.max(1, Math.min(6, s)); }

    img.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        mode = 'pinch';
        const t0 = e.touches[0], t1 = e.touches[1];
        startDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) || 1;
        const m = midpoint(t0, t1);
        startMidX = m.x; startMidY = m.y;
        startScale = img._s || 1; startTx = img._tx || 0; startTy = img._ty || 0;
      } else if (e.touches.length === 1 && (img._s || 1) > 1) {
        mode = 'pan';
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startTx = img._tx || 0; startTy = img._ty || 0;
      } else if (e.touches.length === 1) {
        mode = 'tap';
        tapSX = e.touches[0].clientX; tapSY = e.touches[0].clientY;
      }
    }, { passive: false });

    img.addEventListener('touchmove', (e) => {
      if (mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        const t0 = e.touches[0], t1 = e.touches[1];
        const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) || 1;
        img._s = clampScale(startScale * (d / startDist));
        const m = midpoint(t0, t1);
        img._tx = startTx + (m.x - startMidX);
        img._ty = startTy + (m.y - startMidY);
        applyImageTransform(img);
      } else if (mode === 'pan' && e.touches.length === 1 && (img._s || 1) > 1) {
        e.preventDefault();
        const x = e.touches[0].clientX, y = e.touches[0].clientY;
        img._tx = startTx + (x - startX);
        img._ty = startTy + (y - startY);
        applyImageTransform(img);
      }
    }, { passive: false });

    img.addEventListener('touchend', (e) => {
      if (e.touches.length > 0) return; // 还有手指未抬起，先不处理
      // 仅当本次是「单指轻点」才判定双击缩放；捏合(pinch)/拖动(pan)结束绝不触发复位
      if (mode === 'tap') {
        const ct = e.changedTouches[0];
        const dx = Math.abs(ct.clientX - tapSX), dy = Math.abs(ct.clientY - tapSY);
        if (dx < 10 && dy < 10) { // 真正轻点
          const now = Date.now();
          if (now - lastTap < 300) {
            if ((img._s || 1) > 1) resetImageTransform(img);
            else { img._s = 2; img._tx = 0; img._ty = 0; applyImageTransform(img); }
            lastTap = 0;
          } else {
            lastTap = now;
          }
        }
      }
      mode = null;
    });

    img.addEventListener('dblclick', () => {
      if ((img._s || 1) > 1) resetImageTransform(img);
      else { img._s = 2; img._tx = 0; img._ty = 0; applyImageTransform(img); }
    });
  }

  // 单个文件附件的渲染：预览 + 下载 双入口。
  // - 可预览格式(doc/docx/ppt/pptx/pdf) 给「预览」(kkFileView/浏览器内联)；
  // - Excel(xls/xlsx) kkFileView 4.1.0 转码系统性失败("文件版本不兼容")，不给预览，改给「请用 WPS/Excel 打开」提示；
  // - 其余格式(压缩包/CAD/文本等) 无在线预览，只给「下载」；
  // - 所有文件都带「下载」入口(走 /api/download，服务端对 uploads 白名单免登录)。
  function fileChipHtml(a) {
    const url = a && a.url ? a.url : '';
    const name = (a && a.name) || '附件';
    const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    const PREVIEW_EXT = ['doc', 'docx', 'ppt', 'pptx', 'pdf'];
    const isExcel = ext === 'xls' || ext === 'xlsx';
    const m = url.match(/^\/uploads\/(.+)$/);
    const stored = m ? m[1] : url.replace(/^\//, '');
    const dl = '/api/download/' + stored + '?filename=' + encodeURIComponent(name);
    let actions = '';
    if (PREVIEW_EXT.includes(ext)) {
      actions += `<a class="att-act" href="${esc(officeViewerHref(url))}" target="_blank" rel="noopener">预览</a>`;
    } else if (isExcel) {
      // Excel：用**前端 Univer 渲染**（高保真还原样式/合并单元格，2026-10-11 上线）。
      // 原因（2026-10-10 实测）：本机 kkFileView 对 xlsx 只能产出 **889 字节空 HTML**（`<body></body>`），
      //   走kk 会得到**完全空白的预览**；docx/pptx 才能正常转 PDF 图片预览。
      // 原「原始视图」（kk 兜底）已移除（2026-10-11 用户反馈）：点开必然空白页，无效果且误导。
      actions += `<a class="att-act" href="${esc(dl)}" data-name="${esc(name)}" onclick="UI.previewExcelFromLink(this);return false;">表格视图</a>`;
    }
    actions += `<a class="att-act att-dl" href="${esc(dl)}" target="_blank" rel="noopener" download>下载</a>`;
    return `<span class="att-chip-file">📎 ${esc(name)} <span class="att-acts">${actions}</span></span>`;
  }

  // Excel 在线预览：改用 Univer 只读渲染（高保真还原字体/底色/边框/对齐/合并单元格）。
  // 解析用 ExcelJS（提取单元格样式），渲染用 Univer 只读实例；xlsx 文件不出浏览器、不依赖服务端。
  // Univer 引擎(~11MB) 与 ExcelJS/JSZip 均为**按需懒加载**：仅用户首次点开 Excel 预览时下载，之后浏览器缓存。
  async function previewExcel(url, name) {
    const m = modal(name || 'Excel 预览', '<div class="xls-univer"><div class="xls-loading">正在渲染 Excel（首次需加载渲染引擎，请稍候）…</div></div>', (mask) => {
      const orig = mask.remove.bind(mask);
      mask.remove = function () { try { if (window.UniverXlsx) window.UniverXlsx.disposeExcelUniver(); } catch (e) {} orig(); };
    });
    const wrap = m.el.querySelector('.xls-univer');
    // 懒加载渲染器（首次触发会下载 univer.mjs 等引擎）。
    // ⚠️ 渲染函数挂在 window.UniverXlsx（univer-xlsx-viewer.js 设置），本文件 UI 是顶层 const（词法绑定），
    //    两者不是同一对象——绝不能写成 UI.previewExcelUniver（2026-10-11 线上全部预览失败根因）。
    const ns = () => window.UniverXlsx || null;
    if (!ns() || typeof ns().previewExcelUniver !== 'function') {
      // ⚠️ 必须用绝对路径 /js/...：相对 './js/...' 实测被解析成 /js/js/...（2026-10-11 线上 404 实证）
      try { await import('/js/univer-xlsx-viewer.js?v=' + BUILD_VERSION); } catch (e) {}
    }
    if (!ns() || typeof ns().previewExcelUniver !== 'function') {
      wrap.innerHTML = '<div class="att-hint">渲染引擎加载失败，请点击下方「下载」用 WPS/Excel 打开。</div>';
      return m;
    }
    try {
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 12 * 1048576) {
        wrap.innerHTML = '<div class="att-hint">文件较大（' + (buf.byteLength / 1048576).toFixed(1) + 'MB），预览可能较慢，建议点击下方「下载」用 WPS/Excel 打开。</div>';
        return m;
      }
      await window.UniverXlsx.previewExcelUniver(wrap, buf);
    } catch (e) {
      wrap.innerHTML = '<div class="att-hint">预览失败：' + esc(e && e.message ? e.message : String(e)) + '。请点击下方「下载」用 WPS/Excel 打开。</div>';
    }
    return m;
  }
  function previewExcelFromLink(el) {
    // 「表格视图」是Excel 的默认预览：href 即下载地址（保留 data-fallback 兼容旧调用点）
    const url = el.getAttribute('href') || el.getAttribute('data-fallback');
    const name = el.getAttribute('data-name') || 'Excel 预览';
    return previewExcel(url, name);
  }

  // zoom=true（默认，详情页）：图片可点开放大；zoom=false（列表卡片）：图片不带放大，点击冒泡到卡片 → 仅打开详情
  function attChips(atts, zoom = true) {
    let arr = atts;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
    if (!Array.isArray(arr) || !arr.length) return '';
    const items = arr.filter(a => a && a.url);
    if (!items.length) return '';
    const imgs = items.filter(a => isImageUrl(a.url));
    const files = items.filter(a => !isImageUrl(a.url));
    const imgOnclick = zoom ? ` onclick="UI.openImage(this.getAttribute('data-full')||this.src,this.alt);event.stopPropagation()"` : '';
    const imgHtml = imgs.length ? `<div class="att-imgs">${imgs.map(a => `<img class="att-img zoomable" data-full="${esc(a.url || a.photo_url)}" src="${esc(a.url || a.photo_url)}" onerror="this.style.display='none'" alt="${esc(a.name || '图片')}"${imgOnclick}>`).join('')}</div>` : '';
    const fileHtml = files.length ? `<div class="att-chips">${files.map(a => fileChipHtml(a)).join('')}</div>` : '';
    return imgHtml + fileHtml;
  }

  // 图片网格：photos 可为 [{url,name}] / [{id,photo_url}] / ['url'] 或 JSON 字符串；缩略图可点开大图
  // 兼容两种字段名：草稿/宣贯/公告用 url，PDCA 问题用 pdca_photos 表的 photo_url
  // zoom=true（默认，详情页）：点击放大并阻止冒泡；zoom=false（列表卡片）：不带放大，点击冒泡到卡片 onclick 打开详情
  function photoGrid(photos, zoom = true) {
    let arr = photos;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
    if (!Array.isArray(arr)) arr = [];
    const urls = arr.map(p => {
      if (p && typeof p === 'object') return p.url || p.photo_url || p.photoUrl || '';
      return p || '';
    }).filter(Boolean);
    if (!urls.length) return '';
    const imgOnclick = zoom ? ` onclick="UI.openImage(this.getAttribute('data-full')||this.src,this.alt);event.stopPropagation()"` : '';
    return `<div class="photo-grid">${urls.map(u => `<div class="photo-item"><img class="zoomable" data-full="${esc(u)}" src="${esc(u)}"${imgOnclick} onerror="this.style.display='none'"></div>`).join('')}</div>`;
  }

  // 拍照/选图「图框型」预览：与发布公告 bindPhotoInput 完全一致（.photo-item 方框 + 角标 × + .photo-add 虚线加号），
  // 供项目信息传递(记录/回复)、PDCA 方案等所有上传图片处复用，保证 UI 一致。
  // store 为 url 字符串数组或 {url} 对象数组；inputEl 为隐藏的 <input type=file>，用于点「加号」触发选择。
  function renderPhotoGrid(gridEl, inputEl, store) {
    if (!gridEl) return;
    const tiles = store.map((p, i) => {
      const src = p && typeof p === 'object' ? (p.url || p.photo_url || '') : (p || '');
      return `<div class="photo-item"><img class="zoomable" data-full="${esc(src)}" src="${esc(src)}" onclick="UI.openImage(this.getAttribute('data-full')||this.src,this.alt);event.stopPropagation()" onerror="this.style.display='none'"><div class="del" data-i="${i}">×</div></div>`;
    }).join('');
    const add = store.length < 9 ? `<div class="photo-add"><span class="plus">＋</span><span>拍照/相册</span></div>` : '';
    gridEl.innerHTML = tiles + add;
    gridEl.querySelectorAll('.del').forEach((d) => { d.onclick = (e) => { e.stopPropagation(); store.splice(Number(d.dataset.i), 1); renderPhotoGrid(gridEl, inputEl, store); }; });
    const addEl = gridEl.querySelector('.photo-add');
    if (addEl) addEl.onclick = () => { if (inputEl) inputEl.click(); };
  }

  // 备注展示块（pages.js / pages4.js 跨 IIFE 共用，放共享 UI 模块避免找不到函数导致详情弹窗打不开）
  // editable=true 时才显示"加备注/编辑"按钮（仅管理者可见）。
  function noteSectionHtml(source, id, note, by, at, editable) {
    const has = note && String(note).trim();
    const editBtn = editable ? `<button class="btn btn-sm btn-outline mt8" onclick="Pages.editNote('${source}', ${id})">✏️ 加备注 / 编辑</button>` : '';
    return `
      <div class="note-box">
        <div class="note-title">📝 备注</div>
        ${has ? `<div class="note-body">${esc(note)}</div><div class="note-meta">— ${esc(by || '')} · ${relTime(at)}</div>` : '<div class="text-muted">暂无备注</div>'}
        ${editBtn}
      </div>`;
  }

  // ── 右滑返回上一层（拦截微信「边缘右滑退程序」原生手势）──────────
  // 当存在模态弹窗(.modal-mask / .wx-mask)时，右滑 = 关闭最上层(退一步)，而非退出整个 webview。
  // 图片放大层(#img-lightbox)由自身的 bindSwipeClose 处理，本拦截器对其跳过，避免重复/冲突。
  // 无弹窗(已在顶层)时不做任何拦截，保留微信原生的退出行为。
  function initSwipeBack() {
    // 微信(含 iOS/安卓)的「边缘右滑返回」是 WebView 原生手势，JS 的 touch preventDefault 拦不住它，
    // 一旦 WebView 历史栈空了就会直接关掉整个程序。根治办法：在 history 栈底永远保留一条守卫记录，
    // 原生右滑只会 pop 到这条记录(留在程序内)，绝不会因为「无历史可退」而退出。popstate 里再做 UI 逻辑。
    function guard() {
      try { history.pushState({ qcGuard: Date.now() }, ''); } catch (e) { /* 超出历史配额时忽略 */ }
    }
    function imgOpen() {
      const lb = document.getElementById('img-lightbox');
      return !!(lb && lb.classList.contains('show'));
    }
    function topModal() {
      if (imgOpen()) return null;
      const all = [].slice.call(document.querySelectorAll('.modal-mask, .wx-mask'));
      return all.length ? all[all.length - 1] : null;
    }
    // 初始守卫：保证 WebView 永远有 ≥1 条历史可退（顶层右滑也不会退出程序）
    guard();

    window.addEventListener('popstate', function () {
      // 原生返回手势已触发，浏览器已经 pop 过一次历史。
      if (imgOpen()) {
        closeImage();                               // 放大图：直接关图，留在程序内
        guard();                                    // 补回守卫，防止继续退会关程序
        return;
      }
      const m = topModal();
      if (m) {
        m.remove();                                 // 关闭最上层弹窗（嵌套逐层往回退）
        guard();
        return;
      }
      // 无弹窗：若当前是非顶层路由(详情/二级页)，原生 pop 已把 hash 还原到上一级(如回到列表)，
      // 这正是「右滑回列表」想要的效果；顶层栏目页则 hash 不变、原地停留。
      // 关键：无论如何都补回一条守卫，确保再右滑也绝不退出程序。
      guard();
    });
  }
  initSwipeBack();

  // ── 横向滚动容器：鼠标按住左右拖动平移（桌面端统一修复，2026-09-30）──────────
  // 场景：筛选 chips 条(.filter-bar) 在 #app(≤640px) 内必然横向溢出；触屏能滑动，
  //       桌面鼠标却既没有可见滚动条、也不能拖动 → 右侧「专业」等选项够不着。
  // 方案：document 级事件委托 —— 对 innerHTML 反复重建的容器自动生效，无需逐处重绑。
  //   · 仅接管鼠标左键（pointerType==='mouse' && button===0）；触屏交还原生滑动；
  //   · 位移 < THRESHOLD 视为点击，绝不拦截 chip / 复选框 / 日期控件的正常点击；
  //   · 真正拖动后紧随的 click 一律吞掉，避免松手瞬间误触选项。
  // 适用范围：.filter-bar、.gantt-scroll，及任意显式标注 .drag-scroll 的容器。
  function initDragScroll() {
    const SEL = '.filter-bar, .gantt-scroll, .drag-scroll';
    const THRESHOLD = 6;   // px：小于此位移按「点击」处理
    let el = null, pid = null, startX = 0, startLeft = 0, moved = false, swallowClick = false;

    function pick(t) {
      const box = (t && t.closest) ? t.closest(SEL) : null;
      return (box && box.scrollWidth > box.clientWidth + 1) ? box : null;   // 仅真正溢出的容器
    }
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      el = pick(e.target);
      if (!el) return;
      pid = e.pointerId; startX = e.clientX; startLeft = el.scrollLeft; moved = false;
    }, true);

    document.addEventListener('pointermove', (e) => {
      if (!el || e.pointerId !== pid) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < THRESHOLD) return;   // 阈值内不动，仍算点击
      if (!moved) {
        moved = true;
        el.classList.add('drag-scrolling');
        try { el.setPointerCapture(pid); } catch (_) {}
      }
      el.scrollLeft = startLeft - dx;
      if (e.cancelable) e.preventDefault();             // 拖动时不选中文字
    }, true);

    function endDrag() {
      if (!el) return;
      el.classList.remove('drag-scrolling');
      if (moved) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); }
      el = null; pid = null;
    }
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);

    // 拖动结束后紧随的 click 直接吞掉（click 在 pointerup 之后、定时器之前派发）
    document.addEventListener('click', (e) => {
      if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }
  initDragScroll();

  return { toast, loading, esc, statusBadge, sevBadge, STATUS_MAP, ROLE_MAP, roleLabel, modal, relTime,
    subDivLabel, subDivMultiHtml, collectSubDiv, cascadingDivSub, subOptionsHtml, splitSubKey,
    subDivCascadingMulti, subDivCascadingSubsHtml, collectSubDivCascading,
    attChips, fileChipHtml, previewExcel, previewExcelFromLink, photoGrid, renderPhotoGrid, noteSectionHtml, openImage, closeImage, imaTag, showImaSync, confirm };
})();
