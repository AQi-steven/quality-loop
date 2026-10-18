/**
 * 质量库问答路由（2026-10-12，Phase 2：FTS5 检索 + TokenHub hy3 生成）
 *
 *   GET  /api/qa/search?q=<关键词>&limit=   检索（canDesign/canManage 同质量库 tab 口径）
 *   POST /api/qa/ask       { q }            AI 问答：先检索取资料片段，再交 LLM 生成答案（用户已批准数据出境，2026-10-11）
 *   POST /api/qa/rebuild                    重建索引（仅 canManage）
 *   GET  /api/qa/status                     库问答总开关状态 { ai_enabled, can_toggle }（2026-10-12）
 *   POST /api/qa/ai-toggle { enabled }      库问答总开关切换（仅超级管理员，2026-10-12）
 *
 * 总开关语义（2026-10-12 用户二次裁定）：关=整个库问答（检索+AI 全关），
 * 超级管理员本人不受限（便于确认状态/验证），其他任何人 search/ask 都被拦。
 *
 * 检索策略（trigram 分词）：
 *   - 全部词 ≥3 字 → FTS5 MATCH（短语 AND，bm25 排序 + snippet 高亮）
 *   - 含 1~2 字短词 → LIKE 兜底（语料小全表扫可接受；ESCAPE 转义 %/_）
 * 索引内容与重建逻辑见 src/qa_index.js。
 *
 * LLM 侧约定（cybio 同款实测结论，勿改）：
 *   - TokenHub OpenAI 兼容：POST {LLM_BASE_URL}/chat/completions，Bearer key
 *   - 模型链：LLM_MODEL 失败（额度/超时/空回复/HTTP 异常）自动切 LLM_FALLBACK_MODELS 依次尝试，全挂才降级
 *   - 推理模型：不设 max_tokens（reasoning_content 会吃大量 token，
 *     设小了 content 被截断），不要传 tools（上游 502）
 *   - 密钥经 server/.env 注入（env.js 加载器），不落源码
 */

const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');
const { rebuildIndex } = require('../qa_index');

const router = express.Router();
router.use(authMiddleware);

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://YOUR-LLM-GATEWAY/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'GLM-5.3-Flash';
// 模型链（2026-10-12）：主模型额度用尽/失败时依次尝试备选，全挂才降级。
// 实测 TokenHub 免费体验包可用：GLM-5.3-Flash / DeepSeek-V4-Flash / GLM-5-Turbo / Kimi-K2.6（2026-10-12 逐一 curl 验证）
// 可用 LLM_FALLBACK_MODELS 环境变量覆盖（逗号分隔）。
const LLM_MODEL_CHAIN = [LLM_MODEL, ...(process.env.LLM_FALLBACK_MODELS || 'DeepSeek-V4-Flash,GLM-5-Turbo,Kimi-K2.6')
  .split(',').map(s => s.trim()).filter(Boolean)]
  .filter((m, i, a) => a.indexOf(m) === i);

// ── 库问答总开关（2026-10-12 用户需求，二次裁定）：仅超级管理员可切换，状态存 app_settings.qa_ai_enabled ──
// 关=整个库问答（关键词检索 + AI）对其他人全关；超级管理员本人不受限（便于确认状态与验证）。
// 超级管理员判断：仅按 username（示例值 'superadmin'，部署时改为你的超管用户名）。
function isSuperAdmin(u) { return !!(u && u.username === 'superadmin'); }
function getAiEnabled() {
  try {
    const r = db.prepare("SELECT value FROM app_settings WHERE key = 'qa_ai_enabled'").get();
    return !r || r.value !== '0';   // 无记录/表缺失 → 默认开启
  } catch (e) { return true; }
}

function me(req) {
  return db.prepare('SELECT id, role, extra_roles, division, username, real_name FROM users WHERE id = ?').get(req.user.id);
}

function canQa(u) { return rbac.canDesign(u) || rbac.canManage(u); }

/**
 * 检索核心。full=false 时 snip 为 snippet 高亮片段（给检索结果页）；
 * full=true 时返回 body 正文前 bodyCap 字（给 LLM 上下文）。
 */
