/**
 * 页面渲染器（续三）：PDCA 质量改进闭环
 *   ① 发现问题（草稿箱 + 请教专家） → ② 解决问题（问题库） → ③ 回顾问题（复盘 / 人人讲）
 *   含：照片(多张/相机)、紧急2级、草稿箱、个人备忘、部门问题(管理者推送)、
 *        拟设方案、请教专家(多选,自动通知)、多轮追问、复盘、个人/部门人人讲(自动通知设计人)
 */

(() => {
  const app = () => document.getElementById('app');
  const esc = UI.esc;
  const topbar = Pages.topbar;
  const QC_CATEGORIES = ['标准规范', '质量要求', '优秀经验', '惨痛教训', '质量问答'];
  const QC_REGIONS = ['上海', '雄安', '山东', '安徽', '浙江', '海外', '其他'];
  let QC_DIVISIONS = [];   // 专业室（从服务端取，保持与发布/筛选一致）
  let QC_SUBS = {};        // 二级专业映射 { 专业: [二级,...] }

  let pdcaTab = (() => { try { const t = localStorage.getItem('qc_pdca_tab'); return (t === 'found' || t === 'solving' || t === 'review') ? t : 'found'; } catch (e) { return 'found'; } })();      // found | solving | review（localStorage 持久化，刷新保持当前 tab）
  let pdcaHashId = null;      // 解析地址栏二级路径：#/pdca/<id> = 直接进入某问题详情（硬刷新/直接访问可恢复，刷新仍在本界面）

  // 设置 PDCA 当前 tab 并持久化，刷新/重进 PDCA 仍停留在上次所在 tab（而非默认「发现问题」）
  function setPdcaTabState(t) { pdcaTab = t; try { localStorage.setItem('qc_pdca_tab', t); } catch (e) {} }
  let pdcaList = [];
  let draftList = [];
  let pdcaExperts = [];
  let pdcaDesigners = [];   // 共议设计师候选（role=designer）
  let newPhotos = [];         // 发现问题 照片（compose 临时）
  let composeDraftId = null;  // 继续记录时的草稿 id
  // 列表分页（加载更多）状态
  let pdcaLimit = 20, pdcaOffset = 0, pdcaHasMore = false, pdcaLoadingMore = false;
  let libLimit = 20, libOffset = 0, libHasMore = false, libLoadingMore = false, libReload = null, libItems = [];
  // 质量库各一级专业条数（faceted count：忽略「专业」自身多选、其余筛选照常生效）2026-09-15
  let libDivCounts = {}, libNoDivCount = 0, libFacetTotal = 0, libCountsReady = false;

  const closeAllModals = () => document.querySelectorAll('.modal-mask').forEach(m => m.remove());
  const ub = (u) =>
    u === 'urgent'
      ? '<span class="badge badge-urgent">紧急</span>'
      : '<span class="badge badge-normal">一般</span>';
  const sb = (s) => s === 'dept' ? '<span class="badge badge-dept">部门</span>' : '';
  const STATUS = {
    found: '待解决', solving: '解决中', recorded: '已记录', consulted: '已请教',
    solved: '已解决', reviewed: '已回顾', closed: '已闭环',
  };

  // PDCA 答复楼中楼渲染：answers 含 parent_id，组装成树；
  //   opts: { canAnswer, me, interactive, problemId }
  //   interactive=true（问题详情）显示「回复」「删除」；readonly（质量库详情）仅展示。
  //   删除按钮仅在「是本人发言 且 无子回复（未被回答）」时出现 —— 对应"被回答后不能删"。
  function answerTreeHtml(answers, opts) {
    const list = Array.isArray(answers) ? answers : [];
    const kidsOf = (pid) => list.filter(a => (a.parent_id || null) === pid);
    const render = (a, depth) => {
      const kids = kidsOf(a.id);
      const isMine = opts.me && a.answer_by === opts.me;
      const canDel = opts.interactive && ((isMine && kids.length === 0) || isSuperAdmin());
      const replyBtn = (opts.interactive && opts.canAnswer)
        ? `<span class="ans-act btn btn-xs btn-outline" onclick="Pages.pdcaAnswer(${opts.problemId}, ${a.consult_id}, ${a.id})">回复</span>` : '';
      const delBtn = canDel ? `<span class="ans-act btn btn-xs btn-danger" onclick="Pages.deleteAnswer(${opts.problemId}, ${a.id})">删除</span>` : '';
      const actions = (replyBtn || delBtn) ? `<span class="ans-actions">${replyBtn}${delBtn}</span>` : '';
      const tag = a.role === 'designer' ? '🗣️' : '💡';
      const indent = depth ? ` style="margin-left:14px;border-left:2px solid #e8e8e8;padding-left:8px"` : '';
      const childHtml = kids.map(k => render(k, depth + 1)).join('');
      return `<div class="consult-a ${a.role === 'designer' ? 'consult-a-designer' : ''} ${depth ? 'consult-a-child' : ''}"${indent}>
        ${tag} ${esc(a.answer)} ${a.attachments ? UI.attChips(a.attachments) : ''}
        <span class="text-muted">—${esc(a.answer_by || '')}${a.role === 'designer' ? '（共议）' : ''}</span>${actions}
      </div>${childHtml}`;
    };
    const tops = kidsOf(null);
    return tops.length ? tops.map(a => render(a, 0)).join('') : '<span class="text-muted">等待专家 / 共议回复…</span>';
  }

  // ── 问答区展示优化（2026-09-15）：只改「怎么显示」，不碰任何数据 ──────────────
  // 背景：创建问题时若同时「请教专家」，服务端把首轮 question 直接写成 description
  //      （server/src/routes/pdca.js:479-480）；后续请教若问题留空也回退为 description
  //      （:518）。于是详情页出现「顶部问题描述」与「Q1」两段一模一样的文字。
  // 处理：**纯前端去重**——问题文本与描述相同（或=描述+追加）时折叠为一句引述，
  //      不改接口、不写库，历史数据与以后新建的数据都不受影响。
  const normTxt = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const squash = (s) => normTxt(s).replace(/\s+/g, '');   // 再去掉全部空白：容忍中文间多出的换行/缩进
  const stripLeadPunct = (s) => s.replace(/^[\s，。、；;：:,.\-—–~～]+/, '');
  // 返回值 kind：'same' = 与描述完全一致；'tail' = 描述打头、后面才是真问题；'full' = 独立问题
  function splitConsultQuestion(question, desc) {
    const q = normTxt(question), d = normTxt(desc);
    if (!q) return { kind: 'same', text: '' };
    if (!d) return { kind: 'full', text: q };
    if (q === d || squash(q) === squash(d)) return { kind: 'same', text: '' };
    if (q.length > d.length && q.startsWith(d)) {
      const tail = stripLeadPunct(q.slice(d.length));
      return tail ? { kind: 'tail', text: tail } : { kind: 'same', text: '' };
    }
    return { kind: 'full', text: q };
  }
  // 渲染单条「请教问题」：与顶部描述重复时折叠为引述，避免同一段话读两遍
  function consultQHtml(c, desc) {
    const sp = splitConsultQuestion(c.question, desc);
    const by = `<span class="text-muted">—${esc(c.question_by || '')}</span>`;
    if (sp.kind === 'same') return `<div class="consult-q"><b>Q${c.round}</b> <span class="cq-same">↩︎ 同顶部「问题描述」</span> ${by}</div>`;
    if (sp.kind === 'tail') return `<div class="consult-q"><b>Q${c.round}</b> <span class="cq-same">（承接顶部问题描述）</span>${esc(sp.text)} ${by}</div>`;
    return `<div class="consult-q"><b>Q${c.round}</b> ${esc(sp.text)} ${by}</div>`;
  }
  // 答复入口：原为一个很小的「答复」文字链，专家常找不到 / 不确定能不能点。
  // 改为整行按钮 + 角色说明，明确「谁在答、点了会怎样」；按钮文案随角色变化。
  function consultReplyHtml(problemId, consultId, o) {
    if (!(o.isExpert || o.isDesigner || o.isManager)) return '';
    const who = o.isExpert ? 'expert' : o.isDesigner ? 'designer' : 'manager';
    const label = o.answered ? '✍️ 补充答复'
      : who === 'designer' ? '✍️ 我来共议回复'
        : who === 'manager' ? '✍️ 代为答复'
          : '✍️ 我要答复';
    const hint = o.answered ? '你已答复过，可继续补充。提交后会自动通知上报人。'
      : who === 'designer' ? '你是本条受邀共议的设计师。提交后会自动通知上报人。'
        : who === 'manager' ? '你是管理者，可直接代为答复。提交后会自动通知上报人。'
          : '你是本条请教的专家。提交后会自动通知上报人。';
    return `<button type="button" class="btn btn-block consult-reply-btn is-${who}" onclick="Pages.pdcaAnswer(${problemId}, ${consultId})">${label}</button>
      <div class="consult-reply-hint">💡 ${hint}</div>`;
  }

  // ── 主页面 ────────────────────────────────────
  async function pdca() {
    // 解析二级 hash：#/pdca/<id> = 直接进入某问题详情（硬刷新/直接访问可恢复，刷新仍在本界面）
    const hm = ('' + location.hash).slice(1).match(/^\/pdca\/(\d+)/);
    pdcaHashId = hm ? parseInt(hm[1], 10) : null;
    // 无详情 hash（纯列表）时，清理可能残留的详情弹窗（如从底部 tab 切回 PDCA）
    if (!pdcaHashId) closeAllModals();
    const canManage = App.caps.canManage;
    // V3 §3.3 / §6.2（设计稿裁定 2026-09-11）：三阶段 stepper —— 圆圈编号 + 下方文字 + › 箭头。
    // 纯 UI 替换：仍然是「发现问题 / 解决问题 / 回顾问题」三阶段、同样的切换逻辑，
    // 结构未动、不新增任何子分类（用户 2026-09-11 明确：流程写法正确，只是 UI 要跟设计稿）。
    const pdcaSteps = [
      { k: 'found', n: '1', t: '发现问题' },
      { k: 'solving', n: '2', t: '解决问题' },
      { k: 'review', n: '3', t: '回顾问题' },
    ];
    const pdcaChev = '<span class="pdca-sep" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg></span>';
    // 一级栏目（列表态）不显示返回键；仅当处于「#/pdca/<id> 详情」时显示（详情 = 二级）。
    app().innerHTML = `${topbar('PDCA 质量改进', { back: !!pdcaHashId })}<div class="page">
      <div class="pdca-steps" id="pdca-tabs">
        ${pdcaSteps.map((s, i) => `${i ? pdcaChev : ''}<div class="pdca-step ${pdcaTab === s.k ? 'active' : ''}" onclick="Pages.pdcaSetTab('${s.k}')"><span class="ps-num">${s.n}</span><span class="ps-txt">${s.t}</span></div>`).join('')}
      </div>
      <div id="pdca-body"><div class="empty"><div class="skel skel-card"></div><div class="skel skel-card"></div></div></div>
    </div>${Pages.tabbar('pdca')}`;

    try {
      if (!pdcaExperts.length) pdcaExperts = await API.get('/api/pdca/experts');
      if (!pdcaDesigners.length) pdcaDesigners = await API.get('/api/pdca/designers');
      if (!QC_DIVISIONS.length) { try { const dv = await API.get('/api/divisions'); QC_DIVISIONS = dv.divisions || []; QC_SUBS = dv.divisionSubs || {}; } catch (e) { QC_DIVISIONS = []; } }
      if (pdcaTab === 'found') draftList = await API.get('/api/pdca/drafts');
      if (pdcaTab !== 'found') {
        const phaseQ = pdcaTab === 'solving' ? 'phase=open' : pdcaTab === 'review' ? 'phase=review' : '';
        pdcaOffset = 0;
        pdcaList = [];
        const q = (phaseQ ? phaseQ + '&' : '') + 'limit=' + pdcaLimit + '&offset=' + pdcaOffset;
        const data = await API.get('/api/pdca/problems?' + q);
        pdcaList = Array.isArray(data) ? data : data.items;
        pdcaHasMore = Array.isArray(data) ? false : data.hasMore;
      }
      renderPdcaBody();
      // 二级 hash 详情：列表渲染完成后，叠加打开问题详情弹窗（硬刷/直访均保持在本界面）
      if (pdcaHashId) Pages.pdcaDetail(pdcaHashId);
    } catch (e) { UI.toast(e.message); }
  }

  // 列表项点击：驱动地址栏二级 hash（#/pdca/<id>），由路由重新进入 pdca() 并叠加详情；
  // 硬刷新/直接访问该 URL 可恢复详情，满足「刷新仍在本界面」。
  Pages.pdcaGoDetail = (id) => { location.hash = '#/pdca/' + id; };

  // 从详情返回列表：关弹窗并清掉地址栏 id（回到 #/pdca），若在其它版面（如首页卡片进入的详情）则直接重渲染列表。
  Pages.pdcaGoList = () => {
    closeAllModals();
    if (/^#\/pdca\/\d+/.test(location.hash)) location.hash = '#/pdca';
    else pdca();
  };

  Pages.pdcaSetTab = (t) => { setPdcaTabState(t); pdca(); };

  // 设计师多选下拉（带搜索过滤），prefix 区分同一页多个实例
  function designerSelectHtml(prefix, selected = []) {
    let sel = selected;
    if (typeof sel === 'string') { try { sel = JSON.parse(sel); } catch (e) { sel = []; } }
    if (!Array.isArray(sel)) sel = [];
    const opts = (pdcaDesigners || []).map(d =>
      `<label class="exp-item"><input type="checkbox" value="${esc(d.name)}" ${sel.includes(d.name) ? 'checked' : ''}> ${esc(d.name)}</label>`
    ).join('');
    return `<details class="drop-panel"><summary>邀请设计师共议（可选，下拉多选）</summary>
      <div class="drop-search"><input class="input" id="${prefix}-desg-kw" placeholder="搜索设计师…"></div>
      <div class="drop-list exp-list" id="${prefix}-desg-list">${opts}</div></details>`;
  }
  function bindDesignerFilter(mask, prefix) {
    const kw = mask.querySelector('#' + prefix + '-desg-kw');
    if (!kw) return;
    kw.oninput = (e) => {
      const v = e.target.value.trim();
      mask.querySelectorAll('#' + prefix + '-desg-list label').forEach(l => {
        l.style.display = (!v || l.textContent.includes(v)) ? '' : 'none';
      });
    };
  }
  function collectDesigners(mask, prefix) {
    return Array.from(mask.querySelectorAll('#' + prefix + '-desg-list input:checked')).map(c => c.value);
  }

  // 把「请教专家」候选渲染为多选列表；资深专家（总工）带徽标提示
  function expListHtml(experts, checkedNames = []) {
    let checked = checkedNames;
    if (typeof checked === 'string') { try { checked = JSON.parse(checked); } catch (e) { checked = []; } }
    if (!Array.isArray(checked)) checked = [];
    return (experts || []).map(e => {
      const isSenior = e.level === 'senior' || e.role === 'chief_engineer';
      const badge = isSenior ? ' <span class="tag tag-senior">总工</span>' : '';
      const ck = checked.includes(e.name) ? 'checked' : '';
      return `<label class="exp-item"><input type="checkbox" value="${esc(e.name)}" ${ck}> ${esc(e.name)}${badge}</label>`;
    }).join('');
  }

  // 判断当前用户是否被该问题「请教」（含总工）：以问题自身 consult_experts 为准，
  // 避免资深专家因不在普通专家候选池中而看不到「答复」按钮。
  function myExpertNames(p) {
    let ce = p && p.consult_experts;
    if (typeof ce === 'string') { try { ce = JSON.parse(ce); } catch (e) { ce = []; } }
    if (!Array.isArray(ce)) ce = [];
    return ce;
  }

  function renderPdcaBody() {
    const el = document.getElementById('pdca-body');
    if (!el) return;
    const canManage = App.caps.canManage;
    const canDesign = App.caps.canDesign;

    if (pdcaTab === 'found') {
      let html = '';
      if (canDesign && !App.caps.isGuest) html += `<button class="btn btn-block btn-lg mt8" onclick="Pages.pdcaCompose()">＋ 发现质量问题 或 上报质量经验</button>`;
      html += `<div class="card-title mt8">草稿箱（${draftList.length}）</div>`;
      if (!draftList.length) html += '<div class="empty"><div class="ei">🗒️</div><div class="et">还没有草稿</div><div class="es">发现问题后可「存档」暂存到这里，随时继续</div></div>';
      else html += draftList.map(d => `
        <div class="draft-item">
          <div class="li-head"><div class="li-title">${esc(d.title || '（无标题）')}</div>${ub(d.urgency)}</div>
          ${d.description ? `<div class="li-desc">${esc(d.description).slice(0, 40)}</div>` : ''}
          <div class="li-meta"><span>🕒 ${UI.relTime(d.saved_at)}</span>${d.user_name ? `<span>👤 ${esc(d.user_name === App.user.real_name ? '我' : d.user_name)}</span>` : ''}${d.photos && d.photos.length ? `<span>📷 ${d.photos.length}</span>` : ''}</div>
          <div class="row-btns">
            <button class="btn btn-sm" onclick="Pages.pdcaContinue(${d.id})">继续记录</button>
            <button class="btn btn-sm btn-gray" onclick="Pages.pdcaDelDraft(${d.id})">删除</button>
          </div>
        </div>`).join('');
      el.innerHTML = html;
      return;
    }

    const hint = pdcaTab === 'solving'
      ? (canManage ? '问题库：所有「已记录 / 已请教」的问题，可填做法、请教专家、追问，直到解决。' : '全院待解决问题：可浏览全员上报与请教的问题，可补充做法、请教专家、追问，直至解决。')
      : '已解决的问题，可写回顾感悟、列为人人讲案例（管理者可列为部门人人讲并通知设计人）。';
    let html = `<p class="text-muted" style="font-size:var(--fs-t5);margin:12px 0">${hint}</p>`;
    if (!pdcaList.length) html += '<div class="empty"><div class="ei">📋</div><div class="et">这一栏暂时没有</div></div>';
    else html += pdcaList.map(p => `
      <div class="list-item" onclick="Pages.pdcaGoDetail(${p.id})">
        <div class="li-head">
          <div class="li-title">${esc(p.title)} ${ub(p.urgency)} ${sb(p.source)}</div>
          <span class="badge badge-${p.status}">${STATUS[p.status] || p.status}</span>
        </div>
        <div class="li-desc">${esc(p.description).slice(0, 60)}</div>
        <div class="li-meta">
          <span>👤 ${esc(p.reporter)}</span>
          ${p.photoCount ? `<span>📷 ${p.photoCount}</span>` : ''}
          ${p.solutionCount ? `<span>🛠️ ${p.solutionCount}方案</span>` : ''}
          ${p.consultCount ? `<span>💬 ${p.consultCount}追问</span>` : ''}
          <span>${UI.relTime(p.created_at)}</span>
        </div>
      </div>`).join('');
    if (pdcaHasMore) html += `<button class="btn btn-block btn-gray mt8" id="pdca-loadmore" onclick="Pages.pdcaLoadMore()">加载更多…</button>`;
    el.innerHTML = html;
  }

  // PDCA 列表「加载更多」：追加下一页（按 phase + limit/offset），与当前列表拼接
  Pages.pdcaLoadMore = async () => {
    if (pdcaLoadingMore) return;
    pdcaLoadingMore = true;
    const btn = document.getElementById('pdca-loadmore');
    if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
    try {
      const phaseQ = pdcaTab === 'solving' ? 'phase=open' : pdcaTab === 'review' ? 'phase=review' : '';
      pdcaOffset += pdcaLimit;
      const q = (phaseQ ? phaseQ + '&' : '') + 'limit=' + pdcaLimit + '&offset=' + pdcaOffset;
      const data = await API.get('/api/pdca/problems?' + q);
      const items = (Array.isArray(data) ? data : (data && data.items)) || [];
      pdcaHasMore = Array.isArray(data) ? false : !!data.hasMore;
      // 去重：服务端返回裸数组（无 limit）或分页对象时，按 id 合并，避免与首屏重复
      const seen = new Set(pdcaList.map(x => x && x.id));
      pdcaList = pdcaList.concat(items.filter(x => x && !seen.has(x.id)));
      renderPdcaBody();
    } catch (e) { UI.toast(e.message); }
    finally { pdcaLoadingMore = false; }
  };

  // 附件 chips（attachments 可能是 JSON 字符串或数组）—— 复用 UI.fileChipHtml 统一「预览 + 下载」双入口
  function attChips(atts) {
    let arr = atts;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
    if (!Array.isArray(arr) || !arr.length) return '';
    const files = arr.filter((a) => a && a.url);
    if (!files.length) return '';
    return `<div class="att-chips">${files.map((a) => UI.fileChipHtml(a)).join('')}</div>`;
  }
  // 附件选择框：选择即上传，渲染可删除列表
  // ⚠️ 触发方式必须用「隐藏 input(.sr-only-file) + 可见按钮调 input.click()」：
  //    直接暴露的原生 <input type="file" class="input"> 在微信内置浏览器里没有可点的按钮、
  //    点了也不弹选择器（本工程图片上传早已用 sr-only-file + 显式触发器规避，附件此前是例外）。
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
      // 末尾恒定渲染可见触发按钮：空列表时也要有，用户才知道往哪儿点
      const add = document.createElement('span');
      add.className = 'att-add';
      add.textContent = store.length ? '＋ 继续添加附件' : '＋ 添加附件';
      add.onclick = () => input.click();
      listEl.appendChild(add);
    };
    // 常驻错误行：上传失败时留在附件区。
    // 原本只弹 2 秒 toast，用户很容易错过，进而以为「按钮点了没反应」——这正是共议设计师反馈的现象。
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

    render(); // 初始渲染（支持从草稿回填已有附件）
  }

  // ── 发现问题：新建 / 继续记录 ─────────────────
  Pages.pdcaCompose = async (draft = null) => {
    composeDraftId = draft ? draft.id : null;
    newPhotos = draft ? (draft.photos || []) : [];
    const d = draft || {};
    const canManage = App.caps.canManage;
    if (!pdcaExperts.length) pdcaExperts = (await API.get('/api/pdca/experts')) || [];
    if (!pdcaDesigners.length) pdcaDesigners = (await API.get('/api/pdca/designers')) || [];
    const expHtml = expListHtml(pdcaExperts, d.experts);
    const parseDivs = (x) => { if (Array.isArray(x)) return x; if (typeof x === 'string' && x) { try { const a = JSON.parse(x); return Array.isArray(a) ? a : []; } catch (e) { return []; } } return []; };
    const dDivs = parseDivs(d.divisions).length ? parseDivs(d.divisions) : (d.division ? [d.division] : []);
    const dSubs = parseDivs(d.sub_divisions).length ? parseDivs(d.sub_divisions) : (d.sub_division ? [d.sub_division] : []);
    UI.modal('发现质量问题 或 上报质量经验', `
      <div class="field"><label>问题名称<span class="req">*</span></label><input class="input" id="pn-title" value="${esc(d.title || '')}" placeholder="一句话概括"></div>
      <div class="field"><label>现场照片（可拍照 / 选多张）</label>
        <div class="photo-grid" id="pn-grid"></div>
        <input type="file" id="pn-input" accept="image/*" multiple class="sr-only-file">
      </div>
      <div class="field"><label>附件（文档 / 表格 / 图片等，可选；闭环为人人讲案例时自动同步 IMA）</label>
        <input type="file" id="pn-attach" multiple class="sr-only-file">
        <div id="pn-attach-list" class="att-list"></div>
      </div>
      <div class="field"><label>问题描述<span class="req">*</span></label><textarea class="textarea" id="pn-desc" placeholder="详细描述发现的质量问题…">${esc(d.description || '')}</textarea></div>
      <div class="field"><label>分类（发现问题 / 上报经验）</label>
        <select class="input" id="pn-cat">${QC_CATEGORIES.map(c => `<option value="${c}" ${d.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="field"><label>专业分类（可多选：先勾一级专业，有二级才展开二级）</label>
        <div id="pn-div-wrap">${UI.subDivCascadingMulti(QC_DIVISIONS, QC_SUBS, dDivs, dSubs, 'pdcaDiv')}</div>
      </div>
      <div class="field"><label>地区分类</label>
        <select class="input" id="pn-reg">${QC_REGIONS.map(r => `<option value="${r}" ${(d.region || '') === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      </div>
      <div class="field"><label>紧急程度</label>
        <div class="seg" id="pn-urg">
          <span class="seg-item ${d.urgency !== 'urgent' ? 'active' : ''}" data-v="normal" onclick="Pages._seg(this)">一般</span>
          <span class="seg-item ${d.urgency === 'urgent' ? 'active' : ''}" data-v="urgent" onclick="Pages._seg(this)">紧急</span>
        </div>
      </div>
      <div class="field"><label>请教专家（可选，勾选专家 / 邀请设计师后提交将自动推送请教）</label><div class="exp-list" id="pn-exp-list">${expHtml}</div></div>
      ${designerSelectHtml('pn', d.designers)}
      <div class="row-btns mt8">
        <button class="btn btn-gray" id="pn-save">${composeDraftId ? '更新草稿' : '存档（草稿箱）'}</button>
        <button class="btn btn-primary" id="pn-ask">提交问题</button>
      </div>
    `, (mask, close) => {
      renderComposePhotos();
      bindDesignerFilter(mask, 'pn');
      // 级联多选：勾选一级专业时，若该专业有二级，其下才展开二级勾选项
      const wrap = mask.querySelector('#pn-div-wrap');
      if (wrap) wrap.querySelectorAll('input.casc-major').forEach(cb => {
        cb.addEventListener('change', () => {
          const major = cb.dataset.major;
          const subsWrap = wrap.querySelector('.casc-subs[data-major="' + (window.CSS && CSS.escape ? CSS.escape(major) : major) + '"]');
          if (cb.checked) {
            if (!subsWrap) {
              const div = document.createElement('div');
              div.className = 'casc-subs';
              div.dataset.major = major;
              div.innerHTML = UI.subDivCascadingSubsHtml(major, QC_SUBS, [], 'pdcaDiv');
              cb.closest('label').insertAdjacentElement('afterend', div);
            }
          } else if (subsWrap) {
            subsWrap.querySelectorAll('input[data-sub]').forEach(s => { s.checked = false; });
            subsWrap.remove();
          }
        });
      });
      // 收集 一级(divisions 数组) + 二级(subDivisions 数组，复合键)
      const getDivSub = () => UI.collectSubDivCascading(wrap);
      const pnAtts = (draft && Array.isArray(draft.attachments)) ? draft.attachments : [];
      bindAttachInput(mask, 'pn-attach', 'pn-attach-list', pnAtts);
      mask.querySelector('#pn-input').onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        try { UI.loading(true); const { urls } = await API.upload(files); newPhotos.push(...urls); renderComposePhotos(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); }
        e.target.value = '';
      };
      mask.querySelector('#pn-save').onclick = async () => {
        const title = mask.querySelector('#pn-title').value.trim();
        const description = mask.querySelector('#pn-desc').value.trim();
        const category = mask.querySelector('#pn-cat').value;
        const { divisions, subDivisions } = getDivSub();
        const region = mask.querySelector('#pn-reg').value;
        if (!title || !description) return UI.toast('名称和描述必填');
        const urgency = mask.querySelector('#pn-urg .seg-item.active').dataset.v;
        try {
          UI.loading(true);
          const experts = Array.from(mask.querySelectorAll('#pn-exp-list input:checked')).map(c => c.value);
          const designers = collectDesigners(mask, 'pn');
          if (composeDraftId) await API.put('/api/pdca/drafts/' + composeDraftId, { title, description, urgency, photos: newPhotos, category, divisions, subDivisions, region, attachments: pnAtts, experts, designers });
          else await API.post('/api/pdca/drafts', { title, description, urgency, photos: newPhotos, category, divisions, subDivisions, region, attachments: pnAtts, experts, designers });
          close(); UI.toast('已存入草稿箱'); pdca();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
      mask.querySelector('#pn-ask').onclick = async () => {
        const title = mask.querySelector('#pn-title').value.trim();
        const description = mask.querySelector('#pn-desc').value.trim();
        const category = mask.querySelector('#pn-cat').value;
        const { divisions, subDivisions } = getDivSub();
        const region = mask.querySelector('#pn-reg').value;
        if (!title || !description) return UI.toast('名称和描述必填');
        const experts = Array.from(mask.querySelectorAll('#pn-exp-list input:checked')).map(c => c.value);
        const designers = collectDesigners(mask, 'pn');
        const urgency = mask.querySelector('#pn-urg .seg-item.active').dataset.v;
        try {
          UI.loading(true);
          const r = await API.post('/api/pdca/problems', { title, description, urgency, photos: newPhotos, experts, designers, category, divisions, subDivisions, region, attachments: pnAtts });
          if (composeDraftId) await API.del('/api/pdca/drafts/' + composeDraftId).catch(() => {});
          close(); UI.toast(r.message || '已提交'); setPdcaTabState('solving'); pdca();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });

    function renderComposePhotos() {
      const grid = document.getElementById('pn-grid');
      if (!grid) return;
      const add = `<div class="photo-add" onclick="document.getElementById('pn-input').click()"><span class="plus">＋</span><span>拍照/相册</span></div>`;
      grid.innerHTML = newPhotos.map((u, i) => `<div class="photo-item"><img src="${u}" onclick="Pages.pdcaDelPhoto(${i})"></div>`).join('') + (newPhotos.length < 9 ? add : '');
    }
  };
  Pages.pdcaDelPhoto = (i) => { newPhotos.splice(i, 1); const g = document.getElementById('pn-grid'); if (g) { const add = `<div class="photo-add" onclick="document.getElementById('pn-input').click()"><span class="plus">＋</span><span>拍照/相册</span></div>`; g.innerHTML = newPhotos.map((u, k) => `<div class="photo-item"><img src="${u}" onclick="Pages.pdcaDelPhoto(${k})"></div>`).join('') + (newPhotos.length < 9 ? add : ''); } };
  Pages._seg = (el) => { el.parentElement.querySelectorAll('.seg-item').forEach(s => s.classList.remove('active')); el.classList.add('active'); };

  Pages.pdcaContinue = (id) => {
    const d = draftList.find(x => x.id === id);
    if (d) return Pages.pdcaCompose(d);
    API.get('/api/pdca/drafts/' + id).then(d => Pages.pdcaCompose(d)).catch(e => UI.toast(e.message));
  };
  Pages.pdcaDelDraft = async (id) => {
    if (!(await UI.confirm('确认删除该草稿？'))) return;
    try { UI.loading(true); await API.del('/api/pdca/drafts/' + id); UI.toast('已删除'); pdca(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // ── 详情（含方案 / 请教专家 / 多轮追问 / 复盘）──
  Pages.pdcaDetail = async (id) => {
    closeAllModals();   // 关闭可能残留的同类/嵌套弹窗，叠加最新详情（硬刷/直访由 pdca() 重新进入后也在此重建）
    try {
      UI.loading(true);
      const p = await API.get('/api/pdca/problems/' + id);
      UI.loading(false);
      const u = App.user;
      const asArr = (x) => Array.isArray(x) ? x : (typeof x === 'string' && x ? (() => { try { const a = JSON.parse(x); return Array.isArray(a) ? a : []; } catch (e) { return []; } })() : []);
      const canManage = App.caps.canManage;
      const isReporter = p.reporter === u.realName;
      const canDel = isSuperAdmin() || (canManage && !App.caps.isGuest) || (isReporter && !['closed', 'solved'].includes(p.status));
      const isOpen = ['found', 'solving', 'recorded', 'consulted'].includes(p.status);

      const photoHtml = (p.photos || []).length ? UI.photoGrid(p.photos) : '';
      const solHtml = (p.solutions || []).map(s => `
        <div class="sol-item">
          <div class="li-meta"><span>🛠️ 做法 · ${esc(s.created_by)}</span><span>${UI.relTime(s.created_at)}</span></div>
          <div class="sol-content">${esc(s.content)}</div>
          ${(s.photos && s.photos.length) ? `<div style="margin-top:6px">${UI.photoGrid(s.photos)}</div>` : ''}
          ${(s.attachments && s.attachments.length) ? `<div style="margin-top:6px">${UI.attChips(s.attachments)}</div>` : ''}
          ${s.experts ? `<div class="sol-experts">🎓 请教专家：${s.experts.split(',').map(e => `<span class="tag">${esc(e)}</span>`).join('')}</div>` : ''}
        </div>`).join('');
      const conHtml = (p.consults || []).map(c => {
        const answers = c.answers || [];
        const isConsulted = myExpertNames(p).includes(u.realName);
        const isInvitedDesigner = Array.isArray(p.consult_designers) && p.consult_designers.includes(u.realName);
        const isAnsweringManager = !!canManage && !App.caps.isGuest;
        const canAnswer = isAnsweringManager || isConsulted || isInvitedDesigner;
        const myAnswer = answers.find(a => a.answer_by === u.realName);
        const ansHtml = answerTreeHtml(answers, { canAnswer, me: u.realName, interactive: true, problemId: p.id });
        const replyBtn = consultReplyHtml(p.id, c.id, {
          isExpert: isConsulted,
          isDesigner: isInvitedDesigner && !isConsulted,
          isManager: isAnsweringManager && !isConsulted && !isInvitedDesigner,
          answered: !!myAnswer,
        });
        return `
        <div class="consult-item">
          ${consultQHtml(c, p.description)}
          ${ansHtml}
          ${replyBtn}
        </div>`;
      }).join('');

      // 管理者院选备注：院选帖（或任何被管理者加过备注的闭环帖）置顶展示，全员可见其批注内容；仅管理者可编辑
      const noteHtml4 = (p.manager_note && String(p.manager_note).trim() && (canManage || isReporter || p.rrj_selected))
        ? UI.noteSectionHtml('pdca', p.id, p.manager_note, p.manager_note_by, p.manager_note_at, canManage && !App.caps.isGuest)
        : '';
      // 操作区
      let actions = '';
      const canEditPdca = isOpen && (canManage || p.reporter === u.realName) && !App.caps.isGuest; // P3⑨ 角色门：拟设方案/请教专家仅上报人+管理者（声明在 if 外，供下方模板字符串使用）；游客纯只读
      if (isOpen) {
        const isConsulted = myExpertNames(p).includes(u.realName);
        const canInviteDesigners = (canManage && !App.caps.isGuest) || isConsulted || p.reporter === u.realName;
        if (canEditPdca) actions += `<button class="btn btn-block" onclick="Pages.pdcaAddSolution(${p.id})">＋ 拟设解决方案 / 做法</button>`;
        // 已到总工：无需再追问 / 邀请设计师共议
        if (canEditPdca && !p.reachedChief) actions += `<button class="btn btn-block btn-outline mt8" onclick="Pages.pdcaAsk(${p.id})">🎓 请教专家</button>`;
        if (p.status === 'consulted' && !p.reachedChief && (isReporter || (canManage && !App.caps.isGuest))) {
          actions += `<div class="pdca-quick"><input class="input" id="dq-${p.id}" placeholder="向专家追问…"><button class="btn btn-sm" onclick="Pages.pdcaConsult(${p.id})">推送追问</button></div>`;
        }
        if (canInviteDesigners && !p.reachedChief) {
          actions += `<button class="btn btn-block btn-outline mt8" onclick="Pages.pdcaInviteDesigners(${p.id})">🗣️ 邀请设计师共议</button>`;
        }
        // 问题解决（闭环）只能由提问者（上报人）决定；专家 / 共议设计师 / 管理者均不代判
        if (p.reporter === u.realName) {
          actions += `<button class="btn btn-block btn-primary mt8" onclick="Pages.pdcaResolve(${p.id})">✅ 问题解决 → 进入回顾</button>`;
        }
      } else {
        if (isReporter || (canManage && !App.caps.isGuest)) {
          actions += `<button class="btn btn-block" onclick="Pages.pdcaReview(${p.id})">📖 复盘 / 回顾感悟 / 人人讲</button>`;
        }
        const canReopen = (canManage && !App.caps.isGuest) || p.reporter === u.realName;
        if (canReopen) actions += `<button class="btn btn-block btn-outline mt8" onclick="Pages.pdcaReopen(${p.id})">↩ 重新打开（继续追问）</button>`;
        // 谁开的帖子由谁关闭（部门问题 / 个人帖通用）；若请教过专家，须至少一条专家回复（后端校验）
        if (p.reporter === u.realName && p.status !== 'closed') {
          actions += `<button class="btn btn-block btn-gray mt8" onclick="Pages.pdcaClose(${p.id})">关闭</button>`;
        }
      }
      if (canDel) actions += `<button class="btn btn-block btn-danger mt8" onclick="Pages.pdcaDelete(${p.id})">🗑️ 删除该问题</button>`;
      UI.modal(`${p.title}`, `
        <div class="flex-between"><span class="text-muted">${esc(p.reporter)} · ${UI.relTime(p.created_at)}</span>${ub(p.urgency)} ${sb(p.source)} <span class="badge badge-${p.status}">${STATUS[p.status] || p.status}</span>${p.ima_media_id ? '<span class="tag tag-ima">✅ 已同步IMA</span>' : ''}</div>
        ${noteHtml4}
        <p style="margin:8px 0;color:#333">${esc(p.description)}</p>
        ${photoHtml}
        ${attChips(p.attachments)}
        <hr class="sep">
        <div class="card-sub">🛠️ 解决方案 / 做法</div>
        ${solHtml || '<div class="text-muted">尚未填写</div>'}
        ${(() => {
          const expertsArr = asArr(p.consult_experts);
          const designersArr = asArr(p.consult_designers);
          if (!expertsArr.length && !designersArr.length) return '';
          const answeredExperts = p.answeredExperts || [];
          const answeredDesigners = p.answeredDesigners || [];
          const showRm = isOpen && canEditPdca; // 提问者（上报人/管理者）且在追问阶段
          const expTags = expertsArr.map(e => {
            const an = answeredExperts.includes(e);
            const rm = (showRm && !an && expertsArr.length > 1) ? ` <span class="tag tag-x" data-pid="${p.id}" data-ptype="expert" data-pname="${esc(e)}" onclick="Pages.pdcaRemoveParticipant(this)">✕</span>` : '';
            return `<span class="tag ${an ? 'tag-resolved' : 'tag-pending'}">🎓 ${esc(e)}${an ? '✓' : ''}${rm}</span>`;
          }).join('');
          const desTags = designersArr.map(d => {
            const an = answeredDesigners.includes(d);
            const rm = (showRm && !an) ? ` <span class="tag tag-x" data-pid="${p.id}" data-ptype="designer" data-pname="${esc(d)}" onclick="Pages.pdcaRemoveParticipant(this)">✕</span>` : '';
            return `<span class="tag ${an ? 'tag-resolved' : 'tag-pending'}">🗣️ ${esc(d)}${an ? '✓' : ''}${rm}</span>`;
          }).join('');
          return `
          <div class="card-sub mt8">👥 参与者${showRm ? '（追问阶段可移除未答复者，专家至少留 1）' : ''}</div>
          ${expTags ? `<div class="sol-experts">${expTags}</div>` : ''}
          ${desTags ? `<div class="sol-experts">${desTags}</div>` : ''}`;
        })()}
        <div class="card-sub mt8">💬 请教专家 / 多轮追问</div>
        ${conHtml || '<div class="text-muted">暂未请教专家</div>'}
        ${p.review ? `
        <hr class="sep">
        <div class="card-sub">📖 复盘 / 回顾</div>
        <div class="sol-content">${esc(p.review.content || '（暂无内容）')}</div>
        ` : ''}
        ${Pages.ackBlockHtml('pdca', p.id, { requireAck: p.require_ack, canRemind: ((canManage && !App.caps.isGuest) || isReporter), instance: 'modal', autoOpen: true })}
        <hr class="sep">
        ${actions}
      `, (mask) => {
        Pages.loadAck('pdca', p.id, 'modal');
        // 若本详情由二级 hash（#/pdca/<id>）进入，点遮罩关闭时清掉地址栏 id，回到列表（硬刷保持仍可用）
        // 仅触屏端挂载：桌面端（精确指针）点遮罩不再关闭弹窗（防误触丢输入），hash 也不应被改
        const finePtr = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (!finePtr) {
          const hm = ('' + location.hash).slice(1).match(/^\/pdca\/(\d+)/);
          if (hm && parseInt(hm[1], 10) === id) {
            mask.addEventListener('click', (e) => {
              if (e.target === mask && /^#\/pdca\/\d+/.test(location.hash)) location.hash = '#/pdca';
            });
          }
        }
      });
    } catch (e) { UI.loading(false); UI.toast(e.message); }
  };

  Pages.pdcaConsult = async (id) => {
    const inp = document.getElementById('dq-' + id);
    const q = inp ? inp.value.trim() : '';
    if (!q) return UI.toast('请输入追问内容');
    try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/consult`, { question: q }); UI.toast('已追问并通知专家'); closeAllModals(); await Pages.pdcaDetail(id); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };
  Pages.pdcaAnswer = (id, cid, parentId) => {
    const attStore = [];
    const title = parentId ? '回复发言' : '答复追问';
    UI.modal(title, `
      <div class="field"><label>答复内容<span class="req">*</span></label><textarea class="textarea" id="ans-${cid}"></textarea></div>
      <div class="field"><label>附件（照片 / 文件，可选）</label><input type="file" id="ans-attach-${cid}" multiple class="sr-only-file"><div id="ans-attach-list-${cid}" class="att-list"></div></div>
      <button class="btn btn-block" id="ans-sub">提交答复</button>`,
      (mask, close) => {
        bindAttachInput(mask, `ans-attach-${cid}`, `ans-attach-list-${cid}`, attStore);
        mask.querySelector('#ans-sub').onclick = async () => {
          const answer = mask.querySelector(`#ans-${cid}`).value.trim();
          if (!answer) return UI.toast('请填写答复');
          try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/answer`, { consultId: cid, answer, attachments: attStore, parentId: parentId || null }); closeAllModals(); UI.toast('已答复并通知上报人'); await Pages.pdcaDetail(id); }
          catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
        };
      });
  };

  // 删除自己的发言：后端校验「仅本人 + 未被回复」后才删，否则报错提示
  Pages.deleteAnswer = async (id, ansId) => {
    if (!(await UI.confirm(isSuperAdmin() ? '确认强制删除这条发言？（管理员删除，若含子回复将一并提升）' : '确认删除你自己的这条发言？若已被他人回复则不可删除。'))) return;
    try { UI.loading(true); await API.del('/api/pdca/answers/' + ansId); UI.toast('已删除'); closeAllModals(); await Pages.pdcaDetail(id); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // 追问阶段移除未答复的参与者（共议设计师 / 被请教专家）：仅提问者（上报人/管理者）可操作；
  // 后端校验「尚未答复」且专家至少留 1 位。移除后刷新详情。
  Pages.pdcaRemoveParticipant = async (el) => {
    const id = el.getAttribute('data-pid');
    const type = el.getAttribute('data-ptype');
    const name = el.getAttribute('data-pname');
    if (!(await UI.confirm(`确认移除${type === 'expert' ? '专家' : '共议设计师'}「${name}」？仅可移除尚未答复的参与者${type === 'expert' ? '，且至少须保留 1 位专家' : ''}。`))) return;
    try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/participants`, { type, name }); UI.toast('已移除参与者'); closeAllModals(); await Pages.pdcaDetail(id); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  Pages.pdcaAddSolution = (id) => {
    const solPhotos = [];
    const solFiles = [];
    const renderPrev = () => {
      UI.renderPhotoGrid(document.getElementById('sol-photo-grid'), document.getElementById('sol-photos'), solPhotos);
      const list = document.getElementById('sol-file-list');
      if (list) {
        list.innerHTML = solFiles.map((f, i) => `<div class="att-chip">📎 ${esc(f.name || f.url)} <span class="att-x" onclick="Pages._solDelFile(${i})">×</span></div>`).join('');
        if (!solFiles.length) list.innerHTML = '<span class="att-add" onclick="document.getElementById(\'sol-files\').click()">＋ 添加附件</span>';
      }
    };
    UI.modal('拟设解决方案 / 做法', `
      <div class="field">
        <div style="display:flex;justify-content:space-between;align-items:center"><label>解决方案 / 自己的做法<span class="req">*</span></label></div>
        <textarea class="textarea" id="sol-c" placeholder="描述你打算怎么解决，或已经怎么做…"></textarea>
      </div>
      <div class="field"><label>图片（拍摄或相册，可选；最多 9 张）</label>
        <div class="photo-grid" id="sol-photo-grid"></div>
        <input type="file" id="sol-photos" accept="image/*" multiple class="sr-only-file">
      </div>
      <div class="field"><label>附件（文档 / 表格等，可选）</label>
        <input type="file" id="sol-files" multiple class="sr-only-file">
        <div id="sol-file-list" class="att-list"></div>
      </div>
      <button class="btn btn-block btn-lg mt8" id="sol-sub">保存</button>
    `, (mask, close) => {
      renderPrev();  // 初始渲染：显示空的「＋拍照/相册」虚线框
      mask.querySelector('#sol-photos').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); solPhotos.push(...(resp.urls || [])); renderPrev(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      mask.querySelector('#sol-files').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); solFiles.push(...(resp.files || [])); renderPrev(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      mask.querySelector('#sol-sub').onclick = async () => {
        const content = mask.querySelector('#sol-c').value.trim();
        if (!content) return UI.toast('请填写');
        try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/solution`, { content, photos: solPhotos, attachments: solFiles }); closeAllModals(); UI.toast('已保存'); await Pages.pdcaDetail(id); }
        catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };
  Pages._solDelFile = (i) => { solFiles.splice(i, 1); const l = document.getElementById('sol-file-list'); if (l) l.innerHTML = solFiles.map((f, k) => `<div class="att-chip">📎 ${esc(f.name || f.url)} <span class="att-x" onclick="Pages._solDelFile(${k})">×</span></div>`).join(''); };

  // 请教专家（已记录 / 已请教 问题均可追加轮次）
  Pages.pdcaAsk = (id) => {
    const p = pdcaList.find(x => x.id === id) || null;
    const expHtml = expListHtml(pdcaExperts, p && p.consult_experts);
    const desgSel = designerSelectHtml('ask', (p && p.consult_designers) || []);
    UI.modal('请教专家', `
      <div class="field"><label>请教专家（多选）</label><div class="exp-list" id="ask-exp-list">${expHtml}</div></div>
      ${desgSel}
      <div class="field"><label>问题 / 背景</label><textarea class="textarea" id="ask-q" placeholder="可补充你想请教的具体问题…">${esc(p ? p.description : '')}</textarea></div>
      <button class="btn btn-block btn-lg" id="ask-sub">推送请教</button>
    `, (mask, close) => {
      bindDesignerFilter(mask, 'ask');
      mask.querySelector('#ask-sub').onclick = async () => {
        const experts = Array.from(mask.querySelectorAll('#ask-exp-list input:checked')).map(c => c.value);
        if (!experts.length) return UI.toast('请至少选择一位专家');
        const designers = collectDesigners(mask, 'ask');
        const question = mask.querySelector('#ask-q').value.trim();
        try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/ask`, { experts, designers, question }); closeAllModals(); UI.toast('已请教专家' + (designers.length ? '并邀请共议' : '')); await Pages.pdcaDetail(id); }
        catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  Pages.pdcaResolve = async (id) => {
    try { UI.loading(true); await API.post(`/api/pdca/problems/${id}/resolve`, {}); UI.toast('已标记解决'); setPdcaTabState('review'); Pages.pdcaGoList(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  Pages.pdcaReview = async (id) => {
    let p;
    try { UI.loading(true); p = await API.get('/api/pdca/problems/' + id); UI.loading(false); }
    catch (e) { UI.loading(false); return UI.toast(e.message); }
    const u = App.user;
    const isReporter = p.reporter === u.realName;
    const isManager = App.caps.canManage;
    if (!isReporter && !isManager) return UI.toast('仅上报人或管理者可填写复盘');
    const rv = p.review || {};
    // 复盘/回顾感悟「快捷填入」示例文本（演示用，取代原 654321 占位）
    UI.modal('复盘 / 回顾 / 人人讲', `
      ${isReporter ? `
        <div class="field">
          <div style="display:flex;justify-content:space-between;align-items:center"><label>回顾感悟 / 复盘总结</label></div>
          <textarea class="textarea" id="rv-c" placeholder="问题根因、改进措施、可复用经验…">${esc(rv.content || '')}</textarea>
        </div>
      ` : (rv.content ? `
        <div class="field"><label>上报人复盘</label><div class="sol-content">${esc(rv.content)}</div></div>
      ` : '<div class="text-muted">上报人尚未填写复盘</div>')}
      ${isReporter ? `<button class="btn btn-block btn-lg ${isReporter && p.status !== 'closed' ? 'btn-ima' : ''}" id="rv-sub">${isReporter && p.status !== 'closed' ? '💾 保存复盘并加入 IMA 闭环' : '保存'}</button>` : ''}
      ${isReporter ? `
        <div class="field mt8"><label>IMA 入库内容</label>
          <div class="seg" id="rv-mode">
            <span class="seg-item active" data-v="full" onclick="Pages._seg(this)">完整版（含问答全过程）</span>
            <span class="seg-item" data-v="review" onclick="Pages._seg(this)">仅复盘感悟</span>
          </div>
        </div>
        <p class="text-muted" style="font-size:var(--fs-t5);margin-top:8px">点击上方按钮即把本案同步进 IMA「SHARE-知识库 → 02千里行质量人人讲」并置为「已闭环」。</p>
      ` : ''}
    `, (mask, close) => {
      const canEditContent = isReporter;
      const subBtn = mask.querySelector('#rv-sub');
      if (subBtn) subBtn.onclick = async () => {
        const body = {};
        if (canEditContent) {
          body.content = mask.querySelector('#rv-c').value.trim();
        }
        try {
          UI.loading(true);
          await API.post(`/api/pdca/problems/${id}/review`, body);
          // 合并为一步闭环：上报人且问题尚未闭环时，保存复盘后自动加入 IMA 闭环（消除 reviewed 死态误导）
          if (isReporter && p.status !== 'closed') {
            const imaBody = {
              content: body.content || '',
              mode: mask.querySelector('#rv-mode .seg-item.active').dataset.v,
            };
            try {
              const r = await API.post(`/api/pdca/problems/${id}/ima`, imaBody);
              close(); UI.toast(r.message || '✅ 已复盘并加入 IMA 质量库（已闭环）'); Pages.pdcaGoList(); return;
            } catch (ie) {
              UI.toast('复盘已保存，但加入 IMA 失败：' + ie.message + '（可稍后在详情重试「关闭」）');
              close(); Pages.pdcaGoList(); return;
            }
          }
          close(); UI.toast('已保存'); Pages.pdcaGoList();
        }
        catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  Pages.pdcaClose = async (id) => {
    if (!(await UI.confirm('确认关闭该问题？关闭后将进入「已闭环」状态，可重新打开继续追问。'))) return;
    try { UI.loading(true); const r = await API.put(`/api/pdca/problems/${id}/close`, {}); UI.toast(r.imaSynced ? '✅ 已闭环并同步到 IMA「02千里行质量人人讲」' : '已闭环（IMA 同步失败）'); Pages.pdcaGoList(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  Pages.pdcaInviteDesigners = (id) => {
    UI.modal('邀请设计师共议', `
      ${designerSelectHtml('inv')}
      <button class="btn btn-block btn-lg" id="inv-sub">邀请</button>
    `, (mask, close) => {
      bindDesignerFilter(mask, 'inv');
      mask.querySelector('#inv-sub').onclick = async () => {
        const designers = collectDesigners(mask, 'inv');
        if (!designers.length) return UI.toast('请选择设计师');
        try { UI.loading(true); const r = await API.post(`/api/pdca/problems/${id}/invite-designers`, { designers }); closeAllModals(); UI.toast(r.message); await Pages.pdcaDetail(id); }
        catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  Pages.pdcaReopen = async (id) => {
    if (!(await UI.confirm('重新打开后，此问题将回到「待解决」状态，可继续向专家追问。确定？'))) return;
    try { UI.loading(true); await API.put(`/api/pdca/problems/${id}/reopen`, {}); UI.toast('已重新打开，可继续追问'); setPdcaTabState('solving'); Pages.pdcaGoList(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // 删除 PDCA 问题（超级管理员/管理者任意状态可删；上报人仅未闭环/未解决可删）。复用后端 DELETE /api/pdca/problems/:id（含子表级联）。
  Pages.pdcaDelete = async (id) => {
    if (!(await UI.confirm('确定删除该 PDCA 问题？将一并删除其方案、请教/共议记录、参与人等全部子内容，不可恢复。'))) return;
    try {
      UI.loading(true);
      const r = await API.del('/api/pdca/problems/' + id);
      UI.loading(false);
      UI.toast(r.message || '已删除');
      Pages.pdcaGoList();
    } catch (e) { UI.loading(false); UI.toast(e.message || '删除失败'); }
  };

  // ── 质量库（统一检索）─────────
  let workTab = 'library';
  let qaLastQ = '';   // 质量问答：保留最近一次检索词（切子tab回来不丢）
  // 问答快照缓存（2026-10-12）：切子tab/切页面回来直接复用，AI 不重算、不重复扣额度。
  // 结构 { q, hits:[], ai:null|<ask响应>, ms }；仅换新问题或手动点「问一问」时重置。
  let qaCache = null;
  let qaInflight = false;   // AI 请求进行中（进行中切走再切回，继续显示转圈，回来后结果照常落入）
  // AI 问答总开关（2026-10-12）：仅超级管理员可见/可切换；关闭时所有人不能 AI 问答（检索不受影响）
  let qaAiEnabled = true;
  let qaCanToggle = false;
  let qaStatusLoaded = false;
  Pages.work = async () => {
    const canManage = App.caps.canManage;
    // 一级栏目：不显示返回键（质量库的条目详情是弹窗、不产生二级路由，底部 tab 即上层）。
    app().innerHTML = `${topbar('质量库')}<div class="page">
      ${Pages.circleTabs([
        { icon: 'library', label: '质量库', active: workTab === 'library', onclick: "Pages.workSetTab('library')" },
        { icon: 'qa',      label: '库问答', active: workTab === 'qa',      onclick: "Pages.workSetTab('qa')" },
        { icon: 'exam',    label: '检验池', active: workTab === 'exam',    onclick: "Pages.workSetTab('exam')" },
      ], 'work-tabs')}
      <div id="work-body"></div>
    </div>${Pages.tabbar('work')}`;
    await loadWork(canManage);
  };
  Pages.workSetTab = (t) => { workTab = t; if (t === 'exam') examView = 'list'; Pages.work(); };

  async function loadWork(canManage) {
    const body = document.getElementById('work-body');
    if (!body) return;
    if (workTab === 'library') {
      await renderLibrary(body);
    } else if (workTab === 'exam') {
      await renderExam(body);
    } else if (workTab === 'qa') {
      renderQa(body);
    }
  }

  // ── 质量问答（2026-10-11，Phase 1：FTS5 纯检索，无 LLM）──
  // 检索范围=质量库已发布内容+附件正文（docx/xlsx/txt）；pdf/doc 等仅索引文件名。
  // 每条结果必带来源类型与跳转，答案不生成、只摘原文片段 —— 无编造风险。
  const QA_KIND_META = {
    '公告':     { cls: 'qa-k-ann',  label: '公告' },
    '宣贯':     { cls: 'qa-k-dis',  label: '宣贯' },
    '质量专题': { cls: 'qa-k-top',  label: '质量专题' },
    '专题动态': { cls: 'qa-k-post', label: '专题动态' },
    'PDCA':     { cls: 'qa-k-pdca', label: 'PDCA' },
    '附件':     { cls: 'qa-k-att',  label: '附件' },
  };
  function renderQa(body) {
    const canManage = App.caps && App.caps.canManage;
    body.innerHTML = `
      <div class="qa-card">
        <div class="qa-search-row">
          <input id="qa-input" class="qa-input" type="search" placeholder="向质量库提问：问题、要求、标准、附件内容…"
                 value="${esc(qaLastQ)}" autocomplete="off">
          <button class="btn btn-primary qa-go" onclick="Pages.qaSearch()">问一问</button>
        </div>
        <div class="qa-hint">AI 依据质量库原文回答并附来源（公告 · 宣贯 · 专题 · 动态 · PDCA · 附件正文）。资料只送腾讯云 TokenHub 生成回答，不出境。</div>
        <div id="qa-switch-row"></div>
        ${canManage ? '<button class="qa-rebuild" onclick="Pages.qaRebuild()">↻ 重建索引</button>' : ''}
      </div>
      <div id="qa-ai"></div>
      <div id="qa-results" class="qa-results"></div>`;
    const inp = document.getElementById('qa-input');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); Pages.qaSearch(); } });
    const box = document.getElementById('qa-results');
    // 库问答总开关状态：首次拉取，之后复用（渲染开关行 / 关闭处理）
    if (!qaStatusLoaded) {
      qaStatusLoaded = true;
      API.get('/api/qa/status').then(d => {
        qaAiEnabled = !!d.ai_enabled;
        qaCanToggle = !!d.can_toggle;
        applyQaSwitch();
      }).catch(() => {});
    } else {
      applyQaSwitch();
    }
    if (qaLastQ && qaCache && qaCache.q === qaLastQ) {
      // 命中快照：直接复用上次的检索结果与 AI 回答，不重打接口（省额度）
      if (qaCache.hits && qaCache.hits.length) renderQaResults(qaCache.hits);
      else if (qaCache.ai && qaCache.ai.sources) fillResultsFromSources(qaCache.ai.sources, '未直接命中「' + esc(qaLastQ) + '」，以下为相关度最高的资料：');
      else box.innerHTML = '<div class="qa-empty">未找到与「' + esc(qaLastQ) + '」相关的内容。可尝试换词或减少字数。</div>';
      const aiEl = document.getElementById('qa-ai');
      if (qaCache.ai) aiEl.innerHTML = qaAiCardHtml(qaCache.ai, qaCache.ms);
      else if (qaInflight) aiEl.innerHTML = QA_LOADING_HTML;   // 切走时还在生成 → 回来继续等
    } else if (qaLastQ) {
      Pages.qaSearch();   // 缓存未命中（如刷新页面后）才真正重查
    } else {
      box.innerHTML = '';
      document.getElementById('qa-ai').innerHTML = '<div class="qa-empty">输入问题（如「卷册抽检有哪些问题」「图纸命名要求」），AI 先查质量库原文再回答，点击来源可直达详情。</div>';
    }
  }
  // 检索结果直达详情：索引 route 存动作描述符（ann:/dis:/pdca:/topic:<id>），
  // 复用专题关联条目同一套详情函数（viewAnnouncement/viewDissem/pdcaDetail）；
  // 兼容旧 '#/...' 哈希与空值。
  // 开关应用：关=整个库问答（检索+AI）对其他人全关；超级管理员保留界面便于确认与验证
  function applyQaSwitch() {
    renderQaSwitchRow();
    if (!qaAiEnabled) {
      if (qaCanToggle) showQaAdminNote();
      else showQaClosed();
    }
  }
  // 开关行：仅超级管理员显示开关控件
  function renderQaSwitchRow() {
    const el = document.getElementById('qa-switch-row');
    if (!el) return;
    if (qaCanToggle) {
      el.innerHTML = '<div class="qa-sw-row"><span>库问答</span>'
        + `<button type="button" class="qa-sw ${qaAiEnabled ? 'on' : ''}" onclick="Pages.qaAiToggle()" aria-label="库问答开关"></button>`
        + `<span class="${qaAiEnabled ? '' : 'qa-sw-off-note'}">${qaAiEnabled ? '开启中' : '已关闭'}</span></div>`;
    } else if (!qaAiEnabled) {
      el.innerHTML = '';
    } else {
      el.innerHTML = '';
    }
  }
  // 非超级管理员 + 开关关：整个问答界面替换为关闭提示
  function showQaClosed() {
    const body = document.getElementById('work-body');
    if (body) body.innerHTML = '<div class="qa-card qa-ai-err" style="margin-top:12px">库问答已临时关闭（管理员开关）。</div>';
    qaCache = null; qaLastQ = '';
  }
  // 超级管理员 + 开关关：保留界面（服务端对超级管理员放行），顶部说明现状
  function showQaAdminNote() {
    const ai = document.getElementById('qa-ai');
    if (ai && !qaInflight) ai.innerHTML = '<div class="qa-card qa-ai-err">库问答已对全员关闭（检索+AI）。打开开关即恢复使用。</div>';
  }
  Pages.qaAiToggle = async () => {
    try {
      const d = await API.post('/api/qa/ai-toggle', { enabled: !qaAiEnabled }).catch(e => ({ error: e.message }));
      if (d && d.error) { UI.toast('切换失败：' + d.error); return; }
      qaAiEnabled = !!d.ai_enabled;
      renderQaSwitchRow();
      UI.toast(qaAiEnabled ? '库问答已开启' : '库问答已关闭（其他人检索+AI 均不可用）');
      if (!qaAiEnabled) showQaAdminNote();
      else {
        const ai = document.getElementById('qa-ai');
        if (qaLastQ && qaCache && qaCache.q === qaLastQ && qaCache.ai) ai.innerHTML = qaAiCardHtml(qaCache.ai, qaCache.ms);
        else ai.innerHTML = '';
      }
    } catch (e) { UI.toast('切换异常：' + (e && e.message || e)); }
  };
  function qaRouteOnclick(route) {
    const m = String(route || '').match(/^(ann|dis|pdca|topic):(\d+)$/);
    if (m) {
      const id = m[2];
      if (m[1] === 'ann') return `Pages.viewAnnouncement(${id})`;
      if (m[1] === 'dis') return `Pages.viewDissem(${id})`;
      if (m[1] === 'pdca') return `Pages.pdcaDetail(${id})`;
      return `location.hash='#/memo/topic/${id}'`;
    }
    if (route && /^\#\//.test(route) && route !== '#/work') return `location.hash='${route}'`;
    return "Pages.workSetTab('library')";
  }
  Pages.qaSearch = async () => {
    const inp = document.getElementById('qa-input');
    const box = document.getElementById('qa-results');
    if (!inp || !box) return;
    if (!qaAiEnabled && !qaCanToggle) { showQaClosed(); return; }   // 总开关关闭且非超级管理员：不发请求
    const q = (inp.value || '').trim();
    qaLastQ = q;
    if (!q) { box.innerHTML = '<div class="qa-empty">请输入问题。</div>'; return; }
    box.innerHTML = '<div class="qa-empty">检索中…</div>';
    const d = await API.get('/api/qa/search?q=' + encodeURIComponent(q) + '&limit=30').catch(e => ({ error: e.message }));
    if (d && d.error) { box.innerHTML = '<div class="qa-empty">检索失败：' + esc(d.error) + '</div>'; return; }
    qaLastHits = (d.hits && d.hits.length) || 0;
    // 新提问 → 重置快照（旧 AI 回答作废）
    qaCache = { q, hits: (d.hits && d.hits.slice()) || [], ai: null, ms: 0 };
    if (!d.hits || !d.hits.length) { box.innerHTML = '<div class="qa-empty">未找到与「' + esc(q) + '」相关的内容。可尝试换词或减少字数。</div>'; }
    else renderQaResults(d.hits);
    if (!qaAiEnabled) { if (qaCanToggle) showQaAdminNote(); else showQaClosed(); return; }   // 总开关关闭：只到检索为止（超级管理员除外）
    Pages.qaAsk(q);
  };
  function renderQaResults(hits) {
    const box = document.getElementById('qa-results');
    if (!box) return;
    box.innerHTML = hits.map((h, i) => {
      const meta = QA_KIND_META[h.kind] || { cls: '', label: h.kind };
      const snip = esc(h.snip).replace(/\[/g, '<mark>').replace(/\]/g, '</mark>');
      return `<div class="qa-hit" onclick="${qaRouteOnclick(h.route)}">
        <div class="qa-hit-top"><span class="qa-kind ${meta.cls}">${meta.label}</span>
          <span class="qa-hit-title">${esc(h.title)}</span></div>
        <div class="qa-hit-snip">…${snip}…</div>
        <div class="qa-hit-meta">${esc(h.author || '')}${h.author ? ' · ' : ''}${esc(String(h.updated_at || '').slice(0, 10))}</div>
      </div>`;
    }).join('');
  }
  // AI 回答（Phase 2，2026-10-12）：先服务端检索取原文片段 → TokenHub hy3 生成 → 带来源返回。
  // 检索结果即时展示，AI 卡片异步填充（推理模型生成约 10~40 秒）。
  let qaAskSeq = 0;
  let qaLastHits = 0;   // 最近一次检索命中数（0 时由 AI 来源回填结果区）
  const QA_LOADING_HTML = '<div class="qa-card qa-ai-loading"><span class="qa-spin"></span>AI 正在阅读质量库相关资料并生成回答…（约 10~40 秒）</div>';
  function fillResultsFromSources(sources, note) {
    const box = document.getElementById('qa-results');
    if (!sources || !sources.length || !box) return;
    box.innerHTML = (note ? '<div class="qa-empty">' + note + '</div>' : '')
      + sources.map(s => {
        const meta = QA_KIND_META[s.kind] || { cls: '', label: s.kind };
        return `<div class="qa-hit" onclick="${qaRouteOnclick(s.route)}">
          <div class="qa-hit-top"><span class="qa-kind ${meta.cls}">${meta.label}</span>
            <span class="qa-hit-title">${esc(s.title)}</span></div>
        </div>`;
      }).join('');
  }
  Pages.qaAsk = async (q) => {
    const ai = document.getElementById('qa-ai');
    if (!ai) return;
    if (!qaAiEnabled && !qaCanToggle) { showQaClosed(); return; }   // 双保险：总开关关闭且非超级管理员不发起请求
    const seq = ++qaAskSeq;
    qaInflight = true;
    ai.innerHTML = QA_LOADING_HTML;
    const t0 = Date.now();
    const d = await API.post('/api/qa/ask', { q }).catch(e => ({ error: e.message }));
    qaInflight = false;
    // 结果写入快照：即使期间切走过（DOM 换了新元素）也缓存，切回来直接复用不重算
    if (qaCache && qaCache.q === q) { qaCache.ai = d; qaCache.ms = Date.now() - t0; }
    if (seq !== qaAskSeq || !document.getElementById('qa-ai')) return;   // 已有新提问或切走子tab
    if (d && d.error) {
      ai.innerHTML = '<div class="qa-card qa-ai-err">' + esc(d.error) + '</div>';
      fillResultsFromSources(d.sources);
      return;
    }
    if (d && d.ok === false && d.reason === 'llm_not_configured') { ai.innerHTML = ''; return; }
    if (d && d.no_hits) { ai.innerHTML = '<div class="qa-card qa-ai-err">质量库中没有与「' + esc(q) + '」直接相关的资料，AI 无法作答。可尝试换词。</div>'; return; }
    // 检索 0 命中但 AI 经相关度兜底找到了资料 → 回填结果区
    if (!qaLastHits) fillResultsFromSources(d.sources, '未直接命中「' + esc(q) + '」，以下为相关度最高的资料：');
    ai.innerHTML = qaAiCardHtml(d, Date.now() - t0);
  };
  // AI 卡片 HTML（qaAsk 渲染与切回快照复用共用一份）
  function qaAiCardHtml(d, ms) {
    if (!d) return '';
    if (d.error) return '<div class="qa-card qa-ai-err">' + esc(d.error) + '</div>';
    if (d.ok === false && d.reason === 'llm_not_configured') return '';
    if (d.no_hits) return '<div class="qa-card qa-ai-err">质量库中没有相关资料，AI 无法作答。可尝试换词。</div>';
    const srcs = (d.sources || []).map((s, i) => {
      const meta = QA_KIND_META[s.kind] || { cls: '', label: s.kind };
      return `<a class="qa-src" onclick="${qaRouteOnclick(s.route)}"><b>${i + 1}</b> ${meta.label}·${esc(String(s.title || '').slice(0, 16))}</a>`;
    }).join('');
    return `<div class="qa-card qa-ai-card">
      <div class="qa-ai-head">✦ AI 回答 <span class="qa-ai-ms">${((ms || 0) / 1000).toFixed(1)}s · ${esc(d.model || '')}</span></div>
      <div class="qa-ai-answer">${esc(String(d.answer || '')).replace(/\n/g, '<br>')}</div>
      ${srcs ? '<div class="qa-ai-srcs">来源：' + srcs + '</div>' : ''}
    </div>`;
  }
  Pages.qaRebuild = async () => {
    try {
      UI.loading(true);
      const d = await API.post('/api/qa/rebuild', {}).catch(e => ({ error: e.message }));
      UI.loading(false);
      if (d && d.error) { UI.toast('重建失败：' + d.error); return; }
      const s = d && d.stats || {};
      UI.toast('索引已重建：' + (s.total || 0) + ' 条，用时 ' + (s.ms || 0) + 'ms');
      if (qaLastQ) Pages.qaSearch();
    } catch (e) { UI.loading(false); UI.toast('重建异常：' + (e && e.message || e)); }
  };

  // ── 检验池（出题考试：出题 / 批改 / 计分 / 排名）─────────
  // 2026-09-17：建筑、电气统一放在最后一个顺位（与全站筛选框口径一致）
  // 出题范围框顺序与全站筛选框保持一致：建筑置于第一位，电气沉末尾
  const EXAM_DISCIPLINES = ['建筑', '给排水', '暖通', '通信', '通用', '电气'];
  let examView = 'list';     // 'list' | 'take' | 'ranking'
  let examRoundId = null;
  let examCurrent = null;    // { round_id, title, scope, questions:[{id,discipline,stem,options}], done, result }
  let examAnswers = [];      // 每题所选 index（null=未答）
  let examStartTs = 0;       // 计时基准（服务端 started_at 的 epoch ms）
  let examTimerIv = null;    // 计时器定时器 id

  // 计时器：打开考试即计时；清除 + 格式化
  function clearExamTimer() { if (examTimerIv) { clearInterval(examTimerIv); examTimerIv = null; } }
  function fmtExamDur(ms) {
    if (ms == null || ms < 0 || isNaN(ms)) return '--';
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), ss = s % 60;
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function examBody() { return document.getElementById('work-body'); }

  // 发起 / 删除考试权限：仅 超级管理员 / ××× / ×××
  function isExamAdminFront() {
    const u = App.user || {};
    if (App.caps.isGuest) return false;
    if (u.username === 'superadmin' || u.username === 'wuzhenwu' || u.username === 'panhongyao') return true;
    if (u.realName === '超级管理员' || u.realName === '×××' || u.realName === '×××') return true;
    return false;
  }

  async function renderExam(body) {
    if (examView === 'take' && examCurrent) { paintExamTake(body); return; }
    if (examView === 'ranking' && examRoundId) { body.innerHTML = '<div class="text-muted" style="padding:12px">加载排名…</div>'; const d = await API.get(`/api/exam/rounds/${examRoundId}/ranking`).catch(e => ({ error: e.message })); if (d && !d.error) paintExamRanking(body, d); else body.innerHTML = `<div class="text-muted" style="padding:12px">加载失败：${esc(d.error || '')}</div>`; return; }
    const isGuest = App.caps.isGuest;
    const isAdmin = isExamAdminFront();
    body.innerHTML = `
      <div class="exam-intro">
        <div class="exam-intro-title">🔍 检验池 · 出题考试</div>
        <div class="exam-intro-desc">对「千里行质量库」文档内容出题，自动批改、计分、排名。选范围 → 随机抽题（每场题数由发起者设定）→ 每题 10 分，答对得分、答错/不答 0 分。<b>创建考试本身不计时；每人点「进入考试」才开始为本人单独计时，中途退出计时不暂停，直到提交为止</b>，同分者用时短者排名靠前。</div>
        ${isGuest
          ? (App.caps.canExam
              ? '<div class="exam-guest-hint">您当前为<b>演示/测试游客</b>，可<b>参与作答</b>考试与查看排名（其余操作只读）。</div>'
              : '<div class="exam-guest-hint">游客仅可浏览，<b>登录后</b>可参与作答考试。</div>')
          : isAdmin
            ? `<button class="btn btn-block btn-lg btn-primary mt8" onclick="Pages.examStartRound()">＋ 开始新考试</button>`
            : '<div class="exam-guest-hint">仅 <b>超级管理员 / ××× / ×××</b> 可发起新考试，您可参与作答与查看成绩。</div>'}
      </div>
      <div id="exam-list" class="exam-section"><div class="text-muted" style="padding:12px">加载考试列表…</div></div>
      <div id="exam-myscores" class="exam-section"></div>
    `;
    loadExamList(body);
    loadExamMyScores(body);
  }

  async function loadExamList(body) {
    const el = body.querySelector('#exam-list');
    if (!el) return;
    try {
      const rounds = await API.get('/api/exam/rounds');
      const isAdmin = isExamAdminFront();
      if (!rounds.length) {
        el.innerHTML = `<div class="exam-sec-title">考试列表</div><div class="empty"><div class="ei">📝</div><div class="et">${isAdmin ? '暂无考试，点上方「开始新考试」发起第一场' : '暂无考试'}</div><div class="es">新的考试发布后会显示在这里</div></div>`;
        return;
      }
      el.innerHTML = `<div class="exam-sec-title">考试列表（${rounds.length}）</div>` + rounds.map(r => `
        <div class="exam-round-card">
          <div class="exam-round-top">
            <span class="exam-round-title">${esc(r.title)}</span>
            <span class="exam-round-by">由 ${esc(r.created_by_name || '—')}</span>
          </div>
          <div class="exam-round-scope">${r.scope.map(d => `<span class="exam-scope-tag">${esc(d)}</span>`).join('')}</div>
          <div class="exam-round-meta">共 ${r.count || 10} 题 · ${UI.relTime(r.created_at)} · ${r.done_count} 人已完成</div>
          <div class="row-btns mt8">
            ${(App.caps.isGuest && !App.caps.canExam) ? '' : `<button class="btn btn-sm btn-primary" onclick="Pages.examTake(${r.id})">${r.my_done ? '查看我的成绩' : '进入考试'}</button>`}
            ${(App.caps.isGuest && !App.caps.canExam) ? '' : `<button class="btn btn-sm btn-outline" onclick="Pages.examRanking(${r.id})">🏆 排名</button>`}
            ${isAdmin ? `<button class="btn btn-sm btn-danger-outline" onclick="Pages.examDeleteRound(${r.id})">🗑 删除</button>` : ''}
          </div>
        </div>
      `).join('');
    } catch (e) { el.innerHTML = `<div class="text-muted" style="padding:12px">加载失败：${esc(e.message)}</div>`; }
  }

  async function loadExamMyScores(body) {
    const el = body.querySelector('#exam-myscores');
    if (!el) return;
    if (App.caps.isGuest && !App.caps.canExam) { el.innerHTML = ''; return; }
    try {
      const rows = await API.get('/api/exam/my-scores');
      if (!rows.length) { el.innerHTML = `<div class="exam-sec-title">我的历次成绩</div><div class="text-muted" style="padding:8px 0">尚未参加任何考试</div>`; return; }
      el.innerHTML = `<div class="exam-sec-title">我的历次成绩（${rows.length}）</div>` + rows.map(r => `
        <div class="exam-score-row" onclick="Pages.examTake(${r.round_id})">
          <div class="exam-score-main">
            <span class="exam-score-num">${r.score}</span><span class="exam-score-unit">分</span>
            <span class="exam-score-sub">对 ${r.correct_count}/${r.total || 10}</span>
          </div>
          <div class="exam-score-meta">
            <div>${esc(r.title)}</div>
            <div class="text-muted">${r.scope.map(d => esc(d)).join('·')} · 用时 ${fmtExamDur(r.duration_ms)} · ${UI.relTime(r.submitted_at || r.created_at)}</div>
          </div>
          <span class="exam-score-arrow">›</span>
        </div>
      `).join('');
    } catch (e) { el.innerHTML = `<div class="text-muted" style="padding:8px">加载失败：${esc(e.message)}</div>`; }
  }

  Pages.examStartRound = () => {
    if (App.caps.isGuest) { UI.toast('游客无法发起考试'); return; }
    if (!isExamAdminFront()) { UI.toast('仅 超级管理员 / ××× / ××× 可发起考试'); return; }
    const boxes = EXAM_DISCIPLINES.map(d => `<label class="exam-scope-opt"><input type="checkbox" value="${esc(d)}" ${d === '通用' ? 'checked' : ''}> ${esc(d)}</label>`).join('');
    const counts = [5, 10, 15, 20, 30];
    UI.modal('选择出题范围与题数', `
      <p class="text-muted" style="font-size:var(--fs-t5);margin:0 0 10px">可多选专业；「通用」为无专业倾向的题。将按所选范围比例出题（宣贯内容加权）。</p>
      <div class="exam-scope-grid">${boxes}</div>
      <div class="exam-count-row">
        <span class="exam-count-label">共出题数</span>
        <div class="exam-count-opts" id="exam-count-opts">
          ${counts.map(n => `<button type="button" class="exam-count-opt ${n === 20 ? 'active' : ''}" data-count="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="field mt12">
        <label>考试标题（默认「2026质量月综合测试」，可修改；留空则自动命名）</label>
        <input class="input" id="exam-title" maxlength="60" value="2026质量月综合测试" placeholder="可修改，如：2026质量月检验池第3场">
      </div>
      <button class="btn btn-block btn-lg btn-primary mt12" id="exam-start-sub">开始组卷</button>
    `, (mask, close) => {
      const opts = mask.querySelector('#exam-count-opts');
      opts.querySelectorAll('.exam-count-opt').forEach(btn => btn.onclick = () => {
        opts.querySelectorAll('.exam-count-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      mask.querySelector('#exam-start-sub').onclick = async () => {
        const sel = Array.from(mask.querySelectorAll('.exam-scope-opt input:checked')).map(i => i.value);
        if (!sel.length) return UI.toast('请至少选择一个范围');
        const cnt = parseInt(opts.querySelector('.exam-count-opt.active').getAttribute('data-count'), 10) || 20;
        const titleEl = mask.querySelector('#exam-title');
        const titleVal = titleEl ? (titleEl.value || '').trim().slice(0, 60) : '';
        try {
          UI.loading(true);
          const r = await API.post('/api/exam/rounds', { scope: sel, count: cnt, title: titleVal });
          closeAllModals();
          // 出题人组卷后不自动进入作答（避免「一出完就被计时」）；回到列表，由「进入考试」触发个人计时
          examView = 'list'; examRoundId = null; examCurrent = null; examAnswers = [];
          const bd = examBody(); if (bd) await renderExam(bd);
          UI.toast('考试已创建；点「进入考试」后才开始计时');
        }
        catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };

  Pages.examTake = async (roundId) => {
    if (App.caps.isGuest && !App.caps.canExam) { UI.toast('游客无法参加考试，请登录'); return; }
    const body = examBody(); if (!body) return;
    try {
      UI.loading(true);
      const data = await API.post(`/api/exam/rounds/${roundId}/start`, {});
      examCurrent = data; examRoundId = roundId;
      // 续答回填：若存在未完成作答记录，恢复已选答案；否则全置空
      examAnswers = (data.savedAnswers && data.savedAnswers.length === data.questions.length)
        ? data.savedAnswers.slice()
        : data.questions.map(() => null);
      // 计时基准以服务端「答卷创建时间」为准（UTC），重进考试也延续同一计时
      examStartTs = data.started_at ? Date.parse(data.started_at.replace(' ', 'T') + 'Z') : Date.now();
      if (isNaN(examStartTs)) examStartTs = Date.now();
      examView = 'take';
      paintExamTake(body);
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  // 作答草稿自动保存：选项变更后防抖 800ms 落库；退出/切后台再补一次。
  // 只存答案、不批改，也不影响计时（计时始终以服务端「首次进入考试时间」为准）。
  let examDraftTimer = null;
  function scheduleExamDraft() {
    if (!examCurrent || examCurrent.done) return;
    clearTimeout(examDraftTimer);
    examDraftTimer = setTimeout(saveExamDraft, 800);
  }
  function saveExamDraft() {
    if (!examCurrent || examCurrent.done) return;
    clearTimeout(examDraftTimer); examDraftTimer = null;
    const rid = examCurrent.round_id, ans = examAnswers.slice();
    API.post(`/api/exam/rounds/${rid}/draft`, { answers: ans }).catch(() => { /* 草稿失败不打扰作答 */ });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && examView === 'take' && examCurrent && !examCurrent.done) saveExamDraft();
  });

  Pages.examAnswer = (k, i) => { examAnswers[k] = i; scheduleExamDraft(); };

  function paintExamTake(body) {
    const d = examCurrent;
    if (!d) return;
    if (d.done && d.result) { paintExamResult(body, d.result, d); return; }
    const qHtml = d.questions.map((q, k) => `
      <div class="exam-q">
        <div class="exam-q-head"><span class="exam-q-no">${k + 1}</span><span class="exam-q-disc">${esc(q.discipline)}</span></div>
        <div class="exam-q-stem">${esc(q.stem)}</div>
        <div class="exam-opts">
          ${q.options.map((opt, i) => `
            <label class="exam-opt"><input type="radio" name="eq${k}" value="${i}" ${examAnswers[k] === i ? 'checked' : ''} onchange="Pages.examAnswer(${k},${i})"> <span class="exam-opt-letter">${'ABCD'[i]}</span><span class="exam-opt-txt">${esc(opt)}</span></label>
          `).join('')}
        </div>
      </div>
    `).join('');
    body.innerHTML = `
      <div class="exam-take-bar">
        <button class="btn btn-sm btn-outline" onclick="Pages.examBackToList()">← 返回</button>
        <span class="exam-take-title">${esc(d.title)}</span>
        <span class="exam-timer" id="exam-timer">⏱ 00:00</span>
      </div>
      <p class="text-muted" style="font-size:var(--fs-t5);margin:8px 0 4px">共 ${d.questions.length} 题，每题 10 分。提交后看解析。<b>进入即开始个人计时，中途退出计时不暂停</b>；已选答案会自动保存，退出后返回可继续作答。同分者用时短者排名靠前。</p>
      ${qHtml}
      <button class="btn btn-block btn-lg btn-primary mt12" onclick="Pages.examSubmit()">提交答卷</button>
    `;
    // 启动计时器（打开考试即计时；每次重绘先清旧的）
    clearExamTimer();
    const timerEl = body.querySelector('#exam-timer');
    if (timerEl) {
      const tick = () => { timerEl.textContent = '⏱ ' + fmtExamDur(Date.now() - examStartTs); };
      tick();
      examTimerIv = setInterval(tick, 1000);
    }
  }

  Pages.examSubmit = async () => {
    if (!examCurrent) return;
    if (examAnswers.some(a => a === null)) {
      if (!(await UI.confirm('还有未作答的题目，确定提交？（未答记 0 分）'))) return;
    }
    const dur = Date.now() - examStartTs;
    try {
      UI.loading(true);
      const r = await API.post(`/api/exam/rounds/${examCurrent.round_id}/submit`, { answers: examAnswers, duration_ms: dur });
      examCurrent.done = true; examCurrent.result = r.result;
      paintExamResult(examBody(), r.result, examCurrent);
      UI.toast(`提交成功，得分 ${r.result.score}（${r.result.correct_count}/${r.result.total || 10}）`);
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  function paintExamResult(body, result, d) {
    clearExamTimer();
    const detailHtml = result.details.map((dt, k) => `
      <div class="exam-r ${dt.correct ? 'ok' : 'bad'}">
        <div class="exam-r-head"><span class="exam-q-no">${k + 1}</span>${dt.correct ? '<span class="exam-r-tag ok">✓ 正确</span>' : '<span class="exam-r-tag bad">✗ 错误</span>'}</div>
        <div class="exam-q-stem">${esc(dt.stem)}</div>
        <div class="exam-opts">
          ${dt.options.map((opt, i) => {
            const isCorrect = i === dt.correctAnswer;
            const isWrongPick = i === dt.yourAnswer && !dt.correct;
            const cls = isCorrect ? 'correct' : (isWrongPick ? 'wrong' : '');
            const mark = isCorrect ? ' ✓' : (isWrongPick ? ' ✗' : '');
            return `<div class="exam-opt result ${cls}"><span class="exam-opt-letter">${'ABCD'[i]}</span><span class="exam-opt-txt">${esc(opt)}${mark}</span></div>`;
          }).join('')}
        </div>
        ${dt.explanation ? `<div class="exam-exp">💡 ${esc(dt.explanation)}</div>` : ''}
      </div>
    `).join('');
    body.innerHTML = `
      <div class="exam-take-bar">
        <button class="btn btn-sm btn-outline" onclick="Pages.examBackToList()">← 返回</button>
        <span class="exam-take-title">${esc(d.title)} · 成绩</span>
      </div>
      <div class="exam-score-banner ${result.score >= (result.total || 10) * 6 ? 'good' : 'low'}">
        <div class="exam-score-big">${result.score}<span class="exam-score-big-unit">分</span></div>
        <div class="exam-score-cap">答对 ${result.correct_count} / ${result.total || 10} 题 · 用时 ${fmtExamDur(result.duration_ms)}</div>
      </div>
      ${detailHtml}
      <button class="btn btn-block btn-lg btn-outline mt12" onclick="Pages.examBackToList()">返回考试列表</button>
    `;
  }

  Pages.examRanking = async (roundId) => {
    if (App.caps.isGuest && !App.caps.canExam) { UI.toast('游客无法查看排名，请登录后查看'); return; }
    const body = examBody(); if (!body) return;
    examView = 'ranking'; examRoundId = roundId;
    body.innerHTML = '<div class="text-muted" style="padding:12px">加载排名…</div>';
    try {
      UI.loading(true);
      const data = await API.get(`/api/exam/rounds/${roundId}/ranking`);
      paintExamRanking(body, data);
    } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  function paintExamRanking(body, data) {
    const rk = data.ranking || [];
    const rows = rk.length ? rk.map(p => `
      <div class="exam-rank-row ${p.rank <= 3 ? 'top' : ''}">
        <span class="exam-rank-no ${p.rank === 1 ? 'gold' : p.rank === 2 ? 'silver' : p.rank === 3 ? 'bronze' : ''}">${p.rank}</span>
        <span class="exam-rank-name">${esc(p.user_name)}</span>
        <span class="exam-rank-score">${p.score}<small>分</small></span>
        <span class="exam-rank-sub">对${p.correct_count}/${p.total || 10}</span>
        <span class="exam-rank-time">⏱ ${fmtExamDur(p.duration_ms)}</span>
      </div>
    `).join('') : '<div class="empty"><div class="ei">🏆</div><div class="et">本场暂无已完成成绩</div><div class="es">完成后成绩会自动归档</div></div>';
    body.innerHTML = `
      <div class="exam-take-bar">
        <button class="btn btn-sm btn-outline" onclick="Pages.examBackToList()">← 返回</button>
        <span class="exam-take-title">排名 · ${esc(data.round.title)}</span>
      </div>
      <div class="exam-rank-meta text-muted">出题范围：${data.round.scope.map(d => esc(d)).join('·')} · 共 ${data.participant_count} 人完成（分数降序 → 用时升序，同分用时短者列前）</div>
      <div class="exam-rank-list">${rows}</div>
    `;
  }

  Pages.examBackToList = () => {
    clearExamTimer();
    saveExamDraft();               // 退出即落盘草稿，保证返回后可续答
    examView = 'list'; examCurrent = null; examRoundId = null;
    const body = examBody();
    if (body) renderExam(body);
  };

  // 删除一场考试（含其答卷），仅超级管理员/×××/××× 可调
  Pages.examDeleteRound = async (roundId) => {
    if (!isExamAdminFront()) { UI.toast('仅 超级管理员 / ××× / ××× 可删除考试'); return; }
    if (!(await UI.confirm('确定删除本场考试？将连同所有参与者的答卷一并清除，不可恢复。'))) return;
    try {
      UI.loading(true);
      await API.del(`/api/exam/rounds/${roundId}`);
      UI.toast('已删除考试');
      const body = examBody();
      if (body) { loadExamList(body); }
    } catch (e) { UI.toast(e.message || '删除失败'); } finally { UI.loading(false); }
  };


  // ── 项目备忘（📝项目备忘：多设计师围绕同一项目分头记录；参与人自动互看 + 专总/超级管理员可见）─────────
  let memoPid = null;      // 当前打开的项目 id（null=项目列表视图）
  let memoProject = null;  // 当前项目对象
  let memoRecords = [];    // 当前项目记录（供编辑预填）
  let memoBodyEl = null;   // 当前渲染容器（主 Tab 用 #memo-body）
  let memoPersonnel = [];  // 人员名单（谁可见 多选）
  const memoPersonMap = {};// id -> real_name
  let memoComposePhotos = []; // 当前编辑中的图片 url 数组
  let memoComposeFiles = [];  // 当前编辑中的附件 {url,name,size} 数组
  let memoSub = 'memo';        // 项目备忘 tab 下的二级子 tab：'memo'(项目备忘) | 'schedule'(项目工期)
  let memoMembers = [];        // 当前项目成员列表（来自 GET /records 的 members）
  let memoPendingProjectId = null;  // 从「共享给我的备忘」跳回原帖：待进入的项目
  let memoPendingRecordId = null;   // 从「共享给我的备忘」跳回原帖：待定位的记录

  // 重绘「图片 / 文件」预览（模块级，供删除按钮调用）
  function memoRenderPreviews() {
    UI.renderPhotoGrid(document.getElementById('mc-photo-grid'), document.getElementById('mc-photos'), memoComposePhotos);
    const fg = document.getElementById('mc-file-list');
    if (fg) {
      fg.innerHTML = memoComposeFiles.map((f, i) => `<span class="att-item">📎 ${esc(f.name || '附件')} <span class="att-x" onclick="Pages._memoDelFile(${i})">✕</span></span>`).join('');
      if (memoComposeFiles.length === 0) fg.innerHTML = '<span class="att-add" onclick="document.getElementById(\'mc-files\').click()">＋ 添加附件</span>';
    }
  }

  async function renderMemo(body) {
    if (memoSub === 'schedule') return renderSchedule(body);
    if (!memoPid) return renderMemoProjects(body);
    return renderMemoDetail(body);
  }

  // 项目工期（20260801 从「质量库」tab 迁移到「项目备忘」tab 下，作为同级子 tab）
  async function renderSchedule(body) {
    const canManage = App.caps.canManage;
    // 纯专家（role='expert'）无权限查看项目工期文档（O4）；游客（只读）同样不开放（P6）
    const isPureExpert = App.user && App.user.role === 'expert';
    if (isPureExpert || App.caps.isGuest) {
      body.innerHTML = '<div class="empty"><div class="ei">🔒</div><div class="et">项目工期文档仅对设计人员与管理者开放</div></div>';
      return;
    }
    const owners = await API.get('/api/schedule/owners');
    if (canManage) {
      // 管理者：看全部 18 人 + 搜索
      body.innerHTML = `<div class="sch-search"><input class="input" id="sch-kw" placeholder="搜索设计师姓名…"></div>
        <p class="text-muted" style="font-size:var(--fs-t5);margin:8px 0 12px">点开即看该设计师腾讯文档的实时内容（他们随时在改）</p>
        <div class="doc-grid" id="sch-grid"></div>`;
      paintOwnerGrid(owners, App.user.realName);
      const kwEl = document.getElementById('sch-kw');
      if (kwEl) kwEl.oninput = (e) => {
        const kw = e.target.value.trim();
        const list = kw ? owners.filter(o => o.owner.includes(kw)) : owners;
        paintOwnerGrid(list, App.user.realName);
      };
    } else if (owners.length) {
      // 设计师：仅看自己的（服务端已只返回本人）
      const mine = owners[0];
      const card = mine.docUrl
        ? `<a class="doc-card mine" href="${mine.docUrl}" target="_blank" rel="noopener noreferrer">
            <div class="doc-owner">${esc(mine.owner)}<span class="badge badge-mine">我的</span></div>
            <div class="doc-url">📄 腾讯文档 · 建筑专业项目工期</div>
            ${docUpdatedLine(mine)}
            <div class="doc-open">点击打开实时文档（可缩放、修改） →</div>
          </a>`
        : `<div class="doc-card mine empty-card"><div class="doc-owner">${esc(mine.owner)}<span class="badge badge-mine">我的</span></div><div class="doc-url">📄 腾讯文档 · 建筑专业项目工期</div>${docUpdatedLine(mine)}<div class="doc-open text-muted">链接待补充（联系管理员配置）</div></div>`;
      body.innerHTML = card + `<p class="text-muted" style="font-size:var(--fs-t5);margin:12px 0">数据实时来自你在腾讯文档维护的 Excel 项目表，修改请直接在该文档里操作。</p>`;
    } else {
      body.innerHTML = '<div class="empty"><div class="ei">📄</div><div class="et">未找到你的项目工期文档</div><div class="es">确认你已关联对应项目</div></div>';
    }
  }

  function personName(id) {
    if (memoPersonMap[id]) return memoPersonMap[id];
    const u = (memoPersonnel || []).find(x => x.id === id);
    return u ? u.real_name : ('#' + id);
  }

  // 项目列表视图
  async function renderMemoProjects(body) {
    body.innerHTML = `
      <div class="sch-search"><input class="input" id="memo-kw" placeholder="搜索项目名 / 编号 / 地区…"></div>
      <div class="row-btns" style="margin:8px 0 12px">
        ${App.caps.isGuest ? '' : `<button class="btn btn-memo btn-primary" onclick="Pages.memoOpenProjectModal()">＋ 开立 / 进入项目</button>`}
      </div>
      <div id="memo-list"><div class="empty"><div class="spinner" style="margin:0 auto"></div></div></div>`;
    const isSuperAdmin = App.user && (App.user.username === 'superadmin');
    const load = async (kw) => {
      const el = document.getElementById('memo-list');
      if (!el) return;
      try {
        const list = await API.get('/api/memos/projects' + (kw ? ('?kw=' + encodeURIComponent(kw)) : ''));
        el.innerHTML = list.length ? list.map(p => {
          const names = (p.contributor_names || '').split(',').filter(Boolean);
          return `
          <div class="lib-item" onclick="Pages.memoEnter(${p.id})">
            <div class="li-head"><div class="li-title">📁 ${esc(p.name)}</div><span class="tag">${p.record_count} 条</span></div>
            <div class="li-meta">
              ${p.region ? `<span>📍 ${esc(p.region)}</span>` : ''}
              ${p.code ? `<span>🔖 ${esc(p.code)}</span>` : ''}
              <span>👤 ${esc(p.opened_by_name || '')} 开立</span>
              ${p.last_at ? `<span>🕐 ${UI.relTime(p.last_at)}</span>` : '<span class="text-muted">暂无记录</span>'}
            </div>
            ${names.length ? `<div class="li-meta"><span class="tag tag-mine">👥 ${p.contributor_count} 人参与</span><span class="text-muted">${esc(names.join('、'))}</span></div>` : ''}
            ${isSuperAdmin ? `<div class="row-btns mt8" onclick="event.stopPropagation()"><button class="btn btn-sm btn-del" onclick="Pages.memoDeleteProject(${p.id})">删除项目</button></div>` : ''}
          </div>`;
        }).join('') : '<div class="empty"><div class="ei">📨</div><div class="et">还没有项目信息传递</div>' + (App.caps.isGuest ? '' : '<div class="es">点上方「＋开立 / 进入项目」创建第一个</div><div class="ea"><button class="btn btn-sm btn-primary" onclick="Pages.memoOpenProjectModal()">＋开立</button></div>') + '</div>';
      } catch (e) { el.innerHTML = '<div class="load-fail"><div class="lf-t">加载失败：' + esc(e.message) + '</div><button class="btn btn-sm btn-gray lf-a" onclick="Pages.memo()">重试</button></div>'; }
    };
    await load('');
    const kwEl = document.getElementById('memo-kw');
    if (kwEl) kwEl.oninput = (e) => load(e.target.value.trim());
  }

  // 项目详情（参与记录人名单 + 我的草稿 + 时间线）
  async function renderMemoDetail(body) {
    body.innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';
    let data;
    try { data = await API.get('/api/memos/projects/' + memoPid + '/records'); }
    catch (e) { body.innerHTML = '<div class="load-fail"><div class="lf-t">加载失败：' + esc(e.message) + '</div><button class="btn btn-sm btn-gray lf-a" onclick="Pages.memoEnter(' + memoPid + ')">重试</button></div>'; return; }
    const p = data.project || {};
    const contributors = data.contributors || [];
    const members = data.members || [];
    const records = data.records || [];
    memoProject = p;
    memoRecords = records;
    memoMembers = members;
    const drafts = records.filter(r => r.isDraft);
    const published = records.filter(r => !r.isDraft);
    body.innerHTML = `
      <div class="row-btns" style="margin-bottom:8px">
        <button class="btn btn-memo btn-gray" onclick="Pages.memoBack()">← 返回项目列表</button>
        ${App.caps.isGuest ? '' : `<button class="btn btn-memo btn-primary" onclick="Pages.memoCompose()">＋ 记录一条</button>`}
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="card-title">${esc(p.name || '')}</div>
        <div class="text-muted">
          ${p.region ? `📍 ${esc(p.region)} · ` : ''}${p.code ? `🔖 ${esc(p.code)} · ` : ''}👤 ${esc(p.opened_by_name || '')} 开立
        </div>
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="card-sub" style="display:flex;align-items:center;justify-content:space-between">👥 信息沟通人（${members.length} 人 · 名单全员可见 · 可看全部记录）
          ${p.opened_by === (App.user && App.user.id) ? `<button class="btn btn-sm btn-outline" onclick="Pages.memoManageMembers()">管理</button>` : ''}
        </div>
        ${members.length ? members.map(m => `<div class="li-meta" style="margin:2px 0"><span>👤 ${esc(m.real_name || '')}</span>${m.invited_by_name ? `<span class="text-muted">由 ${esc(m.invited_by_name)} 邀请</span>` : ''}<span class="text-muted">🕐 ${UI.relTime(m.joined_at)}</span></div>`).join('') : '<div class="text-muted">暂无信息沟通人</div>'}
      </div>
      ${drafts.length ? `
        <div class="card-sub mt8">📝 我的草稿（仅自己可见，可再次修改 / 发布）</div>
        ${drafts.map(memoRecordHtml).join('')}
      ` : ''}
      <div class="card-sub mt8">📜 发布记录（可逐级回复/追加，形成楼中楼）</div>
      <div id="memo-timeline">
        ${published.length ? memoThreadHtml(buildMemoTree(published), 0) : '<div class="empty"><div class="ei">📝</div><div class="et">还没有发布记录</div>' + (App.caps.isGuest ? '' : '<div class="es">点上方「＋记录一条」开始</div><div class="ea"><button class="btn btn-sm btn-primary" onclick="Pages.memoCompose()">＋记录一条</button></div>') + '</div>'}
      </div>`;
  }

  // 单条记录渲染（区分：草稿 / 可见发布 / 锁定占位）
  function memoRecordHtml(r) {
    if (r.locked) {
      return `
      <div class="lib-item" id="memo-rec-${r.id}" style="cursor:default;opacity:.92">
        <div class="li-head"><div class="li-title">🔒 ${esc(r.author_name || '')}</div><span class="tag">仅参与者可见</span></div>
        <div class="li-meta"><span>🕐 ${UI.relTime(r.published_at || r.created_at)}</span></div>
      </div>`;
    }
    const viewers = Array.isArray(r.viewers) ? r.viewers : [];
    const viewerNames = viewers.map(personName).filter(Boolean);
    return `
      <div class="lib-item" id="memo-rec-${r.id}" style="cursor:pointer" onclick="Pages.memoRecordDetail(${r.id})">
        <div class="li-head">
          <div class="li-title">${r.isDraft ? '📝 草稿' : '✅'} ${esc(r.author_name || '')}</div>
          ${r.isDraft ? '<span class="tag tag-mine">草稿</span>' : ''}
        </div>
        ${r.title ? `<div class="li-desc" style="font-weight:600">${esc(r.title)}</div>` : ''}
        <div class="li-meta">
          <span>🕐 ${UI.relTime(r.published_at || r.created_at)}</span>
          ${r.location ? `<span>📍 ${esc(r.location)}</span>` : ''}
          ${r.scenario ? `<span>🎬 ${esc(r.scenario)}</span>` : ''}
        </div>
        ${r.content ? `<div class="li-desc">${esc(r.content)}</div>` : ''}
        ${(r.photos && r.photos.length) ? `<div onclick="event.stopPropagation()">${UI.photoGrid(r.photos)}</div>` : ''}
        ${(r.attachments && r.attachments.length) ? `<div onclick="event.stopPropagation()">${UI.attChips(r.attachments)}</div>` : ''}
        ${viewerNames.length ? `<div class="li-meta"><span class="text-muted">🔓 额外共享：${esc(viewerNames.join('、'))}</span></div>` : ''}
        ${!r.isDraft && r.ima_media_id ? `<div class="li-meta mt8" onclick="event.stopPropagation()">${UI.imaTag(['SHARE-知识库', (r.projectName || '项目信息传递')], r.ima_url || '')}</div>` : ''}
        ${r.canEdit || r.canDelete || !r.isDraft ? `<div class="row-btns mt8" onclick="event.stopPropagation()">
          ${r.canEdit && r.isDraft ? `<button class="btn btn-sm btn-outline" onclick="Pages.memoCompose(${r.id})">继续修改</button>` : ''}
          ${!r.isDraft && r.canConvert ? `<button class="btn btn-sm btn-outline" onclick="Pages.memoConvert(${r.id})">转为发现问题</button>` : ''}
          ${(!r.isDraft && !r.locked) ? `<button class="btn btn-sm btn-outline" onclick="Pages.memoReply(${r.id})">💬 回复/追加</button>` : ''}
          ${r.canDelete ? `<button class="btn btn-sm btn-outline btn-del" onclick="Pages.memoDelete(${r.id})">删除</button>` : ''}
        </div>` : ''}
      </div>`;
  }

  // 将扁平记录列表（含 parent_id）构建为楼中楼树。找不到父节点的统一视为顶层。
  function buildMemoTree(records) {
    const nodes = records.map(r => Object.assign({}, r, { children: [] }));
    const map = new Map(nodes.map(n => [n.id, n]));
    const roots = [];
    nodes.forEach(n => {
      if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id).children.push(n);
      else roots.push(n);
    });
    return roots;
  }

  // 递归渲染楼中楼：每层向右缩进并加左侧引线，区分层级。
  function memoThreadHtml(nodes, depth) {
    if (!nodes || !nodes.length) return '';
    return nodes.map(n => `
      <div class="memo-thread" style="margin-left:${depth ? 14 : 0}px;border-left:${depth ? '2px solid #e3e8ef' : 'none'};padding-left:${depth ? 10 : 0}px">
        ${memoRecordHtml(n)}
        ${n.children && n.children.length ? memoThreadHtml(n.children, depth + 1) : ''}
      </div>`).join('');
  }

  Pages.memoEnter = (id) => { location.hash = '#/memo/' + id; };
  // 旧项目备忘的返回：回旧项目列表（#/memo/legacy），不要跳到已被改造为质量专题的 #/memo。
  Pages.memoBack = () => { location.hash = '#/memo/legacy'; };

  // 开立 / 进入项目（name 全局唯一，同名自动归并）；可同时邀请信息沟通人
  Pages.memoOpenProjectModal = async () => {
    if (!memoPersonnel.length) { try { const list = await API.get('/api/memos/personnel'); memoPersonnel = list || []; memoPersonnel.forEach(u => { memoPersonMap[u.id] = u.real_name; }); } catch (e) {} }
    const me = App.user || {};
    const others = (memoPersonnel || []).filter(u => u.id !== me.id && u.role !== 'admin' && u.role !== 'chief_engineer');
    const partOpts = others.map(u =>
      `<label class="exp-item"><input type="checkbox" class="mp-part" value="${u.id}"> ${esc(u.real_name)}</label>`
    ).join('');
    UI.modal('开立 / 进入项目', `
      <div class="field"><label>项目名称（全院唯一，同名自动进入已开项目）</label><input class="input" id="mp-name" placeholder="例如：XX变电站新建工程"></div>
      <div class="field"><label>项目编号（选填）</label><input class="input" id="mp-code" placeholder="选填"></div>
      <div class="field"><label>地区（选填）</label><input class="input" id="mp-region" placeholder="选填"></div>
      <div class="field"><label>邀请信息沟通人（选填；被邀请人可看本项目全部记录、也可记录）</label>
        <div class="drop-list exp-list" id="mp-part-list" style="max-height:180px;overflow:auto">${partOpts || '<div class="text-muted">暂无可邀请人员</div>'}</div>
      </div>
      <button class="btn btn-block" id="mp-submit">进入项目</button>
    `, (mask, close) => {
      mask.querySelector('#mp-submit').onclick = async () => {
        const name = mask.querySelector('#mp-name').value.trim();
        if (!name) return UI.toast('请填写项目名称');
        const code = mask.querySelector('#mp-code').value.trim();
        const region = mask.querySelector('#mp-region').value.trim();
        const participants = Array.from(mask.querySelectorAll('.mp-part:checked')).map(c => Number(c.value));
        try {
          UI.loading(true);
          const r = await API.post('/api/memos/projects', { name, code, region, participants });
          close();
          if (r.merged) UI.toast('已进入同名项目（自动归并）');
          location.hash = '#/memo/' + r.project.id;
        } catch (e) { UI.toast(e.message); }
        finally { UI.loading(false); }
      };
    });
  };

  // 记录 / 编辑 一条：标题 / 地点 / 场景 / 重点信息 / 图片 / 文件 / 邀请参与人 / 存草稿·发布
  Pages.memoCompose = async (id) => {
    if (!memoPid && !id) return;
    const editing = id != null;
    const r = editing ? (memoRecords || []).find(x => x.id === id) : null;
    const isDraft = r ? !!r.isDraft : false;
    memoComposePhotos = r ? (r.photos || []).slice() : [];   // 图片 url 字符串数组
    memoComposeFiles = r ? (r.attachments || []).slice() : []; // 附件 {url,name,size} 数组
    if (!memoPersonnel.length) { try { const list = await API.get('/api/memos/personnel'); memoPersonnel = list || []; memoPersonnel.forEach(u => { memoPersonMap[u.id] = u.real_name; }); } catch (e) {} }
    const me = App.user || {};
    const others = (memoPersonnel || []).filter(u => u.id !== me.id && u.role !== 'admin' && u.role !== 'chief_engineer');

    const existingMemberIds = new Set((memoMembers || []).map(m => m.user_id));
    const inviteCandidates = others.filter(u => !existingMemberIds.has(u.id));
    const inviteOpts = inviteCandidates.map(u =>
      `<label class="exp-item"><input type="checkbox" value="${u.id}"> ${esc(u.real_name)}</label>`
    ).join('');

    UI.modal(editing ? (isDraft ? '继续修改草稿' : '编辑记录') : ('记录一条 · ' + (memoProject ? memoProject.name : '')), `
      <div class="field"><label>① 标题<span class="req">*</span></label><input class="input" id="mc-title" value="${esc(r ? (r.title || '') : '')}" placeholder="一句话概括这条备忘"></div>
      <div class="field"><label>② 地点</label><input class="input" id="mc-location" value="${esc(r ? (r.location || '') : '')}" placeholder="如：现场 / 会议室 / 某地块"></div>
      <div class="field"><label>③ 场景</label><input class="input" id="mc-scenario" value="${esc(r ? (r.scenario || '') : '')}" placeholder="如：踏勘 / 评审 / 例会 / 交底"></div>
      <div class="field"><label>④ 重点信息传递<span class="req">*</span></label><textarea class="textarea" id="mc-content" rows="4" placeholder="记录你在这个项目得到的关键信息…">${esc(r ? (r.content || '') : '')}</textarea></div>
      <div class="field"><label>⑤ 图片（拍摄或相册，可选；详情页直接展示，最多 9 张）</label>
        <div class="photo-grid" id="mc-photo-grid"></div>
        <input type="file" id="mc-photos" accept="image/*" multiple class="sr-only-file">
      </div>
      <div class="field"><label>⑥ 附件（文档 / 表格等，可选；点开可下载）</label>
        <input type="file" id="mc-files" multiple class="sr-only-file">
        <div id="mc-file-list" class="att-list"></div>
      </div>
      <div class="field"><label>⑦ 邀请信息沟通人（选填；被邀请人可看本项目全部记录、也可记录。已是项目成员的不出现）</label>
        <div class="drop-search"><input class="input" id="mc-invite-kw" placeholder="搜索人员…"></div>
        <div class="drop-list exp-list" id="mc-invite-list" style="max-height:160px;overflow:auto">${inviteOpts || '<div class="text-muted">信息沟通人已包含全部可选人员</div>'}</div>
      </div>
      <div class="row-btns mt8">
        ${editing && isDraft ? `<button class="btn btn-gray" id="mc-draft">更新草稿</button><button class="btn btn-primary" id="mc-pub">发布</button>` : ''}
        ${editing && !isDraft ? `<button class="btn btn-primary" id="mc-save">保存</button>` : ''}
        ${!editing ? `<button class="btn btn-gray" id="mc-draft">存为备忘草稿</button><button class="btn btn-primary" id="mc-pub">发布</button>` : ''}
      </div>
    `, (mask, close) => {
      memoRenderPreviews();
      const ikw = mask.querySelector('#mc-invite-kw');
      if (ikw) ikw.oninput = (e) => {
        const v = e.target.value.trim();
        mask.querySelectorAll('#mc-invite-list label').forEach(l => { l.style.display = (!v || l.textContent.includes(v)) ? '' : 'none'; });
      };
      mask.querySelector('#mc-photos').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); memoComposePhotos = memoComposePhotos.concat(resp.urls || []); memoRenderPreviews(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      mask.querySelector('#mc-files').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); memoComposeFiles = memoComposeFiles.concat(resp.files || []); memoRenderPreviews(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      const collectInvitees = () => Array.from(mask.querySelectorAll('#mc-invite-list input:checked')).map(c => Number(c.value));
      const submit = async (status) => {
        const title = mask.querySelector('#mc-title').value.trim();
        const content = mask.querySelector('#mc-content').value.trim();
        const location = mask.querySelector('#mc-location').value.trim();
        const scenario = mask.querySelector('#mc-scenario').value.trim();
        if (!title) return UI.toast('请填写标题');
        const payload = { title, location, scenario, content, photos: memoComposePhotos, attachments: memoComposeFiles, viewers: [], invitees: collectInvitees(), status };
        if (status === 'published' && !content && !memoComposePhotos.length && !memoComposeFiles.length) return UI.toast('发布需至少填写重点信息或上传图片/文件');
        try {
          UI.loading(true);
          if (editing) await API.put('/api/memos/records/' + id, payload);
          else await API.post('/api/memos/projects/' + memoPid + '/records', payload);
          close(); UI.toast(status === 'published' ? '已发布' : '已存为草稿');
          renderMemo(memoBodyEl);
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
      const draftBtn = mask.querySelector('#mc-draft');
      if (draftBtn) draftBtn.onclick = () => submit('draft');
      const pubBtn = mask.querySelector('#mc-pub');
      if (pubBtn) pubBtn.onclick = () => submit('published');
      const saveBtn = mask.querySelector('#mc-save');
      if (saveBtn) saveBtn.onclick = () => submit('published');
    });
  };
  Pages._memoDelFile = (i) => { memoComposeFiles.splice(i, 1); memoRenderPreviews(); };

  // 信息回复/追加：在原记录（任意可见层级）下追一条回复。支持文字+图片+文件。提交后整页刷新重排楼中楼。
  Pages.memoReply = async (parentId) => {
    const parent = (memoRecords || []).find(x => x.id === parentId);
    const photos = [];
    const files = [];
    const renderPrev = () => {
      UI.renderPhotoGrid(document.getElementById('mr-photo-grid'), document.getElementById('mr-photos'), photos);
      const list = document.getElementById('mr-file-list');
      if (list) {
        list.innerHTML = files.map((f, i) => `<div class="att-chip">📎 ${esc(f.name || f.url)} <span class="att-x" onclick="Pages._memoReplyDelFile(${i})">×</span></div>`).join('');
        if (!files.length) list.innerHTML = '<span class="att-add" onclick="document.getElementById(\'mr-files\').click()">＋ 添加附件</span>';
      }
    };
    UI.modal('回复 / 追加信息', `
      <div class="text-muted" style="margin-bottom:6px">回复 ${esc(parent ? parent.author_name : '')} 的记录${parent && parent.title ? '：' + esc(parent.title) : ''}</div>
      <div class="field"><label>补充信息 / 你的回复<span class="req">*</span></label><textarea class="textarea" id="mr-content" rows="4" placeholder="输入你要补充或回复的信息…"></textarea></div>
      <div class="field"><label>图片（拍摄或相册，可选；最多 9 张）</label>
        <div class="photo-grid" id="mr-photo-grid"></div>
        <input type="file" id="mr-photos" accept="image/*" multiple class="sr-only-file">
      </div>
      <div class="field"><label>附件（文档 / 表格等，可选）</label>
        <input type="file" id="mr-files" multiple class="sr-only-file">
        <div id="mr-file-list" class="att-list"></div>
      </div>
      <button class="btn btn-block" id="mr-sub">提交</button>
    `, (mask, close) => {
      renderPrev();  // 初始渲染：显示空的「＋拍照/相册」虚线框
      mask.querySelector('#mr-photos').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); photos.push(...(resp.urls || [])); renderPrev(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      mask.querySelector('#mr-files').onchange = async (e) => {
        const fs = [...e.target.files]; if (!fs.length) return;
        try { UI.loading(true); const resp = await API.upload(fs); files.push(...(resp.files || [])); renderPrev(); }
        catch (err) { UI.toast(err.message); } finally { UI.loading(false); e.target.value = ''; }
      };
      mask.querySelector('#mr-sub').onclick = async () => {
        const content = mask.querySelector('#mr-content').value.trim();
        if (!content && !photos.length && !files.length) return UI.toast('请填写回复内容或上传图片/文件');
        try {
          UI.loading(true);
          await API.post('/api/memos/records/' + parentId + '/reply', { content, photos, attachments: files });
          close(); UI.toast('已回复'); renderMemo(memoBodyEl);
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  };
  Pages._memoReplyDelFile = (i) => { files.splice(i, 1); document.getElementById('mr-file-list') && (document.getElementById('mr-file-list').innerHTML = files.map((f, k) => `<div class="att-chip">📎 ${esc(f.name || f.url)} <span class="att-x" onclick="Pages._memoReplyDelFile(${k})">×</span></div>`).join('')); };

  // 删除记录（仅超级管理员可删；IMA 存档保留）
  Pages.memoDelete = async (id) => {
    if (!(await UI.confirm('确定删除这条记录吗？（已同步 IMA 的存档会保留）'))) return;
    (async () => {
      try {
        UI.loading(true);
        await API.del('/api/memos/records/' + id);
        UI.toast('已删除');
        renderMemo(memoBodyEl);
      } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
    })();
  };

  // 删除整个项目（仅超级管理员可执行）
  Pages.memoDeleteProject = async (id) => {
    if (!(await UI.confirm('确定删除整个项目吗？该项目下的全部记录与成员将一并删除（已同步 IMA 的存档保留）。此操作仅超级管理员可执行。'))) return;
    (async () => {
      try {
        UI.loading(true);
        await API.del('/api/memos/projects/' + id);
        UI.toast('已删除项目');
        renderMemoProjects(memoBodyEl);
      } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
    })();
  };

  // 点击记录卡片 → 弹窗看详情（相关人可见即可看；照片/文件可点开放大）
  Pages.memoRecordDetail = (id) => {
    const r = (memoRecords || []).find(x => x.id === id);
    if (!r || r.locked) return;
    const viewers = Array.isArray(r.viewers) ? r.viewers : [];
    const viewerNames = viewers.map(personName).filter(Boolean);
    const photosHtml = (r.photos && r.photos.length) ? UI.photoGrid(r.photos) : '';
    const attHtml = (r.attachments && r.attachments.length) ? UI.attChips(r.attachments) : '';
    // 详情正文不得沿用列表用的 .li-desc（该类带 -webkit-line-clamp:2，会把长文裁成 2 行 → “看不全”）。
    // 故此处改用无截断的普通 div；同时把正文包进独立的内部滚动容器（max-height + overflow-y:auto），
    // 让超长正文在微信 WebView 里也能可靠滚动，而操作按钮（footer）留在滚动区之外始终可见。
    UI.modal('📄 记录详情', `
      <div class="memo-detail-body" style="max-height:58vh;overflow-y:auto;-webkit-overflow-scrolling:touch">
        <div class="card-sub" style="margin-bottom:6px">✅ ${esc(r.author_name || '')} · 🕐 ${UI.relTime(r.published_at || r.created_at)}</div>
        ${r.title ? `<div style="font-weight:700;font-size:var(--fs-t4);margin-bottom:6px;white-space:pre-wrap;word-break:break-word">${esc(r.title)}</div>` : ''}
        <div class="li-meta" style="margin-bottom:8px">
          ${r.location ? `<span>📍 ${esc(r.location)}</span>` : ''}
          ${r.scenario ? `<span>🎬 ${esc(r.scenario)}</span>` : ''}
        </div>
        ${r.content ? `<div style="white-space:pre-wrap;line-height:1.6;word-break:break-word">${esc(r.content)}</div>` : ''}
        ${photosHtml ? `<div style="margin-top:10px">${photosHtml}</div>` : ''}
        ${attHtml ? `<div style="margin-top:8px">${attHtml}</div>` : ''}
        ${viewerNames.length ? `<div class="li-meta" style="margin-top:8px"><span class="text-muted">🔓 额外共享：${esc(viewerNames.join('、'))}</span></div>` : ''}
        ${!r.isDraft && r.ima_media_id ? `<div class="li-meta mt8">${UI.imaTag(['SHARE-知识库', (r.projectName || '项目信息传递')], r.ima_url || '')}</div>` : ''}
      </div>
    `, (mask, close) => {
      const box = mask.querySelector('.modal');
      const footer = document.createElement('div');
      footer.className = 'row-btns mt8';
      footer.style.padding = '12px 16px';
      if (r.canEdit && r.isDraft) { const b = document.createElement('button'); b.className = 'btn btn-sm btn-outline'; b.textContent = '继续修改'; b.onclick = () => { close(); Pages.memoCompose(r.id); }; footer.appendChild(b); }
      if (!r.isDraft && r.canConvert) { const b = document.createElement('button'); b.className = 'btn btn-sm btn-outline'; b.textContent = '转为发现问题'; b.onclick = () => { close(); Pages.memoConvert(r.id); }; footer.appendChild(b); }
      if (r.canDelete) { const b = document.createElement('button'); b.className = 'btn btn-sm btn-outline btn-del'; b.textContent = '删除'; b.onclick = () => { close(); Pages.memoDelete(r.id); }; footer.appendChild(b); }
      const cb = document.createElement('button'); cb.className = 'btn btn-sm btn-gray'; cb.textContent = '关闭'; cb.onclick = () => close(); footer.appendChild(cb);
      box.appendChild(footer);
    });
  };

  // 开立人管理「信息沟通人」：增删名单（受保护成员不可移除；系统管理员不进入名单）
  Pages.memoManageMembers = async () => {
    if (!memoProject || memoProject.opened_by !== (App.user && App.user.id)) { UI.toast('仅项目开立人本人可管理信息沟通人'); return; }
    const me = App.user || {};
    // 受保护成员（开立人 + 已发布记录作者）—— 服务端权威，前端仅展示
    let protArr = [];
    try { const d = await API.get('/api/memos/projects/' + memoProject.id + '/records'); protArr = d.protectedIds || []; memoMembers = d.members || memoMembers; } catch (e) {}
    const protSet = new Set(protArr);
    if (!memoPersonnel.length) { try { const list = await API.get('/api/memos/personnel'); memoPersonnel = list || []; memoPersonnel.forEach(u => { memoPersonMap[u.id] = u.real_name; }); } catch (e) {} }
    const currentMembers = memoMembers || [];
    const memberIds = new Set(currentMembers.map(m => m.user_id));
    const addCandidates = (memoPersonnel || []).filter(u => !memberIds.has(u.id) && u.role !== 'admin' && u.id !== me.id && u.role !== 'chief_engineer');
    const currentHtml = currentMembers.map(m => {
      const isProt = protSet.has(m.user_id);
      return `<label class="exp-item" style="${isProt ? 'opacity:.7' : ''}">
        <input type="checkbox" class="mm-keep" value="${m.user_id}" ${isProt ? 'checked disabled' : 'checked'}>
        ${esc(m.real_name || '')} ${isProt ? '<span class="text-muted">（受保护·不可移除）</span>' : (m.invited_by_name ? '<span class="text-muted">由 ' + esc(m.invited_by_name) + ' 邀请</span>' : '<span class="text-muted">开立人</span>')}
      </label>`;
    }).join('') || '<div class="text-muted">暂无信息沟通人</div>';
    const addHtml = addCandidates.map(u => `<label class="exp-item"><input type="checkbox" class="mm-add" value="${u.id}"> ${esc(u.real_name)}</label>`).join('') || '<div class="text-muted">没有可新增的人员</div>';
    UI.modal('管理信息沟通人', `
      <p class="text-muted" style="font-size:var(--fs-t5);margin:0 0 8px">勾选 = 保留；取消勾选 = 移除（受保护成员不可移除）。下方可新增人员。</p>
      <div class="card-sub">当前信息沟通人</div>
      <div class="drop-list exp-list" id="mm-current" style="max-height:200px;overflow:auto">${currentHtml}</div>
      <div class="card-sub mt8">新增人员</div>
      <div class="drop-search"><input class="input" id="mm-add-kw" placeholder="搜索人员…"></div>
      <div class="drop-list exp-list" id="mm-add" style="max-height:160px;overflow:auto">${addHtml}</div>
      <button class="btn btn-block" id="mm-submit">保存</button>
    `, (mask, close) => {
      const kw = mask.querySelector('#mm-add-kw');
      if (kw) kw.oninput = (e) => { const v = e.target.value.trim(); mask.querySelectorAll('#mm-add label').forEach(l => { l.style.display = (!v || l.textContent.includes(v)) ? '' : 'none'; }); };
      mask.querySelector('#mm-submit').onclick = async () => {
        const keepIds = Array.from(mask.querySelectorAll('.mm-keep:checked')).map(c => Number(c.value));
        const addIds = Array.from(mask.querySelectorAll('.mm-add:checked')).map(c => Number(c.value));
        const userIds = [...new Set([...keepIds, ...addIds])];
        try {
          UI.loading(true);
          const r = await API.put('/api/memos/projects/' + memoProject.id + '/members', { userIds });
          memoMembers = r.members || memoMembers;
          close();
          UI.toast('信息沟通人已更新');
          renderMemo(memoBodyEl);
        } catch (e) { UI.toast(e.message); }
        finally { UI.loading(false); }
      };
    });
  };

  // 一键转为「发现问题」：写入「发现问题」草稿箱（仅记录人本人可转；原备忘不动）
  Pages.memoConvert = async (id) => {
    if (!(await UI.confirm('将这条记录转入你本人的「发现问题」草稿箱（原记录保持不变），由你补充后自行决定是否入库，确认？'))) return;
    (async () => {
      try {
        UI.loading(true);
        const r = await API.post('/api/memos/records/' + id + '/convert-to-problem', {});
        if (r.draftId != null) {
          const d = await API.get('/api/pdca/drafts/' + r.draftId);
          location.hash = '#/pdca';      // 切到「发现问题」tab
          Pages.pdcaCompose(d);          // 打开草稿箱，预填内容
          UI.toast(r.message || '已转入发现问题草稿箱');
        } else {
          location.hash = '#/pdca';
        }
      } catch (e) { UI.toast('转换失败：' + (e.message || e)); } finally { UI.loading(false); }
    })();
  };

  // 项目备忘 · 主 Tab 入口（20260911u 起置于 质量库 与 管理 之间；游客隐藏，未正式上线）
  // 渲染「项目信息传递」tab 外壳（顶栏 + 子 tab + 列表/详情容器），并拉取人员名单、渲染内容。
  // 抽出来供三种入口复用：① 提醒跳回原帖 ② 硬刷新/直访 #/memo/<id> 恢复详情 ③ 纯 #/memo 列表。
  async function memoRenderShell() {
    // 质量专题成为默认入口；旧项目备忘仅在旧深链中进入，绝不删除旧数据、旧路由或旧子 tab。
    // memoSub 三态：'topic'（质量专题）· 'schedule'（项目工期）· 'memo'（旧项目备忘，仅旧深链可达）
    const isTopic = memoSub === 'topic';
    const isSchedule = memoSub === 'schedule';
    const title = isTopic ? '质量专题' : (isSchedule ? '项目工期' : '项目信息传递');
    const showBack = isTopic ? topicId != null : memoPid != null;
    app().innerHTML = `${topbar(title, { back: showBack })}
      <div class="page">
        ${Pages.circleTabs([
          { icon: 'memo', label: isTopic ? '质量专题' : '项目信息传递', active: !isSchedule, sub: 'topic', onclick: "Pages.memoSetSub('topic')" },
          { icon: 'schedule', label: '项目工期', active: isSchedule, sub: 'schedule', onclick: "Pages.memoSetSub('schedule')" },
        ], 'memo-tabs')}
        <div id="memo-body"></div>
      </div>${Pages.tabbar('memo')}`;
    memoBodyEl = document.getElementById('memo-body');
    if (isTopic) return renderTopics(memoBodyEl);
    try { const list = await API.get('/api/memos/personnel'); memoPersonnel = list || []; memoPersonnel.forEach(u => { memoPersonMap[u.id] = u.real_name; }); } catch (e) {}
    await renderMemo(memoBodyEl);
  }

  // ── 质量专题（新入口；旧 #/memo/<数字> 深链仍保留原项目备忘）────────────
  let topicId = null;
  let topicData = null;
  // 「关联质量内容」区专业筛选当前值（模块级，避免重渲染后筛选被重置）
  let topicDivFilter = '__all__';
  let topicPhotos = [];
  let topicFiles = [];

  // 权限三层，与后端 qualityTopics.js 的 canAdminister / canContribute / canEditTopic 一一对应：
  //   建专题 = 超级管理员 + 院长/专总/室主任；改专题信息/发布下线 = 作者本人 + 超级管理员；
  //   置顶/归档/删除 = 仅超级管理员；填内容（发动态/关联）= 超级管理员 + 院长/专总/室主任；其余只读。
  // 专题管理权（前端镜像后端 canAdminister）：超级管理员 + 副院长×××（2026-10-10 裁定，仅限专题模块）
  function topicIsAdmin() { return !!(App.user && (App.user.username === 'superadmin' || App.user.username === 'shenxiangming' || App.user.realName === '×××')); }
  function topicCanContribute() {
    if (App.caps && App.caps.isGuest) return false;
    if (topicIsAdmin()) return true;
    const c = App.caps || {};
    return !!(c.canManage || c.canPublishDissem || c.canDeleteDissem);
  }
  // 旧调用点兼容：原 topicCanWrite 语义 = 填内容
  function topicCanWrite() { return topicCanContribute(); }
  function topicParseHash() {
    const m = String(location.hash || '').match(/^#\/memo\/topic\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function topicPhotoHtml() {
    return topicPhotos.length ? UI.photoGrid(topicPhotos) : '<span class="text-muted">未添加图片</span>';
  }
  function topicFileHtml() {
    return topicFiles.length ? topicFiles.map(f => `<span class="att-item">📎 ${esc(f.name || '附件')} <span class="att-x" onclick="Pages._topicDelFile(${topicFiles.indexOf(f)})">✕</span></span>`).join('') : '<span class="att-add" onclick="document.getElementById(\'topic-files\').click()">＋ 添加附件</span>';
  }
  function topicRenderForm(kind, data = {}, isEdit = false) {
    const isPost = kind === 'post';
    const postTypes = ['启动说明', '阶段进展', '问题案例', '整改措施', '活动报道', '成果发布', '阶段总结'];
    const curType = postTypes.indexOf(data.post_type) >= 0 ? data.post_type : '阶段进展';
    // 主题色默认：新建专题默认深蓝（保证有底色）；编辑态尊重已存值，空则保持"无色"
    const curColor = data.color || (isEdit ? '' : '#004B96');
    const mask = document.createElement('div'); mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal modal-sheet"><div class="modal-head"><div class="modal-title">${isPost ? (isEdit ? '编辑动态' : '发布专题动态') : (isEdit ? '编辑质量专题' : '新建质量专题')}</div><button type="button" class="modal-x" aria-label="关闭">×</button></div><div class="modal-body">
      ${isPost ? `<input class="input" id="topic-post-title" placeholder="动态标题（可选）" value="${esc(data.title || '')}"><select class="input" id="topic-post-type">${postTypes.map(t => `<option${t === curType ? ' selected' : ''}>${t}</option>`).join('')}</select>`
      : `<input class="input" id="topic-title" placeholder="专题标题" value="${esc(data.title || '')}"><input class="input" id="topic-code" placeholder="专题编号（可选）" value="${esc(data.code || '')}"><textarea class="input" id="topic-summary" rows="3" placeholder="专题简介 / 背景">${esc(data.summary || '')}</textarea>
        <div class="topic-color-row"><span class="tc-label">主题色</span><div class="tc-swatches">
          <span class="tc-swatch${!curColor ? ' selected' : ''}" data-c="">无色</span>
          ${['#004B96','#C80A50','#E8730C','#2E8B57','#6A4FB0','#0E9BB3','#D9A400'].map(c => `<span class="tc-swatch${String(curColor).toUpperCase()===c ? ' selected' : ''}" data-c="${c}" style="background:${c}"></span>`).join('')}
          <input class="input tc-custom" id="topic-color-custom" placeholder="自定义#RRGGBB" value="${curColor && !['#004B96','#C80A50','#E8730C','#2E8B57','#6A4FB0','#0E9BB3','#D9A400'].includes(String(curColor).toUpperCase()) ? esc(curColor) : ''}">
        </div><input type="hidden" id="topic-color" value="${esc(curColor)}"></div>`}
      ${isPost ? `<textarea class="input" id="topic-content" rows="7" placeholder="记录阶段进展、问题、措施或成果……">${esc(data.content || '')}</textarea>` : ''}
      <div class="topic-upload-row"><button type="button" class="btn btn-sm btn-outline" id="topic-photo-btn">添加图片</button><input id="topic-photos" class="sr-only-file" type="file" accept="image/*" multiple><button type="button" class="btn btn-sm btn-outline" id="topic-file-btn">添加附件</button><input id="topic-files" class="sr-only-file" type="file" multiple></div>
      <div id="topic-photo-grid" class="photo-grid mt8">${topicPhotoHtml()}</div><div id="topic-file-list" class="att-list">${topicFileHtml()}</div>
      <div class="row-btns mt12"><button class="btn btn-gray modal-cancel">取消</button>${isPost && !isEdit ? '<button class="btn btn-outline" id="topic-save-draft">存草稿</button>' : ''}<button class="btn btn-primary" id="topic-submit">${isPost ? (isEdit ? '保存' : '立即发布') : (isEdit ? '保存修改' : '创建专题')}</button></div>
      </div></div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    const xBtn = mask.querySelector('.modal-x'); if (xBtn) xBtn.onclick = close;
    const cancelBtn = mask.querySelector('.modal-cancel'); if (cancelBtn) cancelBtn.onclick = close;
    // 编辑态预填既有图片/附件
    if (isPost && data.photos && data.photos.length) topicPhotos = topicPhotos.concat(data.photos);
    if (isPost && data.attachments && data.attachments.length) topicFiles = topicFiles.concat(data.attachments);
    const refresh = () => { const p = mask.querySelector('#topic-photo-grid'); if (p) p.innerHTML = topicPhotoHtml(); const f = mask.querySelector('#topic-file-list'); if (f) f.innerHTML = topicFileHtml(); };
    refresh();
    // 主题色选择：预设色板 + 自定义十六进制，写入隐藏域 #topic-color
    const colorInput = mask.querySelector('#topic-color');
    const customColor = mask.querySelector('#topic-color-custom');
    const swatches = mask.querySelectorAll('.tc-swatch');
    const syncColor = (val) => { colorInput.value = val || ''; swatches.forEach(s => s.classList.toggle('selected', (s.getAttribute('data-c') || '') === (val || ''))); };
    swatches.forEach(s => { s.onclick = () => { if (customColor) customColor.value = ''; syncColor(s.getAttribute('data-c')); }; });
    if (customColor) customColor.oninput = () => { const v = customColor.value.trim(); if (/^#?[0-9a-fA-F]{6}$/.test(v)) { syncColor(v[0] === '#' ? v.toUpperCase() : '#' + v.toUpperCase()); } else if (!v) { syncColor(''); } };
    const upload = async (files, isPhoto) => { if (!files.length) return; if (files.some(f => f.size > 50 * 1024 * 1024)) { UI.toast('单个文件不能超过50MB'); return; } try { UI.loading(true); const r = await API.upload(files); if (isPhoto) topicPhotos.push(...(r.urls || [])); else topicFiles.push(...(r.files || [])); refresh(); } catch (e) { UI.toast(e.message || '上传失败'); } finally { UI.loading(false); } };
    mask.querySelector('#topic-photo-btn').onclick = () => mask.querySelector('#topic-photos').click(); mask.querySelector('#topic-file-btn').onclick = () => mask.querySelector('#topic-files').click();
    mask.querySelector('#topic-photos').onchange = e => { upload([...e.target.files], true); e.target.value = ''; }; mask.querySelector('#topic-files').onchange = e => { upload([...e.target.files], false); e.target.value = ''; };
    const submitPost = async (status) => {
      try {
        UI.loading(true);
        const b = { title: mask.querySelector('#topic-post-title').value, post_type: mask.querySelector('#topic-post-type').value, content: mask.querySelector('#topic-content').value, photos: topicPhotos, attachments: topicFiles, status };
        if (isEdit) { await API.put(`/api/quality-topics/${topicId}/posts/${data.id}`, b); close(); UI.toast('已保存'); }
        else { await API.post(`/api/quality-topics/${topicId}/posts`, b); close(); UI.toast(status === 'draft' ? '已存草稿（仅你与超级管理员可见）' : '动态已发布'); }
        await Pages.memoTopic(topicId);
      } catch (e) { UI.toast(e.message || '保存失败'); } finally { UI.loading(false); }
    };
    const submitBtn = mask.querySelector('#topic-submit');
    submitBtn.onclick = () => submitPost(isEdit ? (data.status === 'draft' ? 'draft' : 'published') : 'published');
    const draftBtn = mask.querySelector('#topic-save-draft');
    if (draftBtn) draftBtn.onclick = () => submitPost('draft');
    if (!isPost) {
      submitBtn.onclick = async () => {
        try {
          UI.loading(true);
          const b = { title: mask.querySelector('#topic-title').value, code: mask.querySelector('#topic-code').value, summary: mask.querySelector('#topic-summary').value, color: (mask.querySelector('#topic-color') || {}).value || '' };
          if (isEdit) { await API.put(`/api/quality-topics/${topicId}`, b); close(); UI.toast('已保存'); await Pages.memoTopic(topicId); }
          else { const r = await API.post('/api/quality-topics', b); close(); UI.toast('专题已创建（草稿）'); location.hash = '#/memo/topic/' + r.id; }
        } catch (e) { UI.toast(e.message || '保存失败'); } finally { UI.loading(false); }
      };
    }
  }
  Pages.topicEditPost = (postId) => {
    if (!topicCanContribute()) return UI.toast('当前账号仅可浏览');
    const p = (topicData && topicData.posts || []).find(x => x.id === postId);
    if (!p) return UI.toast('动态不存在');
    topicPhotos = []; topicFiles = [];
    topicRenderForm('post', p, true);
  };
  Pages.topicPostToggleDraft = async (postId) => {
    if (!topicCanContribute()) return UI.toast('当前账号仅可浏览');
    const p = (topicData && topicData.posts || []).find(x => x.id === postId);
    if (!p) return;
    const toDraft = p.status !== 'draft';
    if (toDraft && !(await UI.confirm('收回为草稿？全员将不再看到这条动态（超级管理员仍可见）。'))) return;
    try { UI.loading(true); await API.put(`/api/quality-topics/${topicId}/posts/${postId}`, { status: toDraft ? 'draft' : 'published' }); UI.toast(toDraft ? '已收回草稿' : '已发布'); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '操作失败'); } finally { UI.loading(false); }
  };
  Pages.topicDeletePost = async (postId) => {
    if (!topicCanContribute()) return UI.toast('当前账号仅可浏览');
    if (!(await UI.confirm('删除这条动态？删除后不可恢复。'))) return;
    try { UI.loading(true); await API.del(`/api/quality-topics/${topicId}/posts/${postId}`); UI.toast('已删除'); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '删除失败'); } finally { UI.loading(false); }
  };
  Pages.topicPin = async (postId, on) => {
    if (!topicIsAdmin()) return UI.toast('仅超级管理员可置顶动态');
    try { UI.loading(true); await API.put(`/api/quality-topics/${topicId}/posts/${postId}`, { is_pinned: on ? 1 : 0 }); UI.toast(on ? '已置顶' : '已取消置顶'); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '操作失败'); } finally { UI.loading(false); }
  };
  // 专题置顶（仅超级管理员）：置顶/取消，与动态置顶分开治理
  Pages.topicPinTopic = async (on) => {
    const t = topicData && topicData.topic; if (!t || !topicIsAdmin()) return UI.toast('仅超级管理员可置顶质量专题');
    try { UI.loading(true); await API.post(`/api/quality-topics/${topicId}/pin`, { pinned: on ? 1 : 0 }); UI.toast(on ? '专题已置顶' : '已取消专题置顶'); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '操作失败'); } finally { UI.loading(false); }
  };
  Pages._topicDelFile = i => { topicFiles.splice(i, 1); const f = document.getElementById('topic-file-list'); if (f) f.innerHTML = topicFileHtml(); };
  Pages.topicNew = () => { if (!topicCanContribute()) return UI.toast('仅超级管理员与院长/专总/室主任可新建质量专题'); topicPhotos = []; topicFiles = []; topicRenderForm('topic'); };
  Pages.topicEdit = () => { const t = topicData && topicData.topic; if (!t) return; if (!t.canEdit) return UI.toast('仅专题创建人或超级管理员可编辑专题'); topicPhotos = []; topicFiles = []; topicRenderForm('topic', t, true); };
  Pages.topicPost = () => { if (!topicCanContribute()) return UI.toast('当前账号仅可浏览'); topicPhotos = []; topicFiles = []; topicRenderForm('post'); };

  // 专题状态流转：草稿 → 进行中（上线全院可见）→ 归档（收起来）→ 可再恢复；删除仅超级管理员且二次确认
  Pages.topicSetStatus = async (status) => {
    const t = topicData && topicData.topic; if (!t || !t.canEdit) return UI.toast('仅专题创建人或超级管理员可变更专题状态');
    const tips = { active: '上线后全员可见，确定发布？', archived: '归档后专题从列表收起（内容仍保留），确定？', draft: '收回为草稿后仅超级管理员可见，确定？' };
    if (status !== 'deleted' && !(await UI.confirm(tips[status] || '确认？'))) return;
    try { UI.loading(true); await API.put(`/api/quality-topics/${topicId}`, { status }); UI.toast(status === 'active' ? '专题已上线' : (status === 'archived' ? '已归档' : '已收回草稿')); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '操作失败'); } finally { UI.loading(false); }
  };
  Pages.topicDelete = async () => {
    const t = topicData && topicData.topic; if (!t || !topicIsAdmin()) return UI.toast('仅超级管理员可删除专题');
    if (!(await UI.confirm(`确定删除专题「${t.title}」？其动态与关联将一并隐藏（数据仍保留在库中）。`))) return;
    try { UI.loading(true); await API.put(`/api/quality-topics/${topicId}`, { status: 'deleted' }); UI.toast('已删除'); location.hash = '#/memo'; }
    catch (e) { UI.toast(e.message || '删除失败'); } finally { UI.loading(false); }
  };
  Pages.topicOpen = id => { location.hash = '#/memo/topic/' + id; };
  Pages.topicBack = () => { location.hash = '#/memo'; };
  // 关联条目点击跳转：按类型打开对应的公告/宣贯/PDCA 详情；红花为引用「红花奖惩台账」，从本专题已加载数据弹明细（不重复发花、不改红花数据）
  Pages.topicOpenLinked = (type, id) => {
    if (type === 'announcement') return Pages.viewAnnouncement(id);
    if (type === 'dissem') return Pages.viewDissem(id);
    if (type === 'pdca') return Pages.pdcaDetail(id);
    if (type === 'flower') {
      const it = (topicData.items || []).find(x => x.target_type === 'flower' && x.target_id === Number(id));
      if (!it) return UI.toast('红花记录读取失败');
      return UI.modal('专题红花记录', `<div class="topic-flower-detail">
        <div class="tf-row"><span class="text-muted">对象</span><b>${esc(it.fl_name || '')}</b></div>
        <div class="tf-row"><span class="text-muted">数量</span><b style="color:${it.fl_delta > 0 ? '#c0392b' : '#27ae60'}">${it.fl_delta > 0 ? '+' : ''}${it.fl_delta} 朵小红花</b></div>
        <div class="tf-row"><span class="text-muted">原因</span><div class="tf-reason">${esc(it.fl_reason || '')}</div></div>
        <div class="tf-row"><span class="text-muted">时间</span><span>${esc((it.fl_created || '').slice(0, 16))}</span></div>
        <div class="text-muted tf-note">说明：本记录为引用「红花奖惩台账」，仅做展示；不重复发花、不改动红花数据。</div>
      </div>`);
    }
  };

  // ── 关联公告/宣贯/PDCA：专题内主动挑选（跨类型一次搜，已关联的自动剔除）─────────
  const TOPIC_TYPE_LABEL = { announcement: '公告', dissem: '宣贯', pdca: 'PDCA', flower: '红花' };
  const TOPIC_ITEM_STATUS = { active: '生效中', pending: '待审核', rejected: '未通过', archived: '已归档', deleted: '已删除',
    found: '待解决', solving: '解决中', recorded: '已记录', consulted: '已请教', solved: '已解决', reviewed: '已回顾', closed: '已闭环' };
  // initType：从「专题小红花」区的直达按钮进来时，预置为 flower（省去再点一次标签）
  Pages.topicLink = async (initType) => {
    if (!topicCanWrite()) return UI.toast('当前账号仅可浏览');
    const type0 = ['announcement','dissem','pdca','flower'].includes(String(initType)) ? String(initType) : '';
    // 红花标签仅超级管理员可见（2026-10-10 裁定：链接红花只能超级管理员做，其他人不给权限）。
    // ⚠️ 这里**不能**用 topicIsAdmin()——它把副院长×××也算进来了，红花必须严格只认超级管理员。
    // 以已加载的专题后端标志为准；拿不到时（列表页首次进入）退回严格本地判断。
    const meIsLiye = !!(App.user && (App.user.username === 'superadmin'));
    const canFlowerTab = meIsLiye || !!(topicData && topicData.topic && topicData.topic.canManageFlower);
    const isFlowerMode = type0 === 'flower' && canFlowerTab;
    const m = UI.modal(isFlowerMode ? '关联小红花' : '关联质量内容', `<input class="input" id="tl-kw" placeholder="${isFlowerMode ? '搜索获奖人、加花数量或事由…' : '输入标题关键词或 PDCA 工单号…'}">
      ${isFlowerMode ? '' : `<div class="tl-types"><span class="badge badge-div active" data-t="">全部</span><span class="badge" data-t="announcement">公告</span><span class="badge" data-t="dissem">宣贯</span><span class="badge" data-t="pdca">PDCA</span></div>`}
      ${isFlowerMode ? '' : `<div class="filter-bar tl-divbar" id="tl-divbar"></div>`}
      <div class="tl-batchbar"><label class="tl-pickall"><input type="checkbox" id="tl-all"> 全选本页</label><span class="text-muted" id="tl-count">已选 0 条</span></div>
      <div id="tl-list" class="tl-list"><div class="loading">正在加载…</div></div>`, (mask) => {
      const input = mask.querySelector('#tl-kw');
      const listEl = mask.querySelector('#tl-list');
      const allBox = mask.querySelector('#tl-all');
      const countEl = mask.querySelector('#tl-count');
      let type = type0;
      // 专业筛选（用户 2026-10-10 要求；2026-10-11 再去掉「不限专业」——用户反馈没用）：
      // '__all__' 为全部专业（含无专业内容）；其余为具体专业
      let divFilter = '__all__';
      let lastRows = [];
      const divBar = mask.querySelector('#tl-divbar');
      const rowDivisions = (r) => {
        if (!r) return [];
        if (Array.isArray(r.divisions)) return r.divisions.filter(Boolean);
        try { const x = JSON.parse(r.divisions || '[]'); return Array.isArray(x) ? x.filter(Boolean) : []; } catch (e) { return []; }
      };
      const renderDivBar = () => {
        if (!divBar) return;
        const present = [];
        const seen = new Set();
        lastRows.forEach(r => rowDivisions(r).forEach(d => { if (!seen.has(d)) { seen.add(d); present.push(d); } }));
        const opts = [['__all__', '全部专业']].concat(present.map(d => [d, d]));
        divBar.innerHTML = opts.map(([v, label]) => `<span class="filter-chip${divFilter === v ? ' active' : ''}" data-d="${esc(v)}">${esc(label)}</span>`).join('');
        divBar.querySelectorAll('.filter-chip').forEach(c => {
          c.onclick = () => { divFilter = c.getAttribute('data-d'); paintList(); };
        });
      };
      const matchDiv = (r) => {
        if (divFilter === '__all__') return true;
        const ds = rowDivisions(r);
        return ds.includes(divFilter);   // 无专业内容仅出现在「全部专业」下
      };
      // 只做前端过滤，不重新请求（请求已在 paint 里完成）
      const paintList = () => {
        renderDivBar();          // 同步高亮当前选中的专业（否则点完筛选条 active 不变）
        const rows = lastRows.filter(matchDiv);
        if (!rows.length) { listEl.innerHTML = '<div class="empty"><div class="et">该专业下没有可关联的内容</div></div>'; paintCount(); return; }
        listEl.innerHTML = rows.map(r => `<div class="tl-item selectable${picked.has(r.target_type + '#' + r.id) ? ' picked' : ''}" data-key="${esc(r.target_type + '#' + r.id)}" data-type="${esc(r.target_type)}" data-id="${r.id}">
            <label class="tl-pick"><input type="checkbox" ${picked.has(r.target_type + '#' + r.id) ? 'checked' : ''}></label>
            <div class="tl-main"><div class="tl-title">${esc(r.title || '')}</div>
            <div class="text-muted"><span class="badge">${esc(TOPIC_TYPE_LABEL[r.target_type] || r.target_type)}</span> ${rowDivisions(r).length ? `<span class="badge badge-div">${esc(rowDivisions(r).join('/'))}</span> ` : ''}${esc(r.target_type === 'pdca' ? (r.code || '') + ' · ' : '')}${esc(r.publisher || r.reporter || '')} · ${esc((r.created_at || '').slice(0, 10))}</div></div>
            <button class="btn btn-sm btn-primary" data-act="add">加入</button></div>`).join('')
          + `<div class="tl-foot"><button class="btn btn-sm btn-primary btn-block" data-act="batch">关联所选</button></div>`;
        listEl.querySelectorAll('.tl-item').forEach(el => {
          el.__row = { target_type: el.getAttribute('data-type'), id: Number(el.getAttribute('data-id')) };
        });
        syncPickedUI();
      };
      // 已勾选集合：key = `${target_type}#${id}`。跨搜索/翻页保留勾选。
      const picked = new Map();
      const keyOf = r => r.target_type + '#' + r.id;
      const paintCount = () => {
        countEl.textContent = `已选 ${picked.size} 条`;
        // 全选框状态：当前页是否全部已选
        const cur = [...listEl.querySelectorAll('.tl-item')].map(el => el.getAttribute('data-key'));
        allBox.checked = cur.length > 0 && cur.every(k => picked.has(k));
        allBox.indeterminate = !allBox.checked && cur.some(k => picked.has(k));
      };
      const syncPickedUI = () => {
        listEl.querySelectorAll('.tl-item').forEach(el => {
          const on = picked.has(el.getAttribute('data-key'));
          el.classList.toggle('picked', on);
          const cb = el.querySelector('input[type=checkbox]');
          if (cb) cb.checked = on;
        });
        paintCount();
      };
      const submit = async (rows, btn) => {
        if (!rows.length) return UI.toast('请先勾选要关联的内容');
        if (btn) btn.disabled = true;
        try {
          // 逐条提交，收集成功/失败/已关联，容错而不中断整批
          let ok = 0, dup = 0; const errs = [];
          for (const r of rows) {
            try {
              await API.post(`/api/quality-topics/${topicId}/items`, { target_type: r.target_type, target_id: Number(r.id) });
              ok++;
            } catch (err) {
              const msg = err.message || String(err);
              if (msg.includes('已关联')) dup++; else errs.push(msg);
            }
          }
          if (errs.length) UI.toast(`部分失败：${errs[0]}`);
          else if (ok && dup) UI.toast(`已关联 ${ok} 条，${dup} 条已存在`);
          else if (ok) UI.toast(`已关联 ${ok} 条`);
          else if (dup) UI.toast('所选内容均已关联');
          if (ok) { m.close(); await Pages.memoTopic(topicId); }
          else if (btn) btn.disabled = false;
        } catch (e) { if (btn) btn.disabled = false; UI.toast(e.message || '关联失败'); }
      };
      const paint = async () => {
        listEl.innerHTML = '<div class="loading">正在加载…</div>';
        try {
          const rows = await API.get(`/api/quality-topics/${topicId}/linkable?kw=${encodeURIComponent(input.value.trim())}&type=${type}`);
          if (!rows.length) { listEl.innerHTML = '<div class="empty"><div class="et">没有可关联的内容</div></div>'; paintCount(); return; }
          lastRows = rows;      // 缓存供专业筛选在前端过滤，避免每次点筛选都打接口
          renderDivBar();
          paintList();
        } catch (e) { listEl.innerHTML = `<div class="empty"><div class="et">加载失败：${esc(e.message || e)}</div></div>`; }
      };
      mask.querySelectorAll('.tl-types .badge').forEach(b => { b.onclick = () => { mask.querySelectorAll('.tl-types .badge').forEach(x => x.classList.remove('active')); b.classList.add('active'); type = b.getAttribute('data-t'); paint(); }; });
      // 勾选：整行可点（多选核心交互）
      listEl.addEventListener('click', async (e) => {
        const row = e.target.closest('.tl-item');
        const btn = e.target.closest('button[data-act="add"]');
        const batch = e.target.closest('button[data-act="batch"]');
        if (batch) {
          const rows = [...picked.values()];
          return submit(rows, batch);
        }
        if (!row || btn) return;
        const k = row.getAttribute('data-key');
        if (picked.has(k)) picked.delete(k); else picked.set(k, row.__row);
        syncPickedUI();
      });
      allBox.onchange = () => {
        listEl.querySelectorAll('.tl-item').forEach(el => {
          const k = el.getAttribute('data-key');
          if (allBox.checked) picked.set(k, el.__row); else picked.delete(k);
        });
        syncPickedUI();
      };
      let timer = null;
      input.oninput = () => { clearTimeout(timer); timer = setTimeout(paint, 260); };
      paint();
    });
  };
  Pages.topicUnlink = async (itemId) => {
    if (!topicCanWrite()) return UI.toast('当前账号仅可浏览');
    if (!(await UI.confirm('取消这条关联？专题本身和原文都不受影响。'))) return;
    try { UI.loading(true); await API.del(`/api/quality-topics/${topicId}/items/${itemId}`); UI.toast('已取消关联'); await Pages.memoTopic(topicId); }
    catch (e) { UI.toast(e.message || '取消失败'); } finally { UI.loading(false); }
  };
// 专题详情页渲染：一次拼装 HTML，权限完全由后端返回的 canEdit / canContribute 决定，
  // 前端只负责把按钮画出来，不自行推断角色。
  function topicStatusLabel(s) {
    return s === 'active' ? '进行中' : (s === 'archived' ? '已归档' : '草稿');
  }
  function topicPostHtml(p, t) {
    const canEditPost = p.canEdit && topicCanContribute();
    const isDraft = p.status === 'draft';
    return `<article class="topic-post ${p.is_pinned ? 'pinned' : ''} ${isDraft ? 'draft' : ''}">
      <div class="topic-post-meta"><b>${esc(p.title || p.post_type)}</b><span>${esc(p.author_name || '')} · ${esc((p.published_at || p.created_at || '').slice(0, 16))}</span></div>
      <div class="topic-post-tags">${isDraft ? '<span class="badge badge-warn">草稿 · 仅你与超级管理员可见</span>' : `<span class="badge badge-div">${esc(p.post_type || '')}</span>`}${p.is_pinned ? '<span class="badge badge-pin">置顶</span>' : ''}</div>
      <div class="li-desc">${esc(p.content || '')}</div>
      ${p.photos && p.photos.length ? UI.photoGrid(p.photos) : ''}
      ${p.attachments && p.attachments.length ? UI.attChips(p.attachments) : ''}
      ${canEditPost ? `<div class="topic-post-acts">
        ${isDraft ? `<button class="btn btn-sm btn-primary" onclick="Pages.topicPostToggleDraft(${p.id})">发布</button>` : `<button class="btn btn-sm btn-outline" onclick="Pages.topicPostToggleDraft(${p.id})">收回草稿</button>`}
        <button class="btn btn-sm btn-outline" onclick="Pages.topicEditPost(${p.id})">编辑</button>
        ${t.canManage ? `<button class="btn btn-sm btn-outline" onclick="Pages.topicPin(${p.id}, ${p.is_pinned ? 0 : 1})">${p.is_pinned ? '取消置顶' : '置顶'}</button>` : ''}
        <button class="btn btn-sm btn-del" onclick="Pages.topicDeletePost(${p.id})">删除</button>
      </div>` : ''}
    </article>`;
  }
  Pages.memoTopic = async (id) => {
    topicId = Number(id);
    const body = document.getElementById('memo-body');
    if (!body) return;
    body.innerHTML = '<div class="loading">正在加载专题……</div>';
    try {
      topicData = await API.get('/api/quality-topics/' + topicId);
      const t = topicData.topic;
      const posts = topicData.posts || [];
      const items = topicData.items || [];
      const isAdmin = !!t.canManage;          // 仅超级管理员：置顶 / 删除
      const canEditTopic = !!t.canEdit;       // 作者本人 + 超级管理员：发布 / 归档 / 编辑
      const canContribute = topicCanContribute() && t.status !== 'archived';
      // 挂红花：仅超级管理员（2026-10-10 裁定）。用后端标志，不要用 canContribute 推导——后者含专总/室主任。
      const canFlower = !!t.canManageFlower && t.status !== 'archived';
      // 红花与「关联质量内容」分区展示（2026-10-10 用户裁定）：红花只在下方专属栏目出现，
      // 上方关联区一律不渲染红花项，避免同一批内容在两处重复。
      const flowerItems = items.filter(i => i.target_type === 'flower');
      const allLinkItems = items.filter(i => i.target_type !== 'flower');
      // 「关联质量内容」区按专业筛选（2026-10-10 用户要求，与弹窗内候选筛选一致）
      const itemDivisions = (i) => {
        if (!i) return [];
        if (Array.isArray(i.item_divisions)) return i.item_divisions.filter(Boolean);
        try { const x = JSON.parse(i.item_divisions || '[]'); return Array.isArray(x) ? x.filter(Boolean) : []; } catch (e) { return []; }
      };
      const linkDivisions = []; const _seenDiv = new Set();
      allLinkItems.forEach(i => itemDivisions(i).forEach(d => { if (!_seenDiv.has(d)) { _seenDiv.add(d); linkDivisions.push(d); } }));
          const matchItemDiv = (i) => {
        if (topicDivFilter === '__all__') return true;
        const ds = itemDivisions(i);
        return ds.includes(topicDivFilter);   // 无专业内容仅出现在「全部专业」下
      };
      const linkItems = allLinkItems.filter(matchItemDiv);
      const divFilterBarHtml = allLinkItems.length
        ? `<div class="filter-bar tl-divbar" id="topic-divbar">${[['__all__', '全部专业']].concat(linkDivisions.map(d => [d, d]))
            .map(([v, label]) => `<span class="filter-chip${topicDivFilter === v ? ' active' : ''}" data-d="${esc(v)}">${esc(label)}</span>`).join('')}</div>`
        : '';
      // 状态流转 + 编辑：作者本人 + 超级管理员；置顶 / 删除：仅超级管理员；内容贡献者：发动态 / 关联
      const statusBtns = canEditTopic ? (t.status === 'active'
        ? '<button class="btn btn-gray" onclick="Pages.topicSetStatus(\'archived\')">归档</button>'
        : `<button class="btn btn-primary" onclick="Pages.topicSetStatus('active')">${t.status === 'archived' ? '重新上线' : '发布上线'}</button><button class="btn btn-gray" onclick="Pages.topicSetStatus('draft')">收回草稿</button>`)
        : '';
      const editBtn = canEditTopic ? `<button class="btn btn-gray" onclick="Pages.topicEdit()">编辑专题</button>` : '';
      const adminOnlyBtns = isAdmin ? `<button class="btn btn-gray" onclick="Pages.topicPinTopic(${t.pinned ? 0 : 1})">${t.pinned ? '取消置顶' : '置顶专题'}</button><button class="btn btn-del" onclick="Pages.topicDelete()">删除</button>` : '';
      const adminBtns = statusBtns + editBtn + adminOnlyBtns;
      const contribBtns = canContribute ? `<button class="btn btn-primary" onclick="Pages.topicPost()">＋ 发布动态</button>` : '';
      body.innerHTML = `<div class="topic-detail">
        <div class="topic-hero" style="${t.color ? `background:linear-gradient(90deg, ${t.color}1A, transparent 60%); border-left:5px solid ${t.color}; color:#1f2d3d;` : 'color:#1f2d3d;'}">
          <div class="topic-kicker">质量专题 · ${topicStatusLabel(t.status)}${t.code ? ' · ' + esc(t.code) : ''}${t.pinned ? ' · 📌置顶' : ''}</div>
          <h2>${esc(t.title)}</h2>
          <p>${esc(t.summary || '')}</p>
          <div class="text-muted">负责人：${esc(t.owner_name || '未指定')} · 动态 ${posts.filter(p => p.status === 'published').length} 条</div>
          ${(t.status === 'draft') ? '<div class="topic-tip">草稿状态：仅你与超级管理员可见，发布上线后全员可见</div>' : (t.status === 'archived' ? '<div class="topic-tip">已归档下架：全员列表不可见，仅你与超级管理员可打开，可「重新上线」恢复</div>' : '')}
        </div>
        <div class="row-btns mt12">${contribBtns}${adminBtns}<button class="btn btn-gray" onclick="Pages.topicBack()">← 返回专题列表</button></div>
        <section class="topic-section"><h3>专题动态</h3>
          ${posts.length ? posts.map(p => topicPostHtml(p, t)).join('')
            : `<div class="empty"><div class="ei">📝</div><div class="et">还没有专题动态</div>${canContribute ? '<div class="es">点上方「＋ 发布动态」记录第一条阶段进展</div>' : ''}</div>`}
        </section>
        <section class="topic-section"><div class="topic-sec-head"><h3>关联质量内容</h3>${canContribute ? '<button class="btn btn-sm btn-outline" onclick="Pages.topicLink()">＋ 关联内容</button>' : ''}</div>
          ${divFilterBarHtml}
          ${linkItems.length ? linkItems.map(i => `<div class="topic-linked clickable" onclick="Pages.topicOpenLinked('${esc(i.target_type)}', ${i.target_id})"><span class="badge">${TOPIC_TYPE_LABEL[i.target_type] || i.target_type}</span><span class="tl-link-main"><b>${esc(i.target_title || '原内容已删除')}</b>${itemDivisions(i).length ? `<span class="badge badge-div">${esc(itemDivisions(i).join('/'))}</span>` : ''}${i.target_status ? `<span class="text-muted">${esc(TOPIC_ITEM_STATUS[i.target_status] || i.target_status)}</span>` : ''}</span>${i.canUnlink ? `<span class="att-x" onclick="event.stopPropagation(); Pages.topicUnlink(${i.id})" title="取消关联">✕</span>` : ''}</div>`).join('')
            : allLinkItems.length
              ? `<div class="text-muted">该专业下暂无关联内容，换个专业或点「全部专业」看看</div>`
              : `<div class="text-muted">暂未关联公告、宣贯或 PDCA${canContribute ? '，点右上「＋ 关联内容」把已发布的材料挂进来' : ''}</div>`}
        </section>
        <section class="topic-section"><div class="topic-sec-head"><h3>专题小红花</h3>${canFlower ? '<button class="btn btn-sm btn-outline" onclick="Pages.topicLink(\'flower\')">＋ 关联红花</button>' : ''}</div>
          ${flowerItems.length ? flowerItems.map(i => `<div class="topic-linked clickable" onclick="Pages.topicOpenLinked('flower', ${i.target_id})"><span class="badge" style="background:#fdecea;color:#c0392b">红花</span><span class="tl-link-main"><b>${esc(i.target_title || '原记录已删除')}</b><span class="text-muted">${i.fl_delta > 0 ? '+' : ''}${i.fl_delta}朵 · ${(i.fl_created || '').slice(0, 10)}</span></span>${i.canUnlink ? `<span class="att-x" onclick="event.stopPropagation(); Pages.topicUnlink(${i.id})" title="取消关联">✕</span>` : ''}</div>`).join('')
            : `<div class="text-muted">本专题尚未关联红花奖惩记录。${canFlower ? '点右上「＋ 关联红花」，从「红花奖惩台账」里挑相关记录挂进来。' : '红花数据来自「红花奖惩台账」，此处仅做引用展示、不重复发花、不改动红花数据；关联操作由超级管理员统一把关。'}</div>`}
        </section>
      </div>`;
      // 关联区专业筛选：点chip 改topicDivFilter 后**只重渲染该区**，不重新请求（保留滚动位置与勾选状态）
      const divbar = body.querySelector('#topic-divbar');
      if (divbar) {
        divbar.querySelectorAll('.filter-chip').forEach(c => {
          c.onclick = () => { topicDivFilter = c.getAttribute('data-d'); Pages.memoTopic(topicId); };
        });
      }
    } catch (e) {
      body.innerHTML = `<div class="load-fail"><div class="lf-t">加载失败：${esc(e.message || e)}</div><button class="btn btn-sm btn-gray" onclick="Pages.memoTopic(${topicId})">重试</button></div>`;
    }
  };
// 专题列表页：卡片显示状态徽标（草稿/进行中/已归档），仅超级管理员看到「＋新建专题」。
  function topicCardHtml(t) {
    const badgeCls = t.status === 'active' ? 'badge-div' : (t.status === 'archived' ? '' : 'badge-warn');
    return `<div class="topic-card${t.pinned ? ' pinned' : ''}" onclick="Pages.topicOpen(${t.id})" style="${t.color ? `border-left:5px solid ${t.color}; background:linear-gradient(90deg, ${t.color}12, transparent 45%);` : ''}">
      <div class="topic-card-head"><h3>${esc(t.title)}</h3><span class="badge ${badgeCls}">${topicStatusLabel(t.status)}</span>${t.pinned ? '<span class="badge badge-pin">📌置顶</span>' : ''}</div>
      ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
      <div class="text-muted">${t.code ? esc(t.code) + ' · ' : ''}动态 ${t.post_count || 0} · 关联 ${t.item_count || 0}${t.publish_date ? ' · 上线 ' + esc(String(t.publish_date).slice(0, 10)) : ''}</div>
    </div>`;
  }
  async function renderTopics(body) {
    const newBtn = topicCanContribute() ? '<button class="btn btn-primary" onclick="Pages.topicNew()">＋ 新建专题</button>' : '';
    const paint = (rows) => rows.length ? rows.map(topicCardHtml).join('')
      : '<div class="empty"><div class="ei">📚</div><div class="et">还没有质量专题</div><div class="es">专题由超级管理员或院长/专总/室主任创建并上线，之后各专业室可在此持续发布阶段动态</div></div>';
    body.innerHTML = `<div class="topic-toolbar"><input class="input" id="topic-kw" placeholder="搜索专题标题 / 编号">${newBtn}</div><div id="topic-list"><div class="loading">正在加载…</div></div>`;
    const input = body.querySelector('#topic-kw');
    const host = body.querySelector('#topic-list');
    let timer = null;
    const load = async (kw) => {
      host.innerHTML = '<div class="loading">正在加载…</div>';
      try { host.innerHTML = paint(await API.get('/api/quality-topics' + (kw ? '?kw=' + encodeURIComponent(kw) : ''))); }
      catch (e) { host.innerHTML = `<div class="load-fail"><div class="lf-t">加载失败：${esc(e.message || e)}</div><button class="btn btn-sm btn-gray" onclick="Pages.memo()">重试</button></div>`; }
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => load(input.value.trim()), 260); };
    await load('');
  }

  Pages.memo = async () => {
    const hash = String(location.hash || '');
    const topicHash = topicParseHash();
    if (topicHash != null) { topicId = topicHash; memoSub = 'topic'; memoPid = null; memoProject = null; memoRecords = []; await memoRenderShell(); return Pages.memoTopic(topicHash); }
    // 项目工期：独立 hash，避免与「质量专题 = #/memo」共用同一地址导致子 tab 切不动。
    if (/^#\/memo\/schedule\/?$/.test(hash)) return Pages.memoSchedule();
    // 旧 #/memo/<数字> 与 #/memo/legacy 深链继续走原项目备忘（历史数据与提醒跳转都依赖它）。
    if (!/^(?:#\/memo\/?)?$/.test(hash)) return Pages.memoLegacy();
    return Pages.memoTopics();
  };
  Pages.memoTopics = async () => { memoPid = null; memoProject = null; memoRecords = []; memoSub = 'topic'; topicId = null; await memoRenderShell(); };
  Pages.memoSchedule = async () => { memoPid = null; memoProject = null; memoRecords = []; memoSub = 'schedule'; topicId = null; await memoRenderShell(); };
  Pages.memoLegacy = async () => {
    memoSub = 'memo';   // 明确走旧项目备忘，避免沿用上一次的 'topic' 状态误渲染专题
    memoPid = null; memoProject = null; memoRecords = []; topicId = null;
    // 游客默认弹回首页；例外：后端已只读放开 GET 的游客允许进入浏览——
    //   · 2026-09-11 用户裁定 guest1 / guest2；2026-09-13 guest9（此前白名单漏列 guest9，故有 tab 却进不去，一并补上）
    //   · 2026-09-17 追加可考试只读游客 EXAMGUEST1~EXAMGUEST9（caps.canExam），与 memos 后端只读白名单一致
    const GUEST_MEMO_OK = ['guest1', 'guest2', 'guest9'];
    if (App.caps.isGuest && !App.caps.canExam && !GUEST_MEMO_OK.includes(String((App.user || {}).username || '').toLowerCase())) { location.hash = '#/home'; return; }
    // 解析地址栏二级路径：#/memo/<id> = 直接进入某项目详情（硬刷新 / 直接访问可恢复，并重新拉取最新记录）
    const hm = ('' + location.hash).slice(1).match(/^\/memo\/(\d+)/);
    const hashPid = hm ? parseInt(hm[1], 10) : null;
    // 从「项目备忘提醒」跳回原帖：进入指定项目（recordId 可能为 null，仅进入项目不定位具体记录）
    if (memoPendingProjectId != null) {
      const pid = memoPendingProjectId, rid = memoPendingRecordId;
      memoPendingProjectId = null; memoPendingRecordId = null;
      memoPid = pid; memoSub = 'memo';
      await memoRenderShell();
      if (rid != null) memoScrollToRecord(rid);
      return;
    }
    if (hashPid != null) {
      // 硬刷新 / 直接访问 #/memo/<id>：恢复项目详情视图（不清零；renderMemoDetail 会重新拉取最新记录）
      memoPid = hashPid; memoSub = 'memo';
      await memoRenderShell();
      // 一键加入时可能附带待定位的具体记录（recordId 可能为空，仅进入项目）
      if (memoPendingRecordId != null) { const rid = memoPendingRecordId; memoPendingRecordId = null; memoScrollToRecord(rid); }
      return;
    }
    // 旧项目列表（#/memo/legacy）：只清项目态，保留 memoSub='memo'
    await memoRenderShell();
  };

  // 从「项目备忘提醒」一键加入项目：接受邀请（软隐藏该提醒）→ 跳进对应项目详情（hash 化，硬刷保持）。
  // 后端在邀请时已将受邀人写入项目信息沟通人成员表，故「接受」= 标记已读并进入；进入即具备可见/参与资格。
  Pages.memoGotoOriginal = async (projectId, recordId, reminderId) => {
    // 关闭共享备忘弹窗（或其它模态）
    document.querySelectorAll('.modal-mask').forEach(m => m.remove());
    // 接受邀请：软隐藏该提醒（标记已加入；若卡片仍在，移除对应 DOM）
    if (reminderId) {
      try { await API.post(`/api/memos/my-reminders/${reminderId}/dismiss`, {}); } catch (e) {}
      document.querySelectorAll(`[data-mid="${reminderId}"]`).forEach(n => n.remove());
    }
    if (recordId != null) memoPendingRecordId = recordId;
    // 跳进项目详情（hash 化，硬刷保持）；已在项目备忘 tab 内则直接重渲染
    if (location.hash.startsWith('#/memo')) {
      Pages.memo();
    } else {
      location.hash = '#/memo/' + projectId;
    }
  };

  // 定位并高亮某条记录
  function memoScrollToRecord(rid) {
    setTimeout(() => {
      const el = document.getElementById('memo-rec-' + rid);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background-color .35s ease';
      const prev = el.style.backgroundColor;
      el.style.backgroundColor = '#fff7c2';
      setTimeout(() => { el.style.backgroundColor = prev || ''; }, 1800);
    }, 120);
  }

  Pages.memoSetSub = (t) => {
    // 两个子 tab 各自有独立 hash（#/memo 与 #/memo/schedule）：
    //   仅靠 location.hash 切换时，若当前已在同一 hash 则不触发 hashchange，表现为「点了没反应」。
    //   故先比对当前 hash，相同则直接重绘，不同才改 hash 交给路由。
    if (t === 'topic') {
      topicId = null;
      const h = String(location.hash || '');
      if (h === '#/memo' || h === '#/memo/' || h === '') { Pages.memoTopics(); return; }
      location.hash = '#/memo';
      return;
    }
    const h2 = String(location.hash || '');
    if (h2 === '#/memo/schedule') { Pages.memoSchedule(); return; }
    location.hash = '#/memo/schedule';
  };

  // ── 质量库（统一检索：质量宣贯 + 人人讲，可筛选）─────────
  // 复选筛选：类型 / 专业 / 地区 / 二级专业，均不限（不选=全看）；维度内 OR，维度间 AND
  //   kw：关键词（V3 §6.3 搜索框）。2026-09-16 起由服务端过滤（/library?kw=…）：
  //       旧做法是前端一次拉 limit=200 再本地过滤，条数超 200 会静默漏；现搜索可命中的是全量、且可继续「加载更多」。
  let libSel = { cats: new Set(), divs: new Set(), regs: new Set(), subDivs: new Set(), from: '', to: '', kw: '', mineOnly: false };
  let libPanelOpen = '';   // 质量库 chips 下拉面板展开态：'' | 'adv' | 'time'

  // 关键词匹配已移至服务端（/library?kw=…，按完整正文匹配），前端不再本地过滤 —— 2026-09-16。

  async function renderLibrary(body) {
    let filters = { categories: [], divisions: [], regions: [], divisionSubs: {} };
    try { filters = await API.get('/api/quality-dissem/filters'); } catch (e) {}

    const catOpts = [...new Set([...QC_CATEGORIES, ...filters.categories, '公告'])];
    const divOpts = filters.divisions;
    const regOpts = [...new Set([...QC_REGIONS, ...filters.regions])];
    // V3 §3.2 / §6.3（用户裁定 2026-09-11）：质量库筛选与首页「质量宣贯」统一为 chips 体系 ——
    // 主 chips = 专业多选（与首页同构）；类型 / 二级专业 / 地区 / 时间 收进「⌄」下拉面板，功能零丢失。
    const paintFilters = () => {
      const host = body.querySelector('#lib-filters');
      if (!host) return;
      const hasAdv = !!(libSel.cats.size || libSel.regs.size || libSel.subDivs.size);
      const advN = libSel.cats.size + libSel.regs.size + libSel.subDivs.size;
      const hasTime = !!(libSel.from || libSel.to);
      const noFilter = !libSel.divs.size && !hasAdv && !hasTime && !libSel.mineOnly;
      const subDivHtml = UI.subDivMultiHtml(divOpts, filters.divisionSubs || {}, [...libSel.subDivs], 'subDivs', { onlyWithSubs: true });
      const chk = (dim, o) => `<label class="filter-chk"><input type="checkbox" data-dim="${dim}" value="${esc(o)}" ${libSel[dim].has(o) ? 'checked' : ''}> ${esc(o)}</label>`;
      host.innerHTML = `
        <div class="filter-bar" id="lib-chips">
          <span class="filter-chip ${libSel.mineOnly ? 'active' : ''}" onclick="Pages.libChipMine()">我的待阅</span>
          <span class="filter-chip ${noFilter ? 'active' : ''}" onclick="Pages.libChipAll()">全部<span class="fc-c" data-div-count="__all__">${libCountsReady ? libFacetTotal : ''}</span></span>
          ${divOpts.map(d => `<span class="filter-chip ${libSel.divs.has(d) ? 'active' : ''}" onclick="Pages.libChipDiv('${esc(d)}')">${esc(d)}<span class="fc-c" data-div-count="${esc(d)}">${libCountsReady && libDivCounts[d] !== undefined ? libDivCounts[d] : ''}</span></span>`).join('')}
          <span class="filter-chip ${hasAdv ? 'active' : ''}" onclick="Pages.libPanel('adv')"><span class="fc-caret">⌄</span>更多筛选${advN ? `<span class="fc-n">${advN}</span>` : ''}</span>
          <span class="filter-chip ${hasTime ? 'active' : ''}" onclick="Pages.libPanel('time')"><span class="fc-caret">⌄</span>时间</span>
        </div>
        <div class="filter-panel" id="lib-panel-adv"${libPanelOpen === 'adv' ? '' : ' hidden'}>
          <div class="filter-label">类型</div>
          <div class="filter-chks">${catOpts.map(o => chk('cats', o)).join('')}</div>
          ${subDivHtml ? `<div class="filter-label" style="margin-top:10px">二级专业（在所选专业下进一步细分）</div><div class="filter-chks">${subDivHtml}</div>` : ''}
          <div class="filter-label" style="margin-top:10px">地区</div>
          <div class="filter-chks">${regOpts.map(o => chk('regs', o)).join('')}</div>
        </div>
        <div class="filter-panel" id="lib-panel-time"${libPanelOpen === 'time' ? '' : ' hidden'}>
          <div class="lib-dates">
            <input class="input" id="lib-from" type="date" value="${libSel.from}">
            <span>~</span>
            <input class="input" id="lib-to" type="date" value="${libSel.to}">
          </div>
        </div>`;
      host.querySelectorAll('.filter-chk input').forEach(cb => {
        cb.onchange = () => {
          const dim = cb.dataset.dim, v = cb.value;
          if (cb.checked) libSel[dim].add(v); else libSel[dim].delete(v);
          paintFilters();
          libReload();
        };
      });
      const fEl = host.querySelector('#lib-from'); if (fEl) fEl.onchange = libReload;
      const tEl = host.querySelector('#lib-to'); if (tEl) tEl.onchange = libReload;
    };

    // 计数角标回填（就地改文本，不重建 chips —— 否则横向滚动位置会被重置、面板内输入焦点会丢）
    const applyChipCounts = () => {
      const host = body.querySelector('#lib-chips');
      if (!host) return;
      host.querySelectorAll('.fc-c[data-div-count]').forEach(el => {
        const key = el.getAttribute('data-div-count');
        if (key === '__all__') {
          el.textContent = libCountsReady ? String(libFacetTotal) : '';
          el.classList.remove('zero');
          return;
        }
        const known = libCountsReady && libDivCounts[key] !== undefined;
        const n = known ? libDivCounts[key] : 0;
        el.textContent = known ? String(n) : '';
        el.classList.toggle('zero', n === 0);
      });
    };

    // chips / 下拉面板交互（挂 Pages 供 onclick 调用；每次渲染重新绑定到当前 body）
    Pages.libChipAll = () => {
      libSel.divs.clear(); libSel.cats.clear(); libSel.regs.clear(); libSel.subDivs.clear();
      libSel.from = ''; libSel.to = ''; libSel.mineOnly = false; libPanelOpen = '';
      paintFilters(); libReload();
    };
    Pages.libChipDiv = (d) => {
      if (libSel.divs.has(d)) libSel.divs.delete(d); else libSel.divs.add(d);
      libSel.subDivs.clear();   // 专业变了，二级专业随之重算
      paintFilters(); libReload();
    };
    // 「我的待阅」：仅显示本人应阅且未阅的帖子（其余隐藏）；与专业/类型筛选可叠加
    Pages.libChipMine = () => { libSel.mineOnly = !libSel.mineOnly; paintFilters(); libReload(); };
    Pages.libPanel = (w) => { libPanelOpen = (libPanelOpen === w) ? '' : w; paintFilters(); };

    body.innerHTML = `
      <div class="lib-search">
        <svg class="ls-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
        <input class="input" id="lib-kw" type="search" placeholder="搜索标题 / 标准号 / 关键词" value="${esc(libSel.kw || '')}">
      </div>
      <div id="lib-filters"></div>
      <div id="lib-list"><div class="empty"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div></div></div>`;

    libReload = async (append = false) => {
      libSel.from = body.querySelector('#lib-from').value;
      libSel.to = body.querySelector('#lib-to').value;
      const kwEl = body.querySelector('#lib-kw');
      libSel.kw = kwEl ? kwEl.value.trim() : '';
      if (!append) libOffset = 0;
      const q = new URLSearchParams();
      if (libSel.cats.size) q.set('category', [...libSel.cats].join(','));
      if (libSel.divs.size) q.set('division', [...libSel.divs].join(','));
      if (libSel.subDivs.size) q.set('subDivision', [...libSel.subDivs].join(','));
      if (libSel.regs.size) q.set('region', [...libSel.regs].join(','));
      if (libSel.from) q.set('from', libSel.from);
      if (libSel.to) q.set('to', libSel.to);
      // 关键词交服务端过滤（不再前端拉全量本地过滤）：任意条数都能翻到，不受单页上限截断。
      if (libSel.kw) q.set('kw', libSel.kw);
      q.set('limit', libLimit);
      q.set('offset', libOffset);
      const data = await API.get('/api/quality-dissem/library?' + q.toString());
      const items = (Array.isArray(data) ? data : (data && data.items)) || [];
      libHasMore = Array.isArray(data) ? false : !!data.hasMore;
      if (append) {
        // 去重：按 id 合并，避免筛选切换/翻页时与已加载项重复
        const seen = new Set(libItems.map(x => x && x.id));
        libItems = libItems.concat(items.filter(x => x && !seen.has(x.id)));
      } else {
        libItems = items;
      }
      // 关键词已由服务端过滤，libItems 即结果集；各一级专业条数也由服务端按「含 kw 的当前条件」算好返回。
      const computeCounts = (list) => {
        const c = {}; let nodiv = 0;
        for (const it of list) {
          const ds = it.divisions || [];
          if (!ds.length) { nodiv++; continue; }
          for (const d of ds) c[d] = (c[d] || 0) + 1;
        }
        return { c, nodiv };
      };
      if (!Array.isArray(data)) {
        libDivCounts = data.divisionCounts || {};
        libNoDivCount = data.noDivisionCount || 0;
        libFacetTotal = data.facetTotal || 0;
        libCountsReady = true;
      } else {
        // 服务端返回纯数组（历史兼容分支）：只有当前页数据，角标改为前端按已加载集合计算
        const r = computeCounts(libItems);
        libDivCounts = r.c; libNoDivCount = r.nodiv; libFacetTotal = libItems.length;
        libCountsReady = libItems.length > 0;
      }
      applyChipCounts();
      paintLibList(libItems, libHasMore);
    };

    // 搜索框：防抖 250ms（每次只重绘 #lib-list，输入框不重建 → 焦点/光标不丢）
    const kwEl = body.querySelector('#lib-kw');
    if (kwEl) {
      let kwTimer = null;
      kwEl.oninput = () => { clearTimeout(kwTimer); kwTimer = setTimeout(() => { libSel.kw = kwEl.value.trim(); libReload(); }, 250); };
    }
    // chips 与下拉面板（须先于 libReload：后者要读 #lib-from / #lib-to 的当前值）
    paintFilters();
    await libReload();
  }

  // 质量库「加载更多」：追加下一页（保留当前筛选条件）
  Pages.libLoadMore = async () => {
    if (libLoadingMore) return;
    libLoadingMore = true;
    const btn = document.getElementById('lib-loadmore');
    if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
    libOffset += libLimit;
    try { if (libReload) await libReload(true); }
    catch (e) { UI.toast(e.message); }
    finally { libLoadingMore = false; }
  };

  async function paintLibList(list, hasMore) {
    const el = document.getElementById('lib-list');
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="empty"><div class="ei">📚</div><div class="et">质量库暂无匹配内容</div><div class="es">试试调整筛选或搜索关键词</div></div>'; return; }
    let html = list.map(it => {
      const srcTag = it.source === 'renrenjiang' ? '<span class="tag">人人讲</span>' : it.source === 'announcement' ? '<span class="tag">公告</span>' : '<span class="tag">宣贯</span>';
      const rrjTag = it.rrjSelected ? '<span class="tag tag-rrj">院选 🏵️</span>' : '';
      const noteTag = (it.managerNote && String(it.managerNote).trim()) ? '<span class="tag tag-note">有备注</span>' : '';
      const statusTag = (it.source === 'dissem' || it.source === 'announcement') ? (it.status === 'active' ? '<span class="badge badge-warn">公示中</span>' : '<span class="badge">已归档</span>') : '';
      const subs = it.subDivisions || [];
      // 已阅类型：renrenjiang(人人讲) 对应 pdca；其余直接用 source（announcement/dissem）
      const ackType = it.source === 'renrenjiang' ? 'pdca' : it.source;
      // 个人已阅色块（标题前小圆点）：绿=已阅 / 橙红=待阅 / 隐藏=非应阅人（由 fillAckCounts 注入状态）
      const mini = (it.requireAck !== 0) ? `<span class="ack-mini" id="ack-mini-${ackType}-${it.id}"></span>` : '';
      const meta = [it.category ? `<span class="tag">${esc(it.category)}</span>` : '', (it.divisions || []).length ? `<span>🏢 ${(it.divisions || []).map(esc).join('/')}</span>` : '', subs.length ? `<span>🔻 ${subs.map(s => UI.subDivLabel(s)).join(' / ')}</span>` : '', (it.regions || []).length ? `<span>📍 ${(it.regions || []).map(esc).join('/')}</span>` : ''].filter(Boolean).join(' ');
      // 已阅缩略栏：仅在「要求已阅确认」的帖上显示；renrenjiang(人人讲) 对应已阅类型 pdca
      const ackLine = (it.requireAck !== 0)
        ? `<div class="li-ack"><span class="ack-stat">✓ 已阅 <span id="ack-count-${ackType}-${it.id}">–/–</span></span><span class="ack-me" id="ack-me-${ackType}-${it.id}"></span></div>`
        : '';
      return `<div class="lib-item" data-mine="none" onclick="Pages.libDetail('${it.source}',${it.id})">
        <div class="li-head">${mini}<div class="li-title">${esc(it.title)}</div>${srcTag}${rrjTag}${noteTag}${statusTag}</div>
        ${it.summary ? `<div class="li-desc">${esc(it.summary)}</div>` : ''}
      <div class="li-meta">${meta}<span>📣 ${esc(it.publisher || '')}</span><span>${UI.relTime(it.publishDate)}</span></div>
      ${ackLine}
    </div>`;
    }).join('');
    if (hasMore) html += `<button class="btn btn-block btn-gray mt8" id="lib-loadmore" onclick="Pages.libLoadMore()">加载更多…</button>`;
    el.innerHTML = html;
    // 回填本页所有帖子的「整体已阅 N/M」与「本人是否已阅」缩略栏（一次 /counts 请求批量拉取）；
    // 回填完成时同步点亮个人色块并写入 data-mine，供「我的待阅」筛选使用
    if (typeof Pages.fillAckCounts === 'function') await Pages.fillAckCounts();
    // 若开启了「我的待阅」，回填后立即隐藏非待阅卡
    applyMineFilter();
  }

  // 「我的待阅」筛选：仅当 libSel.mineOnly 开启时，隐藏 data-mine 不为 'todo' 的卡片
  // （data-mine 在 fillAckCounts 回填计数时写入：todo=应阅未阅 / done=已阅 / none=非应阅人）
  function applyMineFilter() {
    if (!libSel.mineOnly) return;
    const cards = document.querySelectorAll('#lib-list .lib-item');
    cards.forEach(card => {
      const mine = card.getAttribute('data-mine');
      card.style.display = (mine === 'todo') ? '' : 'none';
    });
  }

  // ── 已阅确认区（取代"评论"：公告 / 宣贯 / PDCA 院选人人讲 / PDCA 详情）──────────────
  // 折叠态展示「✓ 已阅 N/M」，点击标题栏展开/收起；展开后显示已阅名单 + 未阅名单（专业帖/PDCA）+ 操作按钮。
  // 注意：首页卡片整卡可点跳转详情，已阅区嵌在卡片内，必须在标题栏与面板上 stopPropagation，否则误触发卡片跳转。
  // instance：同一 (type,id) 可能在「首页卡片」与「详情弹窗」同时存在于 DOM，用后缀隔离 DOM id，避免 getElementById 命中错元素。
  // opts：{ instance, requireAck, canRemind }
  Pages.ackBlockHtml = function(type, id, opts) {
    opts = opts || {};
    const instance = opts.instance || '';
    const requireAck = (opts.requireAck === 0 || opts.requireAck === false) ? 0 : 1;
    if (!requireAck) {
      return `<hr class="sep"><div class="card-sub mt8 text-muted">（本帖无需已阅确认）</div>`;
    }
    const canAck = !App.caps.isGuest;
    const btn = canAck
      ? `<button class="btn btn-sm btn-primary" id="ack-btn-${type}-${id}${instance}" onclick="event.stopPropagation();Pages.ackRead('${type}', ${id}, '${instance}')">我已阅</button>`
      : '<span class="text-muted">登录后可标记已阅</span>';
    // 提醒未阅：常显在「已阅」标题行右侧（仅发布人/管理者可见），无需展开面板即可触发
    const remind = opts.canRemind
      ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();Pages.remindUnread('${type}', ${id}, '${instance}')">提醒未阅</button>`
      : '';
    // 2026-10-10 用户裁定：「已阅」名单不再默认收起。
    //   autoOpen 仅由**详情/弹窗页**传入（instance='modal'）——那里一次只看一个帖子，默认展开最省一次点击；
    //   列表页仍保持收起，避免一页几十张卡全展开、拖慢首页。
    const autoOpen = !!opts.autoOpen;
    return `
  <hr class="sep">
  <div class="card-sub mt8 ack-title" onclick="event.stopPropagation();Pages.toggleAck('${type}', ${id}', '${instance}')">
    <span>✓ 已阅 <span id="ack-count-${type}-${id}${instance}">–/–</span> <span class="ack-caret" id="ack-caret-${type}-${id}${instance}">${autoOpen ? '▾' : '▸'}</span></span>
    ${remind}
  </div>
  <div id="ack-panel-${type}-${id}${instance}" class="ack-panel" style="display:${autoOpen ? 'block' : 'none'}" onclick="event.stopPropagation()" data-ack="1" data-ack-type="${type}" data-ack-id="${id}" data-ack-instance="${instance}">
    <div id="ack-body-${type}-${id}${instance}" class="ack-list text-muted"></div>
    <div class="row-btns mt8">${btn}</div>
  </div>`;
  };

  // 展开/收起：首次展开才拉数据
  Pages.toggleAck = (type, id, instance) => {
    instance = instance || '';
    const panel = document.getElementById('ack-panel-' + type + '-' + id + instance);
    const caret = document.getElementById('ack-caret-' + type + '-' + id + instance);
    if (!panel) return;
    const open = panel.style.display !== 'none';
    if (open) { panel.style.display = 'none'; if (caret) caret.textContent = '▸'; }
    else { panel.style.display = 'block'; if (caret) caret.textContent = '▾'; Pages.loadAck(type, id, instance); }
  };

  // 拉取并渲染已阅 / 未阅名单（count 始终更新；expand 时填充面板）
  Pages.loadAck = async (type, id, instance) => {
    instance = instance || '';
    const countEl = document.getElementById('ack-count-' + type + '-' + id + instance);
    const bodyEl = document.getElementById('ack-body-' + type + '-' + id + instance);
    const btnEl = document.getElementById('ack-btn-' + type + '-' + id + instance);
    let data;
    try {
      data = await API.get('/api/read-acks?target_type=' + encodeURIComponent(type) + '&target_id=' + id);
    } catch (e) {
      if (bodyEl) bodyEl.innerHTML = '<span class="text-muted">已阅信息加载失败，请<a href="javascript:Pages.loadAck(\'' + type + '\',' + id + ',\'' + instance + '\')">重试</a></span>';
      return;
    }
    if (!data.requireAck) {
      if (countEl) countEl.textContent = '无需确认';
      if (bodyEl) bodyEl.innerHTML = '<span class="text-muted">本帖无需已阅确认</span>';
      return;
    }
    const read = data.read || [];
    const unread = data.unread || [];
    const readOthers = data.readOthers || [];
    // 计数以「应阅池」为基准（与列表缩略一致）：优先用后端 pool 口径 acked/total
    const acked = (data.acked !== undefined) ? data.acked : read.length;
    const total = (data.total !== undefined) ? data.total : (read.length + unread.length);
    if (countEl) countEl.textContent = acked + '/' + total;
    // 当前用户是否已阅（池内 + 池外点击者都算，用于按钮显示「你已阅」）
    const myName = (App.user && App.user.realName) || '';
    const iAcked = read.some(r => r.real_name === myName) || readOthers.some(r => r.real_name === myName);
    if (btnEl) {
      if (iAcked) { btnEl.textContent = '✓ 你已阅'; btnEl.disabled = true; btnEl.classList.add('btn-done'); }
      else { btnEl.textContent = '我已阅'; btnEl.disabled = false; btnEl.classList.remove('btn-done'); }
    }
    if (!bodyEl) return;
    // 当前用户是否真在应阅池（后端以 pool 判定；前端兜底：出现在 read/unread 任一即视为在池）
    const meInPool = data.meInPool !== undefined ? !!data.meInPool
      : (read.some(r => r.real_name === myName) || unread.some(u => u.real_name === myName));
    const meAcked = data.meAcked !== undefined ? !!data.meAcked : iAcked;
    // 名单里给本人名字加「(我)」小括号标记（不改写真实姓名）
    const nameHtml = (name, opts) => {
      const isMe = name === myName;
      const cls = 'ack-name' + (opts.unread ? ' ack-unread' : '') + (isMe ? ' ack-self' : '');
      const extra = opts.division ? ' <span class="ack-div">·' + esc(opts.division) + '</span>' : '';
      const me = isMe ? ' <span class="ack-self-badge">(我)</span>' : '';
      return '<span class="' + cls + '">' + esc(name) + extra + me + '</span>';
    };
    let html = '';
    // 软提醒：当前用户是应阅人时的轻提示（非弹窗、非站内提醒，与「提醒未阅」硬提醒并存互补）
    if (meInPool) {
      html += meAcked
        ? '<div class="ack-self-note ack-self-done">你在应阅人员名单中 · 已阅读 ✓</div>'
        : '<div class="ack-self-note">📌 你在应阅人员名单中，应当阅读此帖</div>';
    }
    html += '<div class="ack-sec"><div class="ack-sec-t">已阅 ' + read.length + ' 人（应阅名单）</div>';
    html += read.length
      ? '<div class="ack-names">' + read.map(r => nameHtml(r.real_name, { unread: false })).join('') + '</div>'
      : '<div class="text-muted">暂无</div>';
    html += '</div>';
    if (readOthers.length) {
      html += '<div class="ack-sec mt8"><div class="ack-sec-t">其他点击已阅 ' + readOthers.length + ' 人 <span class="ack-note">（非应阅人，不计入统计）</span></div>';
      html += '<div class="ack-names">' + readOthers.map(r => nameHtml(r.real_name, { unread: false })).join('') + '</div>';
      html += '</div>';
    }
    html += '<div class="ack-sec mt8"><div class="ack-sec-t">未阅 ' + unread.length + ' 人' + (unread.length ? '（应阅名单）' : '') + '</div>';
    html += unread.length
      ? '<div class="ack-names">' + unread.map(u => nameHtml(u.real_name, { unread: true, division: u.division })).join('') + '</div>'
      : '<div class="text-muted">全部已阅 🎉</div>';
    html += '</div>';
    bodyEl.innerHTML = html;
  };

  // 标记已阅（任意登录用户；游客前端拦截）
  Pages.ackRead = async (type, id, instance) => {
    instance = instance || '';
    if (App.caps.isGuest) return UI.toast('游客无权标记已阅');
    try {
      UI.loading(true);
      await API.post('/api/read-acks', { target_type: type, target_id: id });
      UI.loading(false);
      UI.toast('已标记已阅');
      await Pages.loadAck(type, id, instance);
      // 同步刷新列表缩略栏（如质量库列表背后那一条的「你待阅→你已阅」）
      if (typeof Pages.fillAckCounts === 'function') Pages.fillAckCounts();
    } catch (e) { UI.loading(false); UI.toast(e.message || '操作失败'); }
  };

  // 提醒未阅：给未阅人批量发站内提醒（仅发布人/管理者可触发；后端去重）
  Pages.remindUnread = async (type, id, instance) => {
    instance = instance || '';
    if (!(await UI.confirm('将向所有未阅人发送站内提醒？'))) return;
    try {
      UI.loading(true);
      const r = await API.post('/api/read-acks/remind', { target_type: type, target_id: id });
      UI.loading(false);
      UI.toast(r.message || '已发送提醒');
    } catch (e) { UI.loading(false); UI.toast(e.message || '提醒失败'); }
  };

  Pages.libDetail = async (source, id) => {
    // 删除按钮按「当前用户能否删此条目」精确判断：能删才显示，删不了就藏起（避免点了才报 403）。
    // 后端 DELETE 仍保留 403 兜底，作为最后保险。
    const u = App.user || {};
    try {
      if (source === 'renrenjiang' || source === 'pdca') {
        const it = await API.get('/api/pdca/problems/' + id);
        const parseDivs = (x) => { if (Array.isArray(x)) return x; if (typeof x === 'string' && x) { try { const a = JSON.parse(x); return Array.isArray(a) ? a : []; } catch (e) { return []; } } return []; };
        const dDivs = parseDivs(it.divisions).length ? parseDivs(it.divisions) : (it.division ? [it.division] : []);
        const dSubs = parseDivs(it.sub_divisions).length ? parseDivs(it.sub_divisions) : (it.sub_division ? [it.sub_division] : []);
        const meta = [it.category ? `<span class="tag">${esc(it.category)}</span>` : '', dDivs.length ? `<span>🏢 ${dDivs.map(esc).join('/')}</span>` : '', dSubs.length ? `<span>🔻 ${dSubs.map(s => UI.subDivLabel(s)).join(' / ')}</span>` : '', it.region ? `<span>📍 ${esc(it.region)}</span>` : ''].filter(Boolean).join(' ');
        // 管理者(含 section_leader 与 extraRoles 双身份) 可删任意；设计师仅可删自己上报且未闭环/未解决
        // 游客（纯只读）一律不可删、不可编辑管理备注
        const canManage = !!App.caps.canManage && !App.caps.isGuest;
        const canDel = canManage || isSuperAdmin() || (it.reporter === u.realName && it.status !== 'closed' && it.status !== 'solved');
        // 解决方案 / 做法
        const solHtml = (it.solutions || []).map(s => `
          <div class="sol-item">
            <div class="li-meta"><span>🛠️ 做法 · ${esc(s.created_by)}</span><span>${UI.relTime(s.created_at)}</span></div>
            <div class="sol-content">${esc(s.content)}</div>
            ${(s.photos && s.photos.length) ? `<div style="margin-top:6px">${UI.photoGrid(s.photos)}</div>` : ''}
            ${(s.attachments && s.attachments.length) ? `<div style="margin-top:6px">${UI.attChips(s.attachments)}</div>` : ''}
            ${s.experts ? `<div class="sol-experts">🎓 请教专家：${s.experts.split(',').map(e => `<span class="tag">${esc(e)}</span>`).join('')}</div>` : ''}
          </div>`).join('');
        // 多轮请教专家 / 共议（全部问答）
        const conHtml = (it.consults || []).map(c => {
          const answers = c.answers || [];
          const ansHtml = answerTreeHtml(answers, { interactive: false });
          return `
          <div class="consult-item">
            ${consultQHtml(c, it.description)}
            ${ansHtml}
          </div>`;
        }).join('');
        // 管理者院选备注置顶（全员可见批注内容；仅管理者可编辑）
        const noteHtml = (it.manager_note && String(it.manager_note).trim()) ? UI.noteSectionHtml('pdca', it.id, it.manager_note, it.manager_note_by, it.manager_note_at, canManage) : '';
        UI.modal(esc(it.title), `
          <div class="li-meta" style="margin-bottom:8px">${meta}<span>📣 ${esc(it.reporter || '')}</span><span>状态：${esc(it.status || '')}</span></div>
          ${noteHtml}
          <div class="lib-detail">${esc(it.description || '')}</div>
          ${it.photos && it.photos.length ? UI.photoGrid(it.photos) : ''}
          <hr class="sep">
          <div class="card-sub">🛠️ 解决方案 / 做法</div>
          ${solHtml || '<div class="text-muted">尚未填写</div>'}
          <div class="card-sub mt8">💬 请教专家 / 多轮追问</div>
          ${conHtml || '<div class="text-muted">暂未请教专家</div>'}
          ${it.review ? `
          <hr class="sep">
          <div class="card-sub">📖 复盘 / 回顾</div>
          <div class="sol-content">${esc(it.review.content || '（暂无内容）')}</div>
          ` : ''}
          ${it.ima_media_id ? `<div class="li-meta mt8">${UI.imaTag(['SHARE-知识库','02千里行质量人人讲'], it.ima_url || '')}</div>` : ''}
          ${Pages.ackBlockHtml('pdca', it.id, { requireAck: it.require_ack, canRemind: ((App.caps.canManage && !App.caps.isGuest) || (App.user && it.reporter_user_id === App.user.id)), instance: 'modal', autoOpen: true })}
          ${canDel ? `<button class="btn btn-block btn-danger mt8" onclick="Pages.deleteLibItem('pdca',${it.id})">🗑️ 删除该条目</button>` : ''}
        `, () => { Pages.loadAck('pdca', it.id, 'modal'); });
        return;
      }
      if (source === 'announcement') {
        const a = await API.get('/api/announcements/' + id);
        const scopeTag = a.scope === 'division' && a.division ? `<span class="tag">🏢 ${esc(a.division)}</span>` : '<span class="tag">全院</span>';
        const statusTag = a.status === 'active' ? '<span class="badge badge-warn">公示中</span>' : '<span class="badge">已归档</span>';
        // 公告仅管理者/超级管理员可删（游客纯只读，不可删）
        const canDel = (!!App.caps.canManage && !App.caps.isGuest) || isSuperAdmin();
        const ackCanRemind = (App.caps.canManage && !App.caps.isGuest) || (App.user && a.publisher_id === App.user.id);
        UI.modal(esc(a.title), `
          <div class="li-meta" style="margin-bottom:8px">${scopeTag}${statusTag}<span>📣 ${esc(a.publisher || '')}</span><span>公示至 ${esc((a.expiry_date || '').slice(0, 10) || '长期')}</span></div>
          <div class="lib-detail">${esc(a.content || '')}</div>
          ${UI.photoGrid(a.photos)}
          ${a.attachments && a.attachments.length ? UI.attChips(a.attachments) : ''}
          ${a.ima_synced ? `<div class="li-meta mt8">${UI.imaTag(['SHARE-知识库','00千里行质量公告'], a.ima_url || '')}</div>` : ''}
          ${Pages.ackBlockHtml('announcement', a.id, { requireAck: a.require_ack, canRemind: ackCanRemind, instance: 'modal', autoOpen: true })}
          ${canDel ? `<button class="btn btn-block btn-danger mt8" onclick="Pages.deleteLibItem('announcement',${a.id}, ${a.ima_synced ? 1 : 0})">🗑️ 删除该条目</button>` : ''}
        `, () => { Pages.loadAck('announcement', a.id, 'modal'); });
        return;
      }
      const it = await API.get('/api/quality-dissem/' + id);
      const divs = it.divisions || []; const regs = it.regions || [];
      const meta = [it.category ? `<span class="tag">${esc(it.category)}</span>` : '', divs.length ? `<span>🏢 ${divs.join('/')}</span>` : '', regs.length ? `<span>📍 ${regs.join('/')}</span>` : ''].filter(Boolean).join(' ');
      // 宣贯：管理者(admin/leader/dean/chief)/超级管理员 可删任意；设计师仅可删自己未发布的（游客纯只读不可删）
      const canDel = (!!App.caps.canDeleteDissem && !App.caps.isGuest) || isSuperAdmin() || (it.publisher === u.realName && it.status !== 'active');
      // 宣贯备注：与院选一致，置于条文最上方；全员可见批注内容，仅管理者可编辑（游客不可编辑）
      const noteHtml = (it.manager_note && String(it.manager_note).trim()) ? UI.noteSectionHtml('dissem', it.id, it.manager_note, it.manager_note_by, it.manager_note_at, App.caps.canManage && !App.caps.isGuest) : '';
      const ackCanRemind = (App.caps.canManage && !App.caps.isGuest) || (App.user && it.publisher_id === App.user.id);
      UI.modal(esc(it.title), `
        <div class="li-meta" style="margin-bottom:8px">${meta}<span>📣 ${esc(it.publisher || '')}</span><span>公示至 ${esc((it.expiry_date || '').slice(0, 10) || '长期')}</span></div>
        ${noteHtml}
        <div class="lib-detail">${esc(it.content || '')}</div>
        ${UI.photoGrid(it.photos)}
        ${UI.attChips(it.attachments)}
        ${it.imaUrl ? `<div class="li-meta mt8">${UI.imaTag(['SHARE-知识库','01千里行质量宣贯'], it.imaUrl)}</div>` : ''}
        ${Pages.ackBlockHtml('dissem', it.id, { requireAck: it.require_ack, canRemind: ackCanRemind, instance: 'modal', autoOpen: true })}
        ${canDel ? `<button class="btn btn-block btn-danger mt8" onclick="Pages.deleteLibItem('dissem',${it.id})">🗑️ 删除该条目</button>` : ''}
      `, () => { Pages.loadAck('dissem', it.id, 'modal'); });
    } catch (e) { UI.toast(e.message); }
  };

  Pages.deleteLibItem = async (source, id, imaSync) => {
    if (!(await UI.confirm('确定删除该质量库条目？删除后本系统不可恢复；若已同步 IMA，IMA 端需手动删除。'))) return;
    try {
      UI.loading(true);
      const url = source === 'dissem' ? `/api/quality-dissem/${id}` : source === 'announcement' ? `/api/announcements/${id}` : `/api/pdca/problems/${id}`;
      const r = await API.del(url);
      UI.loading(false);
      UI.toast(r.message || '已删除');
      if (r.ima_media_id || imaSync) UI.toast('⚠️ 该条目已同步 IMA' + (r.ima_media_id ? '（media_id: ' + r.ima_media_id + '）' : '') + '，请在 IMA 客户端手动删除对应内容');
      closeAllModals();
      Pages.workSetTab(workTab);
    } catch (e) { UI.loading(false); UI.toast(e.message || '删除失败'); }
  };

  // 项目工期卡片「最后更新时间」小字（腾讯文档真实修改时间，北京时区展示）
  // 数据来自 GET /api/schedule/owners 关联的 doc_meta 缓存；
  // 尚未同步时给出友好占位，避免卡片看起来残缺。
  function fmtBJTime(ms) {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  }
  function relFromNow(ms) {
    const diff = Date.now() - Number(ms);
    if (isNaN(diff)) return '';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + '小时前';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + '天前';
    return '';
  }
  function docUpdatedLine(o) {
    if (!o || !o.lastModifyTime) {
      return `<div class="doc-updated text-muted">🕒 更新时间待同步…</div>`;
    }
    const t = fmtBJTime(o.lastModifyTime);
    const rel = relFromNow(o.lastModifyTime);
    const who = o.lastModifyName ? esc(o.lastModifyName) : '未知';
    const relStr = rel ? ` · ${rel}` : '';
    return `<div class="doc-updated">🕒 更新于 ${t}${relStr} · ${who}</div>`;
  }

  function paintOwnerGrid(list, myName) {
    const grid = document.getElementById('sch-grid');
    if (!grid) return;
    if (!list.length) { grid.innerHTML = '<p class="text-muted">无匹配设计师</p>'; return; }
    grid.innerHTML = list.map(o => {
      const badge = o.owner === myName ? '<span class="badge badge-mine">我的</span>' : '';
      if (!o.docUrl) {
        return `<div class="doc-card empty-card"><div class="doc-owner">${esc(o.owner)}${badge}</div><div class="doc-url">📄 腾讯文档</div>${docUpdatedLine(o)}<div class="doc-open text-muted">链接待补充</div></div>`;
      }
      return `<a class="doc-card" href="${o.docUrl}" target="_blank" rel="noopener noreferrer"><div class="doc-owner">${esc(o.owner)}${badge}</div><div class="doc-url">📄 腾讯文档</div>${docUpdatedLine(o)}<div class="doc-open">打开 →</div></a>`;
    }).join('');
  }

  // ── 提醒：收件箱 / 发件箱 / 发送 ──────────────────
  // 2026-08-02 简化「我的」消息中心：仅表达「发出 / 收到」站内信内容（标题 + 正文 + 收发人 + 时间），
  // 「标记完成」等管理动作收归管理版面，避免与个人页重复；删除按钮已去除 confirm（微信 WebView 下 confirm 失效）。
  function renderRemind(body, inbox, sent) {
    let html = '';
    const isGuest = App.caps.isGuest;
    // 「我的」只展示纯私信（related_problem_id 为空）；PDCA 流程提醒（被请教/共议邀请）归管理版面待办
    const inboxPure = (inbox || []).filter(r => !r.related_problem_id);
    const sentPure = (sent || []).filter(r => !r.related_problem_id);

    // 收件箱：收到的站内信
    html += '<div class="card-sub mt8">📥 收到的站内信（' + inboxPure.length + '）</div>';
    if (!inboxPure.length) html += '<div class="empty"><div class="ei">✉️</div><div class="et">暂无收到的站内信</div><div class="es">系统通知会第一时间送达这里</div></div>';
    else html += inboxPure.map(r => `
      <div class="remind-item" data-rid="${r.id}">
        <div class="li-head"><div class="li-title">${esc(r.title || '（无标题）')}</div></div>
        ${r.content ? `<div class="li-desc">${esc(r.content)}</div>` : ''}
        <div class="li-meta"><span>📤 ${esc(r.sender_name)}</span><span>${UI.relTime(r.created_at)}</span></div>
        ${isGuest ? '' : `<div class="row-btns mt8"><button class="btn btn-sm btn-outline btn-del" onclick="Pages.reminderDelete(${r.id})">删除</button></div>`}
      </div>`).join('');

    // 我发出的（纯私信）
    html += '<div class="card-sub mt8">📨 发出的站内信（' + sentPure.length + '）</div>';
    if (!sentPure.length) html += '<div class="empty"><div class="ei">✉️</div><div class="et">还没有发出的站内信</div><div class="es">解答同事疑问时发出第一条吧</div></div>';
    else html += sentPure.map(r => `
      <div class="remind-item" data-rid="${r.id}">
        <div class="li-head"><div class="li-title">${esc(r.title || '（无标题）')}</div></div>
        ${r.content ? `<div class="li-desc">${esc(r.content)}</div>` : ''}
        <div class="li-meta"><span>📥 ${esc(r.recipient_name)}</span><span>${UI.relTime(r.created_at)}</span></div>
        ${isGuest ? '' : `<div class="row-btns mt8"><button class="btn btn-sm btn-outline btn-del" onclick="Pages.reminderDelete(${r.id})">删除</button></div>`}
      </div>`).join('');

    body.innerHTML = html;
  }

  // 收件箱 / 发件箱 面板：供「我的」页挂载（激活此前未挂接的 renderRemind）
  Pages.remindersPanel = async function (containerId) {
    const body = document.getElementById(containerId);
    if (!body) return;
    body.innerHTML = '<div class="empty"><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div></div>';
    let inbox = [], sent = [];
    try {
      [inbox, sent] = await Promise.all([
        API.get('/api/reminders/inbox').catch(() => []),
        API.get('/api/reminders/sent').catch(() => []),
      ]);
    } catch (e) { /* 容错 */ }
    renderRemind(body, inbox || [], sent || []);
  };

  Pages.reminderDone = async (id) => {
    try { UI.loading(true); await API.post(`/api/reminders/${id}/done`, {}); UI.toast('已标记完成'); if (App.updateReminderBadge) App.updateReminderBadge(); if (location.hash === '#/profile') Pages.profile(); else if (location.hash === '#/admin') Pages.admin(); else Pages.work(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  Pages.reminderDelete = async (id) => {
    // 注意：原实现带 confirm()，但微信 WebView 下 confirm 对话框被抑制导致「按了无效果」，
    // 2026-08-02 改为直接删除（删除为可逆—对方侧若未删仍可见），并去掉 confirm。
    try { UI.loading(true); await API.del(`/api/reminders/${id}`); UI.toast('已删除'); if (App.updateReminderBadge) App.updateReminderBadge(); if (location.hash === '#/profile') Pages.profile(); else if (location.hash === '#/admin') Pages.admin(); else Pages.work(); }
    catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
  };

  async function openReminderSender(prefill = {}) {
    let users = [];
    try { users = await API.get('/api/reminders/users'); } catch (e) { UI.toast(e.message); }
    const opts = users.length
      ? users.map(u => `<option value="${u.id}">${esc(u.real_name)}</option>`).join('')
      : '<option value="">（无可选人员）</option>';
    UI.modal(prefill.id ? '传送备忘' : '发提醒', `
      <div class="field"><label>接收人<span class="req">*</span></label><select class="input" id="rm-rec">${opts}</select></div>
      <div class="field"><label>标题</label><input class="input" id="rm-title" value="${esc(prefill.title || '')}" placeholder="如：请校核建筑图"></div>
      <div class="field"><label>内容</label><textarea class="textarea" id="rm-content" placeholder="提醒详情…">${esc(prefill.content || '')}</textarea></div>
      <button class="btn btn-block btn-lg" id="rm-sub">发送</button>
    `, (mask, close) => {
      mask.querySelector('#rm-sub').onclick = async () => {
        const recipient_id = mask.querySelector('#rm-rec').value;
        if (!recipient_id) return UI.toast('请选择接收人');
        const body = {
          recipient_id: Number(recipient_id),
          title: mask.querySelector('#rm-title').value.trim(),
          content: mask.querySelector('#rm-content').value.trim(),
        };
        try {
          UI.loading(true);
          await API.post('/api/reminders', body);
          close(); UI.toast('已发送'); workTab = 'library'; if (location.hash === '#/profile') Pages.profile(); else if (location.hash === '#/admin') Pages.admin(); else Pages.work();
        } catch (e) { UI.toast(e.message); } finally { UI.loading(false); }
      };
    });
  }
  Pages.openReminderSender = openReminderSender;

  Pages.pdca = pdca;
  Pages.work = Pages.work;
})();
