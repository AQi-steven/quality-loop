/**
 * IMA OpenAPI 推送模块
 *
 * 用途：把 公告 / 质量宣贯 / 质量人人讲 的文字与附件，同步进 IMA 知识库
 *        SHARE-知识库 → 001本院质量管理 → 000千里行质量库 下的对应文件夹：
 *          - 质量人人讲：02千里行质量人人讲（folder_7484947686243197）
 *          - 质量宣贯：  01千里行质量宣贯  （folder_7484947635919809）
 *          - 质量公告：  00千里行质量公告 （folder_7485654854287300）  ← 新增
 *
 * 推送内容：
 *   1) 文字 → 始终额外生成一份 Word 文档（文件名 = 日期 + 正文首句），作为 WORD 类型入库；
 *   2) 用户上传的附件 / 现场照片 → 作为各自原生类型（PDF/Word/Excel/图片…）入库。
 *
 * 凭证：优先环境变量 IMA_CLIENT_ID/IMA_API_KEY（部署），兜底 ~/.config/ima/{client_id,api_key}（开发）。
 * 文件上传流程：create_media（拿 media_id + COS 临时凭证）→ PUT 文件到腾讯云 COS → add_knowledge（进指定文件夹）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db/connection');

const KB_ID = 'BfLhkKxZJUDBCxIbWn_pP8e5KFlQYBJIIWNq0LhvCXg=';
// 千里行质量库 → 02千里行质量人人讲（PDCA 复盘入库目标）
const FOLDER_ID = 'folder_7484947686243197';
const FOLDER_NAME = '质量人人讲';
const KB_NAME = 'SHARE-知识库';
// 千里行质量库 → 03千里行质量人人讲院选（院选后再推送的目标，与 00/01/02 平级，
//   统一位于「000千里行质量库」下：IMA根目录 → 001本院质量管理 → 000千里行质量库 → 03千里行质量人人讲院选）
const RENRENJIANG_SELECTED_FOLDER_NAME = '03千里行质量人人讲院选';
// 院选文件夹定位：优先用已确知的文件夹 id（发现于 IMA，位于「000千里行质量库」下），
// 避免 create_folder 落点不确定又建到根目录（原根目录文件夹已被手动删除）。
const RENRENJIANG_SELECTED_PARENT = process.env.IMA_RRJ_SELECTED_PARENT || 'folder_7484946830616633'; // 000千里行质量库
const RENRENJIANG_SELECTED_FOLDER_ID = process.env.IMA_RRJ_SELECTED_FOLDER_ID || 'folder_7487007085312374'; // 已确知、位于 000千里行质量库 下
let _selectedRenrenjiangFolderId = null;
async function selectedRenrenjiangFolderId() {
  if (_selectedRenrenjiangFolderId) return _selectedRenrenjiangFolderId;
  // 优先直接用已确知的文件夹 id（确定性强、不会误建到根目录）
  if (RENRENJIANG_SELECTED_FOLDER_ID) { _selectedRenrenjiangFolderId = RENRENJIANG_SELECTED_FOLDER_ID; return _selectedRenrenjiangFolderId; }
  // 兜底：按名在「000千里行质量库」下检索 / 重建
  _selectedRenrenjiangFolderId = await ensureImaFolder(RENRENJIANG_SELECTED_PARENT, RENRENJIANG_SELECTED_FOLDER_NAME);
  return _selectedRenrenjiangFolderId;
}
// 千里行质量库（SHARE-知识库 → 001本院质量管理 → 000千里行质量库）
const QUALITY_KB_ID = process.env.IMA_QUALITY_KB_ID || KB_ID;
// 千里行质量库 → 01千里行质量宣贯（质量宣贯入库目标）
const QUALITY_FOLDER_ID = process.env.IMA_QUALITY_FOLDER_ID || 'folder_7484947635919809';
// 千里行质量库 → 00千里行质量公告（公告入库目标）
const ANNOUNCEMENT_FOLDER_ID = process.env.IMA_ANNOUNCEMENT_FOLDER_ID || 'folder_7485654854287300';
// 项目备忘 IMA（20260802 调整）：原「009千里行项目备忘」文件夹废弃；原「SHARE-本院项目信息备忘库」新库已删除。
// 现改为：每个项目在「SHARE-知识库」KB 根目录按「项目名」自动建一个文件夹（create_folder 忽略 parent，落到根），
// 该项目的所有已发布备忘的 docx+附件+图片平铺进此项目文件夹。
// KB_ID 仍为 SHARE-知识库 —— 用户把其整体移入「质量信息总库」仅改变 IMA 视觉层级，KB 本身不变，
// 00公告/01宣贯/02人人讲/03人人讲院选 及各地区文件夹的 folder_id 均保留不变（移动文件夹不更 media_id）。

// ── 地区宣贯（客户规定·输变电）附件路由 ─────────────
// 命中以下地区的宣贯，一旦发布：文字进「01千里行质量宣贯」(QUALITY_FOLDER_ID)，
// 附件/照片则分别进 SHARE 库 → 003客户规定 → 输变电 下的对应地区文件夹。
// 注：雄安行政区属河北，故映射到「河北（…）」文件夹。
const TRANSUB_PARENT = 'folder_7449274983916021'; // 输变电（003客户规定 之下）
const SPECIAL_REGIONS = ['山东', '雄安', '上海', '安徽'];
const REGION_FOLDER_MAP = {
  '山东': 'folder_7449270156267296',
  '雄安': 'folder_7449270194020935',
  '上海': 'folder_7449270114331400', // 上海（×××、×××）
  '安徽': 'folder_7449270173043610',
};

// 懒加载重依赖：即使未安装也不影响主服务启动，仅在真正调用 IMA 上传时失败（会被上层 try/catch 兜住）
let _COS = null, _DOCX = null;
function getCOS() { if (!_COS) _COS = require('cos-nodejs-sdk-v5'); return _COS; }
function getDocx() { if (!_DOCX) _DOCX = require('docx'); return _DOCX; }

// ── 凭证 ────────────────────────────────────────
function readCred(envName, filePath) {
  if (process.env[envName]) return process.env[envName].trim();
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch (e) { return ''; }
}
const CID_FILE = path.join(os.homedir(), '.config/ima/client_id');
const KEY_FILE = path.join(os.homedir(), '.config/ima/api_key');

function creds() {
  const clientId = readCred('IMA_CLIENT_ID', CID_FILE);
  const apiKey = readCred('IMA_API_KEY', KEY_FILE);
  if (!clientId || !apiKey) {
    throw new Error('未找到 IMA 凭证：请配置环境变量 IMA_CLIENT_ID/IMA_API_KEY，或本地放置 ~/.config/ima/{client_id,api_key} 文件');
  }
  return { clientId, apiKey };
}

async function imaPost(apiPath, body) {
  const { clientId, apiKey } = creds();
  const res = await fetch(`https://ima.qq.com/${apiPath}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': clientId,
      'ima-openapi-apikey': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── 文件类型映射 ─────────────────────────────────
const EXT_MEDIA = {
  pdf: 1, doc: 3, docx: 3, wps: 3, rtf: 3,
  ppt: 4, pptx: 4,
  xls: 5, xlsx: 5, csv: 5,
  md: 7, markdown: 7,
  jpg: 9, jpeg: 9, png: 9, gif: 9, webp: 9, bmp: 9,
  txt: 13, xmind: 14,
};
const EXT_CT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  md: 'text/markdown', markdown: 'text/markdown',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  txt: 'text/plain', xmind: 'application/x-xmind',
};
function mediaTypeByExt(ext) { return EXT_MEDIA[ext] || 0; }
function contentTypeByExt(ext) { return EXT_CT[ext] || 'application/octet-stream'; }

// uploads/ URL → 服务器本地绝对路径
function localPathFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('/uploads/')) return null;
  const rel = url.slice('/uploads/'.length).replace(/\\/g, '/');
  // __dirname = server/src → 上传目录实际位于 server/uploads（与 upload.js 的 uploadDir 一致）
  return path.join(__dirname, '..', 'uploads', rel);
}

// ── docx 生成 ───────────────────────────────────
// 文件名：日期 + 正文首句（去非法字符，限长）
function docxFileName(title, content) {
  const date = new Date().toISOString().slice(0, 10);
  const c = (content || '').replace(/\s+/g, ' ').trim();
  let first = (c.split(/[。.!?！？\n]/)[0] || '').trim().slice(0, 30);
  if (!first) first = (title || '文档').replace(/\s+/g, ' ').trim().slice(0, 30);
  first = (first.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()) || '文档';
  return `${date} ${first}.docx`;
}

async function generateDocx({ title, blocks }) {
  const { Document, Packer, Paragraph, HeadingLevel } = getDocx();
  const children = [new Paragraph({ text: title || '文档', heading: HeadingLevel.HEADING_1 })];
  for (const b of (blocks || [])) {
    if (b == null || b.text == null) continue;
    const t = String(b.text);
    if (b.level === 2) children.push(new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 }));
    else if (b.level === 1) children.push(new Paragraph({ text: t, heading: HeadingLevel.HEADING_1 }));
    else children.push(new Paragraph({ text: t }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── COS 上传（腾讯云临时凭证）─────────────────────
function cosUpload({ credential, body, content_type }) {
  const COS = getCOS();
  const cos = new COS({
    SecretId: credential.secret_id,
    SecretKey: credential.secret_key,
    SecurityToken: credential.token,
    Timeout: 120000,
  });
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: credential.bucket_name,
      Region: credential.region,
      Key: credential.cos_key,
      Body: body,
      ContentType: content_type,
    }, (err, data) => {
      if (err) return reject(new Error('COS 上传失败：' + (err.message || JSON.stringify(err))));
      resolve(data);
    });
  });
}

/**
 * 把本地文件（或内存 Buffer）作为对应类型媒体推送到 IMA 指定文件夹。
 * @returns {Promise<{media_id:string, url:string}>}
 */
