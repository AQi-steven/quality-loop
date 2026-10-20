/**
 * 质量库问答索引器（2026-10-11）
 *
 * Phase 1 = 纯 FTS5 检索（无 LLM）：把质量库已发布内容 + 可抽取正文的附件写入 qa_fts（trigram 分词）。
 * 检索在 routes/qa.js；本文件只负责「重建索引」。
 *
 * 索引范围（与质量库 tab 的可见口径一致：使用者均为 canDesign/canManage 管理者，
 * 公告/宣贯的 division 范围帖对全部管理者可见，故不存在越权泄露）：
 *   - announcements      status IN (active, archived)      kind='公告'
 *   - quality_dissem     status IN (active, archived)      kind='宣贯'
 *   - quality_topics     status='active'                   kind='质量专题'
 *   - quality_topic_posts status='published'               kind='专题动态'
 *   - pdca_problems      全部                              kind='PDCA'
 *   - 附件：docx/xlsx/txt 抽正文（独立条目 kind='附件'，route 指向父级）；
 *           pdf/doc/dwg/图片等暂无服务器端解析器 → 仅把文件名并入父级正文（诚实不装）。
 *
 * trigram 说明：≥3 字走 MATCH（精确子串），1~2 字在 routes/qa.js 里走 LIKE 兜底（语料小，全表扫可接受）。
 *
 * CLI：node src/qa_index.js   （在服务器上手动重建；应用内管理者也有 POST /api/qa/rebuild）
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const db = require('./db/connection');

const UPLOADS = path.join(__dirname, '..', 'uploads');
const MAX_BODY_CHARS = 200000;   // 单条目正文入库上限（字符），防超大附件拖爆索引
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB 以上附件不抽取正文

function stripXml(xml) {
  return String(xml)
    .replace(/<w:p[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function unzipEntry(fp, entry) {
  // unzip 对字面反斜杠条目名不匹配 → 分隔符换成通配符 ?（匹配任意单字符，含 \ 和 /）
  const pat = String(entry).replace(/[\\/]/g, '?');
  const { stdout } = await execFileP('unzip', ['-p', fp, pat], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  return stdout;
}

// 解析 zip 内真实条目名：WPS 等非标准包会用反斜杠路径（xl\sharedStrings.xml），
// unzip 按正斜杠名匹配不到 → 先 -Z1 列出全部条目名，按正则容错匹配（/ 或 \ 均可）。
async function resolveEntry(fp, re) {
  const { stdout } = await execFileP('unzip', ['-Z1', fp], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  const names = stdout.split(/\r?\n/).filter(Boolean);
  return names.find(n => re.test(n)) || null;
}

async function extractDocx(fp) {
  try {
    const entry = await resolveEntry(fp, /^word[/\\]document\.xml$/i);
    if (!entry) return '';
    return stripXml(await unzipEntry(fp, entry));
  } catch (e) { console.warn('[qa] docx extract fail:', path.basename(fp), e.message); return ''; }
}

async function extractXlsx(fp) {
  try {
    const entry = await resolveEntry(fp, /^xl[/\\]sharedStrings\.xml$/i);
    if (!entry) return ''; // 无共享字符串表（全 inline string / 空表）：如实返回空
    const xml = await unzipEntry(fp, entry);
    const strs = (xml.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, ''));
    return strs.join('\n').trim();
  } catch (e) { console.warn('[qa] xlsx extract fail:', path.basename(fp), e.message); return ''; }
}

async function extractTxt(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.size > MAX_FILE_BYTES) return '';
    return stripXml(fs.readFileSync(fp, 'utf8'));
  } catch (e) { return ''; }
}

// attachments JSON → [{url,name}]；容错各种历史脏形态
function parseAttachments(raw) {
  if (!raw) return [];
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { return []; } }
  if (!Array.isArray(a)) return [];
  return a.filter(x => x && x.url).map(x => ({ url: String(x.url), name: String(x.name || x.url) }));
}

function localPath(url) {
  const m = String(url || '').match(/^\/uploads\/(.+)$/);
  if (!m) return null;
  const fp = path.join(UPLOADS, ...m[1].split('/'));
  // 防目录穿越
  if (!path.resolve(fp).startsWith(path.resolve(UPLOADS))) return null;
  return fp;
}

async function buildDocs() {
  const docs = [];
  const push = (kind, refId, title, body, author, route, updatedAt) => {
    if (!body) body = '';
    docs.push({ kind, ref_id: String(refId), title: String(title || ''), body: String(body).slice(0, MAX_BODY_CHARS), author: String(author || ''), route: String(route || ''), updated_at: String(updatedAt || '') });
  };

  // 公告（管理者可见 active+archived；deleted 不进索引）
  for (const r of db.prepare("SELECT * FROM announcements WHERE status IN ('active','archived')").all()) {
    const atts = parseAttachments(r.attachments);
    const names = atts.map(a => a.name).join('；');
    push('公告', r.id, r.title, [r.content, names].filter(Boolean).join('\n'), '', 'ann:' + r.id, r.updated_at || r.created_at || '');
    for (const a of atts) await pushAttachment(a, '公告', r.id, r.title || '', 'ann:' + r.id, r.updated_at || r.created_at || '');
  }

  // 宣贯
  for (const r of db.prepare("SELECT * FROM quality_dissem WHERE status IN ('active','archived')").all()) {
    const atts = parseAttachments(r.attachments);
    const names = atts.map(a => a.name).join('；');
    push('宣贯', r.id, r.title, [r.content, names].filter(Boolean).join('\n'), r.author_name || r.creator_name || '', 'dis:' + r.id, r.updated_at || r.created_at || '');
    for (const a of atts) await pushAttachment(a, '宣贯', r.id, r.title || '', 'dis:' + r.id, r.updated_at || r.created_at || '');
  }

  // 质量专题（仅 active；draft/archived 不可见不进索引）
  for (const r of db.prepare("SELECT * FROM quality_topics WHERE status='active'").all()) {
    push('质量专题', r.id, r.title, [r.summary, r.description].filter(Boolean).join('\n'), r.owner_name || '', 'topic:' + r.id, r.updated_at || '');
  }

  // 专题动态
  for (const r of db.prepare("SELECT * FROM quality_topic_posts WHERE status='published'").all()) {
    const atts = parseAttachments(r.attachments);
    const names = atts.map(a => a.name).join('；');
    push('专题动态', r.id, r.title, [r.content, names].filter(Boolean).join('\n'), r.author_name || '', 'topic:' + r.topic_id, r.updated_at || r.created_at || '');
    for (const a of atts) await pushAttachment(a, '专题动态', r.id, r.title || '', 'topic:' + r.topic_id, r.updated_at || r.created_at || '');
  }

  // PDCA（全员可见的问题条目）
  for (const r of db.prepare('SELECT * FROM pdca_problems').all()) {
    const atts = parseAttachments(r.attachments);
    const names = atts.map(a => a.name).join('；');
    push('PDCA', r.id, r.title, [r.description, r.memo, names].filter(Boolean).join('\n'), r.owner || r.reporter || '', 'pdca:' + r.id, r.updated_at || r.created_at || '');
  }

  return docs;

  async function pushAttachment(a, parentKind, parentId, parentTitle, route, updatedAt) {
    const fp = localPath(a.url);
    if (!fp || !fs.existsSync(fp)) return;
    // 体积门提前到「抽取前」（2026-10-18 排雷修复）：
    // 旧代码先跑 unzip 抽正文、抽完才查大小——超大 docx/xlsx 的 unzip 子进程（30s 超时/64MB 缓冲）已经跑完才被跳过，
    // 体积门形同虚设。超大附件只靠「文件名已并入父级正文」参与检索，不建独立条目、不抽正文。
    const st = fs.statSync(fp);
    if (st.size > MAX_FILE_BYTES) {
      console.warn('[qa] 跳过超大附件（仅文件名参与检索）：', path.basename(fp), (st.size / 1048576).toFixed(1) + 'MB');
      return;
    }
    const ext = (a.url.split('?')[0].split('.').pop() || '').toLowerCase();
    let body = '';
    if (ext === 'docx') body = await extractDocx(fp);
    else if (ext === 'xlsx' || ext === 'xls') body = await extractXlsx(fp);
    else if (ext === 'txt' || ext === 'md') body = await extractTxt(fp);
    // pdf/doc/dwg/图片等：服务器暂无解析器，正文不索引（文件名已并入父级），不建独立条目 —— 不编造能力范围。
    if (!body) return;
    push('附件', parentId + ':' + a.url, a.name + '（' + parentKind + '·' + parentTitle + '）', body, '', route, updatedAt);
  }
}

async function rebuildIndex() {
  const started = Date.now();
  const docs = await buildDocs();
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    db.prepare("DELETE FROM qa_fts").run();
    const ins = db.prepare('INSERT INTO qa_fts(kind, ref_id, title, body, author, route, updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const d of docs) ins.run(d.kind, d.ref_id, d.title, d.body, d.author, d.route, d.updated_at);
    db.prepare('COMMIT').run();
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch (e2) {}
    throw e;
  }
  const byKind = {};
  for (const d of docs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  const stats = { total: docs.length, byKind, ms: Date.now() - started };
  console.log('[qa] index rebuilt:', JSON.stringify(stats));
  return stats;
}

module.exports = { rebuildIndex };

if (require.main === module) {
  rebuildIndex()
    .then(s => { console.log('[qa] done', JSON.stringify(s)); process.exit(0); })
    .catch(e => { console.error('[qa] rebuild failed:', e && e.stack || e); process.exit(1); });
}
