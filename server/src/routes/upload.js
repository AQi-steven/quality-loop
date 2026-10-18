/**
 * 通用文件上传路由
 *
 * - POST /upload   接收任意常见类型文件（图片 / Word / PDF / Excel / PPT / Markdown / 文本 / Xmind），
 *                  按日期分目录存本地 uploads/，返回 URL 与原始文件名，供公告 / 宣贯 / 人人讲 附件复用。
 *
 * 设计：本地存储优先（与既有图片上传一致），文件同时会被业务层推送到 IMA 质量库对应文件夹。
 * 字段名兼容旧前端（photos），也接受任意字段名（.any()）。
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const authMiddleware = require('../middleware/auth');
const { signPath } = require('../sign');

const router = express.Router();

// ── 防御性文件名编码修正 ──────────────────────────────
// 部分客户端（微信内置浏览器 / 旧版移动端）上传中文文件名时，
// UTF-8 字节流可能被当作 Latin-1(ISO-8859-1) 解码，导致：
//   原始"松江储能.pdf"(UTF-8) → 存为 "æ¾æ±å¨è½.pdf"(mojibake)
// 本函数检测此类模式并自动还原为正确 UTF-8 中文。
// 启发式：字符串含高位 Latin-1 字符(0x80-0xFF)且能被重新解码为合法 UTF-8 CJK 文本。
function fixFilenameEncoding(name) {
  if (!name || typeof name !== 'string') return name;
  // 快速跳过：纯 ASCII 或已含合法中文（U+4E00+）则无需修正
  if (!/[\x80-\xff]/.test(name)) return name;
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(name)) return name;
  // 尝试 Latin-1 → UTF-8 还原
  try {
    const buf = Buffer.from(name, 'latin1');
    const decoded = buf.toString('utf-8');
    // 还原后必须包含合法 CJK 且不含控制字符
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(decoded) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) {
      console.warn('[upload] 文件名编码修正:', JSON.stringify(name), '→', decoded);
      return decoded;
    }
  } catch (e) { /* 忽略 */ }
  return name;
}

const uploadDir = path.join(__dirname, '..', '..', 'uploads');

// 允许的常见附件类型（扩展名白名单）
// 2026-09-16 扩容：补入设计院高频的 CAD / 压缩包 / 模型格式。
// 起因：共议设计师反馈「文件上传按钮无效」——实测 .dwg/.dxf/.rar/.7z 全被拒（HTTP 500 + 仅 2 秒 toast），
// 而图纸/图纸压缩包恰恰是质量问题共议时最常附的凭证。仍为显式白名单，不含任何可执行/脚本类扩展名。
const ALLOWED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
  'pdf', 'doc', 'docx', 'wps', 'rtf', 'txt', 'md', 'markdown',
  'xls', 'xlsx', 'csv', 'ppt', 'pptx',
  'xmind', 'zip', 'rar', '7z',
  'dwg', 'dxf', 'dwt', 'dwf',                 // CAD 图纸
  'skp', 'rvt', 'ifc', 'stp', 'step', 'igs', 'iges', // 三维 / 模型（仅留存，不做在线预览）
]);
// 供错误提示回显，前端不再自己维护一份清单（避免两处漂移）
const ALLOWED_LIST = Array.from(ALLOWED_EXT).join('/');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const now = new Date();
    const sub = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(uploadDir, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const name = crypto.randomBytes(8).toString('hex') + Date.now() + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB 上限
    files: 20,                  // 单次最多 20 个（下方注释原本就写"最多 20 个"，但从未真正启用，现补上）
  },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/^\./, '');
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('不支持的文件类型：.' + (ext || '未知') + '。可上传：' + ALLOWED_LIST));
    }
    cb(null, true);
  },
});

// multer 抛出的错（类型被拒 / 超 50MB / 数量超限）本质是「客户端输入不合法」，
// 应为 400 而非默认 500；且必须返回 JSON（前端按 data.error 取值），
// 否则前端 res.json() 解析失败会抛出一条用户看不懂的报错，最终只表现为"点了没反应"。
function runUpload(req, res, next) {
  upload.any()(req, res, (err) => {
    if (!err) return next();
    const code = String(err.code || '');
    let msg = err.message || '上传失败';
    if (code === 'LIMIT_FILE_SIZE') msg = '文件超过 50MB 上限';
    else if (code === 'LIMIT_FILE_COUNT') msg = '一次最多上传 20 个文件';
    const bad = code.indexOf('LIMIT_') === 0 || /不支持的文件类型/.test(msg);
    res.status(bad ? 400 : (err.status || 500)).json({ error: msg, allowed: ALLOWED_LIST });
  });
}

// 接受任意字段名（photos / file / 其它）
router.post('/', authMiddleware, runUpload, (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '未收到文件' });
  }
  const urls = req.files.map((f) => {
    const rel = path.relative(uploadDir, f.path).replace(/\\/g, '/');
    return `/uploads/${rel}`;
  });
  const files = req.files.map((f, i) => ({
    url: urls[i],
    name: fixFilenameEncoding(f.originalname) || path.basename(f.path),
    size: f.size,
  }));
  // 同步生成带时效签名的下载 URL（#536）：供微信/移动端无登录态下载，
  // 默认 10 分钟过期，足够 WPS/微信收藏抓取周期，又防链接被永久外传。
  const signedUrls = req.files.map((f, i) => {
    const rel = path.relative(uploadDir, f.path).replace(/\\/g, '/');
    const { sig, exp } = signPath(rel);
    const displayName = files[i].name;
    return `/api/download/${rel}?filename=${encodeURIComponent(displayName)}&sig=${sig}&exp=${exp}`;
  });
  res.json({ urls, files, signedUrls });
});

module.exports = router;