async function uploadFileToIma({ localPath, buffer, fileName, folderId, knowledgeBaseId = KB_ID, mediaType, contentType }) {
  const ext = (path.extname(fileName || '') || '').replace(/^\./, '').toLowerCase();
  const mt = mediaType || mediaTypeByExt(ext);
  if (!mt) throw new Error('不支持的文件类型: ' + (ext || '未知'));
  const ct = contentType || contentTypeByExt(ext) || 'application/octet-stream';
  const body = buffer || fs.readFileSync(localPath);
  const size = buffer ? buffer.length : fs.statSync(localPath).size;

  // 1) create_media：申请 media_id + COS 临时凭证
  const r1 = await imaPost('openapi/wiki/v1/create_media', {
    knowledge_base_id: knowledgeBaseId,
    file_name: fileName,
    file_size: size,
    file_ext: ext,
    content_type: ct,
  });
  if (r1.code !== 0) throw new Error('IMA create_media 失败：' + (r1.msg || JSON.stringify(r1)));
  const mediaId = r1.data && r1.data.media_id;
  const cred = r1.data && r1.data.cos_credential;
  if (!mediaId || !cred) throw new Error('IMA create_media 未返回 media_id / cos_credential');

  // 2) 上传文件字节到腾讯云 COS
  await cosUpload({ credential: cred, body, content_type: ct });

  // 3) add_knowledge：落库到指定文件夹
  const r3 = await imaPost('openapi/wiki/v1/add_knowledge', {
    media_type: mt,
    media_id: mediaId,
    title: fileName,
    knowledge_base_id: knowledgeBaseId,
    folder_id: folderId,
    file_info: {
      cos_key: cred.cos_key,
      file_size: size,
      last_modify_time: Math.floor(Date.now() / 1000),
      file_name: fileName,
    },
  });
  if (r3.code !== 0) throw new Error('IMA add_knowledge 失败：' + (r3.msg || JSON.stringify(r3)));
  return { media_id: mediaId, url: (r3.data && (r3.data.url || (r3.data.media && r3.data.media.url))) || '' };
}

