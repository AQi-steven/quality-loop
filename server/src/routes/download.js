/**
 * 带友好文件名的下载接口
 *
 * 背景：直接访问 /uploads/xxx.pdf 时 express.static 不带 Content-Disposition，
 *   且文件名是随机哈希；微信收藏/WPS 会把链接当网页抓取或无法识别文件名。
 * 用法：/api/download/202608/xxx.pdf?filename=质量工作简报_2026-07_2026-08.pdf
 *
 * 鉴权（#536）：
 *   - 优先：短期签名（?sig=&exp=）—— 微信/移动端无登录态但仍可打开
 *   - 兜底：JWT 登录态（兼容旧链接 / 内部直连）
 *   - 两者皆缺 → 401
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { verifyPathSignature } = require('../sign');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'uploads');

const MIME_MAP = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=UTF-8',
  md: 'text/markdown; charset=UTF-8',
  markdown: 'text/markdown; charset=UTF-8',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};

function encodeRFC5987(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sendFile(req, res, storedPath) {
  try {
    const filePath = path.join(uploadDir, storedPath);
    const resolvedFile = path.resolve(filePath);
    const resolvedDir = path.resolve(uploadDir);
    if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
      return res.status(403).json({ error: '禁止访问' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    const baseName = path.basename(filePath);
    const displayName = (req.query.filename || baseName).replace(/[\r\n"]/g, '');
    const asciiName = displayName.replace(/[^\x00-\x7F]/g, '_') || 'file';
    const utf8Name = encodeRFC5987(displayName);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(resolvedFile);
  } catch (e) {
    console.error('[download]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
}

router.get('/:storedPath(*)', (req, res) => {
  const storedPath = req.params.storedPath || '';
  if (!storedPath || storedPath.includes('..')) {
    return res.status(403).json({ error: '禁止访问' });
  }

  // 免登录下载：仅限 uploads 目录下白名单扩展名。
  // 背景：附件预览(kkFileView 反代)本就免登录，下载同等级安全；
  //   附件文件名是随机哈希不可猜，且游客/微信无登录态也需要下载附件。
  //   白名单与上传侧 ALLOWED_EXT 一致的关键子集，避免把本端点变成任意文件通道。
  const dlExt = path.extname(storedPath).toLowerCase().replace(/^\./, '');
  const DL_ALLOWED = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown', 'csv',
    'zip', 'rar', '7z', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    'dwg', 'dxf', 'dwt', 'dwf', 'skp', 'rvt', 'ifc', 'stp', 'step', 'igs', 'iges',
  ]);
  const probePath = path.join(uploadDir, storedPath);
  const resolvedProbe = path.resolve(probePath);
  const resolvedDir = path.resolve(uploadDir);
  if (resolvedProbe.startsWith(resolvedDir + path.sep) && DL_ALLOWED.has(dlExt)) {
    return sendFile(req, res, storedPath);
  }

  // 鉴权：优先签名（#536），缺签则回退登录态
  const { sig, exp } = req.query;
  if (sig && exp) {
    if (!verifyPathSignature(storedPath, sig, exp)) {
      return res.status(401).json({ error: '签名无效或已过期' });
    }
    return sendFile(req, res, storedPath);
  }
  // 无签名 → 必须登录（避免未登录用户拿到 /uploads 任意路径）
  return authMiddleware(req, res, () => {
    if (!req.user) return res.status(401).json({ error: '未授权' });
    sendFile(req, res, storedPath);
  });
});

module.exports = router;