function searchRows(q, limit, full, bodyCap) {
  const toks = q.split(/\s+/).filter(Boolean).slice(0, 8);
  if (!toks.length) return [];
  const cols = full
    ? 'kind, ref_id, title, substr(body, 1, ?) AS body, author, route, updated_at'
    : "kind, ref_id, title, snippet(qa_fts, 3, '[', ']', '…', 14) AS snip, author, route, updated_at, bm25(qa_fts) AS rank";
  const allLong = toks.every(t => [...t].length >= 3);
  if (allLong) {
    const match = toks.map(t => '"' + t.replace(/"/g, ' ') + '"').join(' ');
    if (full) {
      return db.prepare(`SELECT ${cols} FROM qa_fts WHERE qa_fts MATCH ? ORDER BY bm25(qa_fts) LIMIT ?`).all(bodyCap, match, limit);
    }
    return db.prepare(`SELECT ${cols} FROM qa_fts WHERE qa_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit);
  }
  // 1~2 字短词：LIKE 全表扫（trigram 对 <3 字查询不命中；语料 <100 条，可接受）
  const conds = [];
  const params = [];
  for (const t of toks) {
    const esc = t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    conds.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    params.push('%' + esc + '%', '%' + esc + '%');
  }
  const order = full ? 'updated_at DESC' : 'updated_at DESC';
  return db.prepare(`SELECT ${cols} FROM qa_fts WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...(full ? [bodyCap, ...params, limit] : [...params, limit]));
}

router.get('/search', (req, res) => {
  const u = me(req);
  if (!canQa(u)) return res.status(403).json({ error: '无质量库访问权限' });
  // 总开关关闭：非超级管理员连关键词检索都拦（200+ok:false，前端不丢 body）
  if (!getAiEnabled() && !isSuperAdmin(u)) {
    return res.json({ ok: false, disabled: true, error: '库问答已临时关闭（管理员开关）', total: 0, hits: [] });
  }

  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ q, total: 0, hits: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 30);

  const rows = searchRows(q, limit, false);
  const hits = rows.map(r => ({
    kind: r.kind,
    ref_id: r.ref_id,
    title: r.title || '(无标题)',
    snip: (r.snip || '').replace(/\s+/g, ' ').trim() || r.title || '',
    author: r.author || '',
    route: r.route || '#/work',
    updated_at: r.updated_at || '',
  }));
  res.json({ q, total: hits.length, hits });
});

// ── AI 问答（Phase 2）────────────────────────────────────────
// 流程：检索 top N 资料片段 → 拼 prompt → TokenHub hy3 生成 → 返回答案+来源。
// 答案要求引用资料编号、资料没有就如实说未找到 —— 抑制编造。
/**
 * 自然语言兜底：FTS 短语对整句问句（无分词）容易 0 命中。
 * 全库扫描（语料 <100 条，毫秒级），按 2-gram IDF 相关度打分取 top N。
 */
function scoreFallback(q, limit, bodyCap) {
  const s = q.replace(/\s+/g, '');
  if ([...s].length < 2) return [];
  const uniq = [...new Set(s.match(/.{2}/g) || [])];
  if (!uniq.length) return [];
  const rows = db.prepare('SELECT kind, ref_id, title, substr(body, 1, ?) AS body, author, route, updated_at FROM qa_fts').all(bodyCap);
  const df = {};
  const docs = rows.map(r => {
    const txt = (r.title || '') + '\n' + (r.body || '');
    const hits = uniq.filter(g => txt.includes(g));
    for (const g of hits) df[g] = (df[g] || 0) + 1;
    return { r, hits };
  });
  return docs
    .map(({ r, hits }) => ({ r, sc: hits.reduce((n, g) => n + 1 / Math.log(2 + (df[g] || 1)), 0) }))
    .filter(x => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .map(x => x.r);
}

router.get('/status', (req, res) => {
  const u = me(req);
  if (!canQa(u)) return res.status(403).json({ error: '无质量库访问权限' });
  res.json({ ai_enabled: getAiEnabled(), can_toggle: isSuperAdmin(u) });
});

router.post('/ai-toggle', (req, res) => {
  const u = me(req);
  if (!canQa(u)) return res.status(403).json({ error: '无质量库访问权限' });
  if (!isSuperAdmin(u)) return res.status(403).json({ error: '仅超级管理员可切换库问答开关' });
  const enabled = !!(req.body && req.body.enabled);
  db.prepare("INSERT INTO app_settings(key, value) VALUES('qa_ai_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(enabled ? '1' : '0');
  console.log('[qa] ai toggle →', enabled ? 'ON' : 'OFF', 'by', u.username || u.id);
  res.json({ ok: true, ai_enabled: enabled });
});

router.post('/ask', async (req, res) => {
  const u = me(req);
  if (!canQa(u)) return res.status(403).json({ error: '无质量库访问权限' });

  const q = String((req.body && req.body.q) || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: '问题不能为空' });
  if (!getAiEnabled() && !isSuperAdmin(u)) return res.json({ ok: false, reason: 'ai_disabled', error: '库问答已临时关闭（管理员开关）' });
  if (!LLM_API_KEY) return res.json({ ok: false, reason: 'llm_not_configured' });

  const N = 8;
  const BODY_CAP = 1200;
  let rows = searchRows(q, N, true, BODY_CAP);
  if (!rows.length) rows = scoreFallback(q, N, BODY_CAP);
  if (!rows.length) return res.json({ ok: true, no_hits: true, answer: '', sources: [] });
  // 降级说明：LLM 失败（额度/超时/空回复）时返回 200 + ok:false + sources ——
  // 前端 API 封装对非 2xx 会 throw 并丢弃 body 里的 sources（2026-10-12 实测教训），
  // 降级是预期结果而非传输错误，必须走 200。
  const srcRows = () => rows.map(r => ({ kind: r.kind, ref_id: r.ref_id, title: r.title || '(无标题)', route: r.route || '#/work' }));

  const ctx = rows.map((r, i) => `【资料${i + 1}】(${r.kind})《${r.title || '无标题'}》\n${String(r.body || '').replace(/\s+/g, ' ').trim()}`).join('\n\n');
  const system = '你是本院「质量千里行」质量库的问答助手。只依据下方资料回答问题；回答中注明依据的资料编号（如：依据资料2）。资料里没有的内容，如实回答「质量库中未找到相关内容」，严禁编造、严禁使用资料以外的知识补充。用简体中文，简洁分点，总长不超过300字。';
  const user = `资料：\n${ctx}\n\n问题：${q}`;

  // 单模型调用：返回 { ok:true, answer } 或 { ok:false, kind:'quota'|'http'|'timeout'|'empty'|'error', status, detail }
  async function callLLM(model) {
    try {
      const r = await fetch(LLM_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_API_KEY },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          // 注意：不设 max_tokens —— 推理模型 reasoning_content 吃掉大量 token，
          // 设小了 content 会被截断（cybio 实测复现过）。
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.error('[qa/ask] LLM', model, 'HTTP', r.status, t.slice(0, 200));
        let quota = false;
        try {
          const ej = JSON.parse(t);
          const code = ej && ej.error && ej.error.code;
          const emsg = (ej && ej.error && ej.error.message) || '';
          // 402/permission = 额度用尽（2026-10-12 实测：TokenHub 免费额度耗尽报 402/401008）
          quota = r.status === 402 || code === '401008' || /quota|billing/i.test(emsg);
        } catch (_) {}
        return { ok: false, kind: quota ? 'quota' : 'http', status: r.status, detail: t.slice(0, 200) };
      }
      const j = await r.json();
      const answer = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
      if (!answer.trim()) return { ok: false, kind: 'empty' };
      return { ok: true, answer: answer.trim() };
    } catch (e) {
      if (e && e.name === 'TimeoutError') return { ok: false, kind: 'timeout' };
      return { ok: false, kind: 'error', detail: String(e && e.message || e) };
    }
  }

  // 模型链依次尝试：额度用尽 / 超时 / 空回复 / HTTP 异常都切下一个（2026-10-12 用户需求）。
  let lastFail = null;
  for (const model of LLM_MODEL_CHAIN) {
    const r = await callLLM(model);
    if (r.ok) {
      res.json({ ok: true, answer: r.answer, sources: srcRows(), model });
      return;
    }
    lastFail = { model, ...r };
  }

  // 全部模型失败 → 降级（永远 200 + ok:false + sources，见上方注释）
  const tried = lastFail ? LLM_MODEL_CHAIN.join('、') : '';
  let msg;
  if (lastFail && lastFail.kind === 'quota') {
    msg = 'AI 各模型额度均已用尽（已依次尝试：' + tried + '），需在腾讯云控制台 TokenHub 开通后付费（下方已列出相关资料）';
  } else if (lastFail && lastFail.kind === 'timeout') {
    msg = 'AI 生成超时，可参考下方相关资料';
  } else {
    msg = 'AI 服务暂不可用（' + tried + '），可参考下方相关资料';
  }
  console.error('[qa/ask] all models failed:', JSON.stringify(lastFail));
  res.json({ ok: false, error: msg, sources: srcRows(), models_tried: LLM_MODEL_CHAIN });
});

router.post('/rebuild', async (req, res) => {
  const u = me(req);
  if (!rbac.canManage(u)) return res.status(403).json({ error: '仅管理者可重建索引' });
  try {
    const stats = await rebuildIndex();
    res.json({ ok: true, stats });
  } catch (e) {
    console.error('[qa] rebuild via api failed:', e && e.stack || e);
    res.status(500).json({ error: e && e.message ? e.message : '重建失败' });
  }
});

module.exports = router;