// ── IMA 文件夹名 / 条目名 工具 ───────────────
// 去除 IMA 不允许的字符（文件夹名与文件名通用）
function sanitizeName(s) {
  return (s == null ? '' : String(s))
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}
// 组装 IMA 条目名：时间 + 问题名 + 分类 + 启动人
function buildImaName({ time, title, category, initiator }) {
  const name = [sanitizeName(time), sanitizeName(title), sanitizeName(category), sanitizeName(initiator)]
    .filter(Boolean).join(' ');
  // IMA 文件夹名上限 255 rune，留余量截断
  return (name || '未命名').slice(0, 200);
}

// 在父文件夹下按名查找已存在的子文件夹（复用，避免重复建文件夹）
async function findImaFolder(parentFolderId, name) {
  try {
    const r = await imaPost('openapi/wiki/v1/search_knowledge', {
      query: name, knowledge_base_id: QUALITY_KB_ID, cursor: '',
    });
    if (r.code !== 0 || !r.data || !Array.isArray(r.data.info_list)) return null;
    const hit = r.data.info_list.find((it) =>
      it.media_id && it.media_id.startsWith('folder_') &&
      it.parent_folder_id === parentFolderId &&
      (it.title || '') === name
    );
    return hit ? hit.media_id : null;
  } catch (e) { return null; }
}

// 确保父文件夹下存在名为 name 的子文件夹，返回 folder_id（已存在则复用）
async function ensureImaFolder(parentFolderId, name) {
  const existing = await findImaFolder(parentFolderId, name);
  if (existing) return existing;
  const r = await imaPost('openapi/wiki/v1/create_folder', {
    knowledge_base_id: QUALITY_KB_ID,
    parent_folder_id: parentFolderId,
    name,
  });
  if (r.code !== 0) throw new Error('IMA create_folder 失败：' + (r.msg || JSON.stringify(r)));
  const fid = r.data && r.data.media_id;
  if (!fid) throw new Error('IMA create_folder 未返回 folder_id');
  return fid;
}

// ── 通用：把一条内容的「docx + 附件 + 图片」推到 IMA ──
// 规则（呼应需求：分开传不妥，按一个整体传入；但 IMA OpenAPI 无法在分类文件夹下嵌套子文件夹，
//   create_folder 的 parent_folder_id 被服务端忽略、move_knowledge 对文件夹是空操作，故采用
//   「平铺进分类子目录 + 同名前缀聚合」）：
//   - 所有文件（docx + 附件 + 图片）一律平铺进 parentFolderId（即 00公告/01宣贯/02人人讲 分类子目录）
//   - 文件名统一前缀 = 「时间 问题名 分类 启动人」（buildImaName 结果），
//     docx 命名为 <前缀>.docx；附件/图片命名为 <前缀>_<原名>，靠同名前缀在分类目录内聚成一组
async function pushContentToFolder({ e, parentFolderId, docBlocks, attachments = [], photos = [], knowledgeBaseId = KB_ID }) {
  const out = { doc: null, files: [], url: '', media_id: '', folderId: '', hadError: false, errors: [] };
  const name = buildImaName({
    time: e.time, title: e.title, category: e.category, initiator: e.initiator,
  });
  const docName = name + '.docx';

  // 是否真的有正文可生成 docx
  const hasDoc = Array.isArray(docBlocks) && docBlocks.some((b) => b && b.text && String(b.text).trim());

  // 平铺进目标文件夹（add_knowledge 的 folder_id 生效）
  const targetFolder = parentFolderId;

  if (hasDoc) {
    try {
      const buf = await generateDocx({ title: name, blocks: docBlocks });
      out.doc = await uploadFileToIma({ buffer: buf, fileName: docName, folderId: targetFolder, mediaType: 3, knowledgeBaseId });
    } catch (err) { out.hadError = true; out.errors.push('docx: ' + err.message); console.error('[IMA] docx 上传失败：', err.message); }
  }
  for (const att of attachments) {
    const lp = localPathFromUrl(att.url);
    if (!lp) continue;
    const fn = name + '_' + sanitizeName(att.name || path.basename(lp));
    try { out.files.push(await uploadFileToIma({ localPath: lp, fileName: fn, folderId: targetFolder, knowledgeBaseId })); }
    catch (err) { out.hadError = true; out.errors.push('附件(' + (att.name || '') + '): ' + err.message); console.error('[IMA] 附件上传失败：', (att.name || ''), err.message); }
  }
  for (const ph of photos) {
    const url = typeof ph === 'string' ? ph : ph.photo_url;
    const lp = localPathFromUrl(url);
    if (!lp) continue;
    const fn = name + '_' + sanitizeName(path.basename(lp));
    try { out.files.push(await uploadFileToIma({ localPath: lp, fileName: fn, folderId: targetFolder, knowledgeBaseId })); }
    catch (err) { out.hadError = true; out.errors.push('照片: ' + err.message); console.error('[IMA] 照片上传失败：', err.message); }
  }
  if (out.doc) { out.url = out.doc.url; out.media_id = out.doc.media_id; }
  else if (out.files.length) { out.url = out.files[0].url; out.media_id = out.files[0].media_id; }
  // 记录 IMA 同步状态（成功/失败）。失败且状态由 ok→fail 时推送微信告警，避免长期静默失败被用户事后才发现。
  // 注：告警由 recordImaStatus 内部统一触发（避免重复推送），此处不再单独调用 alertImaFailure。
  try {
    const errMsg = out.hadError ? (out.errors.join('；') || '未知错误') : '';
    recordImaStatus(db, { ok: !out.hadError, error: errMsg });
  } catch (e) { console.error('[IMA] 状态记录异常', e.message); }
  return out;
}

// ── 公告 ─────────────────────────────────────────
async function pushAnnouncement(e) {
  const blocks = [];
  if (e.publisher) blocks.push({ text: '发布人：' + e.publisher, level: 0 });
  if (e.scope) blocks.push({ text: '发布范围：' + (e.scope === 'division' ? ('专业室·' + (e.division || '')) : '全员'), level: 0 });
  if (e.publishDate) blocks.push({ text: '发布日期：' + e.publishDate, level: 0 });
  if (e.expiryDate) blocks.push({ text: '公示至：' + e.expiryDate, level: 0 });
  if (e.content) blocks.push({ text: e.content, level: 0 });
  const category = e.scope === 'division' ? ('专业室·' + (e.division || '')) : '全员';
  return pushContentToFolder({
    e: {
      time: (e.publishDate || e.created_at || '').slice(0, 10) || undefined,
      title: e.title,
      category,
      initiator: e.publisher,
      existingFolderId: e.existingFolderId,
    },
    parentFolderId: ANNOUNCEMENT_FOLDER_ID,
    docBlocks: blocks, attachments: e.attachments || [],
  });
}

// ── 质量宣贯 ─────────────────────────────────────
async function pushQualityDissem(e) {
  const blocks = [];
  if (e.category) blocks.push({ text: '分类：' + e.category, level: 0 });
  if (Array.isArray(e.divisions) && e.divisions.length) blocks.push({ text: '面向专业：' + e.divisions.join('、'), level: 0 });
  if (Array.isArray(e.regions) && e.regions.length) blocks.push({ text: '面向地区：' + e.regions.join('、'), level: 0 });
  if (e.publisher) blocks.push({ text: '发布人：' + e.publisher, level: 0 });
  if (e.publishDate) blocks.push({ text: '发布日期：' + e.publishDate, level: 0 });
  if (e.expiryDate) blocks.push({ text: '公示至：' + e.expiryDate, level: 0 });
  if (e.content) blocks.push({ text: e.content, level: 0 });

  const out = { doc: null, files: [], url: '', media_id: '', folderId: QUALITY_FOLDER_ID };
  const name = buildImaName({
    time: (e.publishDate || '').slice(0, 10) || undefined,
    title: e.title, category: e.category, initiator: e.publisher,
  });
  const hasDoc = blocks.some((b) => b && b.text && String(b.text).trim());

  // 1) 文字内容始终进「01千里行质量宣贯」文件夹（只放文字，不带附件/照片）
  if (hasDoc) {
    try {
      const buf = await generateDocx({ title: name, blocks });
      out.doc = await uploadFileToIma({ buffer: buf, fileName: name + '.docx', folderId: QUALITY_FOLDER_ID, mediaType: 3 });
    } catch (err) { console.error('[IMA] 宣贯 docx 上传失败：', err.message); }
  }

  // 2) 附件 + 照片的落库目标文件夹
  const specialRegs = (e.regions || []).filter((r) => SPECIAL_REGIONS.includes(r));
  const fileTargets = []; // 每个特殊地区一个 folder_id（多选则复制多份）
  for (const reg of specialRegs) {
    const fid = REGION_FOLDER_MAP[reg];
    if (!fid) { console.warn('[IMA] 宣贯地区「' + reg + '」未配置 IMA 文件夹，跳过附件路由'); continue; }
    fileTargets.push(fid);
  }
  // 未命中特殊地区 → 沿用旧逻辑：附件/照片随文字一起进 01 宣贯文件夹
  if (!fileTargets.length) fileTargets.push(QUALITY_FOLDER_ID);

  const atts = Array.isArray(e.attachments) ? e.attachments : [];
  const phs = Array.isArray(e.photos) ? e.photos : [];
  for (const att of atts) {
    const lp = localPathFromUrl(att.url);
    if (!lp) continue;
    const fn = name + '_' + sanitizeName(att.name || path.basename(lp));
    for (const fid of fileTargets) {
      try { out.files.push(await uploadFileToIma({ localPath: lp, fileName: fn, folderId: fid })); }
      catch (err) { console.error('[IMA] 宣贯附件上传失败：', (att.name || ''), err.message); }
    }
  }
  for (const ph of phs) {
    const url = typeof ph === 'string' ? ph : ph.photo_url;
    const lp = localPathFromUrl(url);
    if (!lp) continue;
    const fn = name + '_' + sanitizeName(path.basename(lp));
    for (const fid of fileTargets) {
      try { out.files.push(await uploadFileToIma({ localPath: lp, fileName: fn, folderId: fid })); }
      catch (err) { console.error('[IMA] 宣贯照片上传失败：', err.message); }
    }
  }
  if (out.doc) { out.url = out.doc.url; out.media_id = out.doc.media_id; }
  else if (out.files.length) { out.url = out.files[0].url; out.media_id = out.files[0].media_id; }
  return out;
}

// ── 质量人人讲（PDCA 复盘）─────────────────────────
function buildProblemBlocks(p, opts = {}) {
  const blocks = [];
  blocks.push({ text: '来源：质量千里行 · PDCA 质量改进闭环', level: 0 });
  if (p.reporter) blocks.push({ text: '上报人：' + p.reporter, level: 0 });
  if (p.description) blocks.push({ text: '一、问题描述', level: 2 });
  if (p.description) blocks.push({ text: p.description, level: 0 });
  if (p.consult_experts) {
    let experts = p.consult_experts;
    if (typeof experts === 'string') { try { experts = JSON.parse(experts); } catch { experts = []; } }
    if (Array.isArray(experts) && experts.length) {
      blocks.push({ text: '二、请教专家', level: 2 });
      experts.forEach((e) => blocks.push({ text: '- ' + e, level: 0 }));
    }
  }
  if (Array.isArray(p.solutions) && p.solutions.length) {
    blocks.push({ text: '三、解决做法', level: 2 });
    p.solutions.forEach((s) => {
      let line = s.content || '';
      if (s.experts) line += `（相关专家：${s.experts}）`;
      if (s.created_by) line += ` —— ${s.created_by}`;
      blocks.push({ text: line, level: 0 });
    });
  }
  // 仅复盘模式：跳过专家/共议问答章节（人人讲分享版只沉淀复盘与话术）
  if (!opts.reviewOnly) {
    // 统一取出每轮追问的回复：专家(expert) + 共议设计师(designer) 的多条答复；
    // 同时兼容旧数据里 consult 上的单字段 answer（已被多对一 answers 取代）。
    const consults = Array.isArray(p.consults) ? p.consults : [];
    const hasExperts = (() => {
      let ex = p.consult_experts;
      if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch { ex = []; } }
      return Array.isArray(ex) && ex.length;
    })();
    if (consults.length || hasExperts) {
      blocks.push({ text: '四、专家问答 / 共议讨论', level: 2 });
      if (!consults.length) {
        blocks.push({ text: '（该问题已请教专家，暂未记录追问与回复）', level: 0 });
      }
      consults.forEach((c) => {
        blocks.push({ text: `Q${c.round || ''} ${c.question_by || ''} 问：${c.question || ''}`, level: 0 });
        const answers = Array.isArray(c.answers) ? c.answers : [];
        if (answers.length) {
          answers.forEach((a) => {
            const tag = a.role === 'designer' ? '🗣️ 共议' : '💡 专家';
            blocks.push({ text: `  ${tag} ${a.answer_by || a.expert_name || ''} 答：${a.answer || ''}`, level: 0 });
          });
        } else if (c.answer) {
          // 旧数据兼容：consult 上残留的单字段答复
          blocks.push({ text: `  ${c.answer_by || ''} 答：${c.answer}`, level: 0 });
        } else {
          blocks.push({ text: '  （暂无回复）', level: 0 });
        }
      });
    }
  }
  const review = p.review || (opts && opts.liveReview ? { content: opts.liveReview } : null);
  if (review && review.content) {
    blocks.push({ text: '五、复盘 / 人人讲感悟', level: 2 });
    blocks.push({ text: review.content, level: 0 });
  }
  return blocks;
}

async function pushRenrenjiang(problem, opts = {}) {
  // 组装完整对象（与 GET /problems/:id 同构），含照片与附件
  const photos = Array.isArray(problem.photos) ? problem.photos : [];
  const atts = Array.isArray(problem.attachments) ? problem.attachments : [];
  // 院选后推进「03千里行质量人人讲院选」，否则进「02千里行质量人人讲」
  const targetFolder = opts.selected ? await selectedRenrenjiangFolderId() : FOLDER_ID;
  const category = opts.selected ? '质量人人讲院选' : '质量人人讲';
  // P2：重推（rePush）时标题加「（更新于 YYYY-MM-DD HH:mm）」后缀，避免与 IMA 中已存在的旧副本混淆。
  // IMA 无更新接口，重推即新建一条；加后缀让审阅者一眼区分新旧。
  let title = problem.title;
  if (opts.rePush) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = opts.rePushAt || `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    title = `${problem.title}（更新于 ${stamp}）`;
  }
  const out = await pushContentToFolder({
    e: {
      time: (problem.created_at || '').slice(0, 10) || undefined,
      title,
      category,
      initiator: problem.reporter,
      existingFolderId: problem.existingFolderId,
    },
    parentFolderId: targetFolder,
    docBlocks: buildProblemBlocks(problem, opts),
    attachments: atts,
    photos,
  });
  return out;
}

// ── 项目备忘 ─────────────────────────────────────
// 在 SHARE-知识库 KB 根目录按「项目名」查找/创建项目文件夹（create_folder 忽略 parent_folder_id，落到 KB 根）。
async function findProjectFolder(name) {
  try {
    const r = await imaPost('openapi/wiki/v1/search_knowledge', {
      query: name, knowledge_base_id: KB_ID, cursor: '',
    });
    if (r.code !== 0 || !r.data || !Array.isArray(r.data.info_list)) return null;
    const hit = r.data.info_list.find((it) =>
      it.media_id && it.media_id.startsWith('folder_') && (it.title || '') === name
    );
    return hit ? hit.media_id : null;
  } catch (e) { return null; }
}
async function ensureProjectFolder(name) {
  const existing = await findProjectFolder(name);
  if (existing) return existing;
  const r = await imaPost('openapi/wiki/v1/create_folder', {
    knowledge_base_id: KB_ID,
    name,
  });
  if (r.code !== 0) throw new Error('IMA create_folder(项目备忘) 失败：' + (r.msg || JSON.stringify(r)));
  const fid = r.data && r.data.media_id;
  if (!fid) throw new Error('IMA create_folder(项目备忘) 未返回 folder_id');
  return fid;
}
// 把一条项目备忘推入指定项目文件夹（folderId）。
async function pushMemo(rec, project, folderId) {
  const blocks = [];
  blocks.push({ text: '来源：质量千里行 · 项目信息传递', level: 0 });
  if (project && project.name) blocks.push({ text: '项目：' + project.name, level: 0 });
  if (rec.title) blocks.push({ text: '标题：' + rec.title, level: 0 });
  if (rec.location) blocks.push({ text: '地点：' + rec.location, level: 0 });
  if (rec.scenario) blocks.push({ text: '场景：' + rec.scenario, level: 0 });
  if (rec.author_name) blocks.push({ text: '记录人：' + rec.author_name, level: 0 });
  if (rec.content) blocks.push({ text: rec.content, level: 0 });
  const out = await pushContentToFolder({
    e: {
      time: ((rec.published_at || rec.created_at || '').slice(0, 10)) || undefined,
      title: (project && project.name) || '项目信息传递',
      category: '项目信息传递',
      initiator: rec.author_name,
    },
    parentFolderId: folderId,
    docBlocks: blocks,
    attachments: Array.isArray(rec.attachments) ? rec.attachments : [],
    photos: Array.isArray(rec.photos) ? rec.photos : [],
  });
  out.folderId = folderId;
  return out;
}

// ── IMA 同步状态记录与主动告警 ─────────────────────
// 记录最近一次同步状态到 ima_sync_status 表；状态由 ok/未知 → fail 时推送一次微信告警（避免持续失败重复骚扰）
async function recordImaStatus(conn, { ok, error }) {
  try {
    // 老表兼容：确保告警重试所需字段存在（存在则忽略异常）
    try {
      conn.exec("ALTER TABLE ima_sync_status ADD COLUMN last_alert_at TEXT");
      conn.exec("ALTER TABLE ima_sync_status ADD COLUMN last_alert_ok INTEGER");
    } catch (e) { /* 列已存在 */ }

    const now = new Date().toISOString();
    const cur = conn.prepare('SELECT id, status, last_alert_at, last_alert_ok FROM ima_sync_status WHERE id=1').get();
    const wasFail = cur && cur.status === 'fail';
    if (ok) {
      if (cur) conn.prepare("UPDATE ima_sync_status SET status='ok', last_success_at=?, last_check_at=?, last_error='' WHERE id=1").run(now, now);
      else conn.prepare("INSERT INTO ima_sync_status (id, status, last_success_at, last_check_at, last_error) VALUES (1,'ok',?,?,'')").run(now, now);
    } else {
      if (cur) conn.prepare("UPDATE ima_sync_status SET status='fail', last_check_at=?, last_error=? WHERE id=1").run(now, error || 'unknown');
      else conn.prepare("INSERT INTO ima_sync_status (id, status, last_check_at, last_error) VALUES (1,'fail',?,?)").run(now, error || 'unknown');
    }

    // 告警策略（兼顾「主动发现」与「不重复骚扰」）：
    //  - 首次失败（ok→fail 或首次记录）立即推送一次；
    //  - 若本次推送失败（如 Server酱 当日额度耗尽），则每 24h 重试一次，直至成功；
    //    这避免「一次性推送被限流后用户永远收不到」的盲区；
    //  - 已成功推送后，在本次失败周期内不再重复推送。
    let shouldAlert = false;
    if (!ok) {
      if (!wasFail) shouldAlert = true;
      else {
        const lastOk = cur && cur.last_alert_ok === 1;
        if (!lastOk) {
          const lastAt = cur && cur.last_alert_at;
          const hrs = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 3600000 : 999;
          if (hrs >= 24) shouldAlert = true;
        }
      }
    }

    if (shouldAlert) {
      const res = await alertImaFailure(error);
      const t = new Date().toISOString();
      conn.prepare("UPDATE ima_sync_status SET last_alert_at=?, last_alert_ok=? WHERE id=1").run(t, res.ok ? 1 : 0);
    }
  } catch (e) { console.error('[IMA] 状态记录失败', e && e.message); }
}

// 主动告警：优先用 IMA_ALERT_SCKEY（微信 Server酱 SendKey）；未配置则回退到超级管理员已绑定的 serverchan_key。
// 目的：IMA Key 过期/失效时主动推微信提醒，避免用户事后才发现同步断了。
// 返回 { ok, message }，便于 recordImaStatus 判断本次推送是否真正送达（用于失败重试）
async function alertImaFailure(error) {
  let key = process.env.IMA_ALERT_SCKEY;
  if (!key) {
    try {
      const u = db.prepare("SELECT serverchan_key FROM users WHERE username='superadmin' AND serverchan_key IS NOT NULL LIMIT 1").get();
      key = u && u.serverchan_key;
    } catch (e) { key = null; }
  }
  if (!key) { console.error('[IMA] 无可用 Server酱 SendKey，跳过告警'); return { ok: false, message: 'no-key' }; }
  try {
    const sc = require('./wechat/serverchan');
    const r = await sc.send(key, '⚠️ 千里行·IMA 同步异常',
      'IMA 知识库同步失败：\n\n' + (error || 'unknown') +
      '\n\n可能原因：IMA OpenAPI Key 过期/失效（有效期约 1 个月）。\n请到 https://ima.qq.com/agent-interface 重新生成 Client ID / Api Key，更新服务器 .env 的 IMA_CLIENT_ID / IMA_API_KEY 后 pm2 restart qc-app。'
    );
    console.log('[IMA] 告警推送结果：', r && r.message);
    return { ok: !!(r && r.ok), message: (r && r.message) || '' };
  } catch (e) { console.error('[IMA] 告警推送异常', e && e.message); return { ok: false, message: e.message }; }
}

// 轻量鉴权探针：仅验证 IMA 凭证是否有效（不创建任何资源）。返回 { ok, error }
async function checkImaAuth() {
  try {
    const r = await imaPost('openapi/wiki/v1/get_addable_knowledge_base_list', { limit: 50 });
    if (r && r.code === 0) return { ok: true };
    return { ok: false, error: (r && (r.msg || JSON.stringify(r))) || 'unknown' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  pushAnnouncement, pushQualityDissem, pushRenrenjiang, pushMemo,
  recordImaStatus, checkImaAuth, alertImaFailure,
  ensureProjectFolder,
  uploadFileToIma, generateDocx, docxFileName,
  buildProblemBlocks,
  ensureImaFolder, findImaFolder, buildImaName, sanitizeName,
  KB_ID, FOLDER_ID, KB_NAME, FOLDER_NAME, QUALITY_KB_ID, QUALITY_FOLDER_ID, ANNOUNCEMENT_FOLDER_ID,
};
