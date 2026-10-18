/**
 * 项目工期（建筑专业 18 人）路由
 *
 * 设计：腾讯文档「直达」模式——不快照、不写回。
 * 仅把每人对应的腾讯共享文档链接返回前端，设计师看自己、
 * 管理者看全部，点开即看实时内容（他们随时在文档里改）。
 *
 * - GET /schedule/owners   → 18 人及各自腾讯文档链接
 */

const express = require('express');
const authMiddleware = require('../middleware/auth');
const { listOwners, docUrl, fileIdFromUrl } = require('../owners');
const { canManage } = require('../rbac');
const db = require('../db/connection');

const router = express.Router();

// ── 设计师列表 + 文档链接 + 文档最后更新时间 ───────────
// 权限（服务端强制，不靠前端隐藏）：
//   · 管理者(canManage：室主任/专总/院长/管理员) → 看全部 18 人
//   · 设计师(canDesign，非管理者)              → 仅看自己的那一条
// 关联 doc_meta 缓存，附上「最后更新时间 / 修改人」（由腾讯文档通道定时拉取写入）。
// 注意：authMiddleware 仅作用于这两个读取接口；/doc-meta 写入接口走独立的 KEY 鉴权，
// 不要求用户登录（由已连接的腾讯文档通道 MCP 定时推送，无 JWT 上下文）。
router.get('/owners', authMiddleware, (req, res) => {
  const all = listOwners();
  // 一次性取出缓存，按 file_id 建索引，避免 N 次查询
  const metaRows = db.prepare('SELECT file_id, last_modify_time, last_modify_name FROM doc_meta').all();
  const metaMap = {};
  for (const r of metaRows) metaMap[r.file_id] = r;

  const enriched = all.map(o => {
    const fid = o.fileId || fileIdFromUrl(o.docUrl);
    const m = metaMap[fid] || {};
    return {
      owner: o.owner,
      fileId: fid,
      docUrl: o.docUrl,
      lastModifyTime: (m.last_modify_time != null) ? Number(m.last_modify_time) : null,
      lastModifyName: m.last_modify_name || null,
    };
  });

  if (canManage(req.user)) return res.json(enriched);
  return res.json(enriched.filter(o => o.owner === req.user.realName));
});

// ── 单人文档链接（可选）──────────────────────────
router.get('/link', authMiddleware, (req, res) => {
  const owner = (req.query.owner || '').trim();
  if (!owner) return res.status(400).json({ error: 'owner 必填' });
  // 设计师只能查自己；管理者可查任意人
  if (!canManage(req.user) && owner !== req.user.realName) {
    return res.status(403).json({ error: '无权查看他人的项目工期' });
  }
  const url = docUrl(owner);
  if (!url) return res.status(404).json({ error: '未找到该设计师的文档' });
  res.json({ owner, docUrl: url });
});

// ── 写入腾讯文档元数据缓存（供「最后更新时间」展示）────
// 由已连接的腾讯文档通道（MCP）定时拉取 18 人真实修改时间后推送本端点。
// 用 DOC_META_PUSH_KEY 保护（请求头 X-Doc-Meta-Key 或 body.key），避免被恶意清空。
// 入参：{ items: [{ fileId, title, lastModifyTime(毫秒), lastModifyName, ownerName }] }
const DOC_META_PUSH_KEY = process.env.DOC_META_PUSH_KEY;
router.post('/doc-meta', (req, res) => {
  const key = req.get('X-Doc-Meta-Key') || (req.body && req.body.key);
  if (!DOC_META_PUSH_KEY || key !== DOC_META_PUSH_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const items = req.body && req.body.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items 必填且为非空数组' });
  }
  const upsert = db.prepare(`INSERT INTO doc_meta (file_id, title, last_modify_time, last_modify_name, owner_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      title=excluded.title,
      last_modify_time=excluded.last_modify_time,
      last_modify_name=excluded.last_modify_name,
      owner_name=excluded.owner_name,
      fetched_at=CURRENT_TIMESTAMP`);
  let n = 0;
  for (const it of items) {
    if (!it || !it.fileId) continue;
    upsert.run(
      it.fileId,
      it.title || null,
      it.lastModifyTime != null ? Number(it.lastModifyTime) : null,
      it.lastModifyName || null,
      it.ownerName || null
    );
    n++;
  }
  res.json({ ok: true, upserted: n });
});

module.exports = router;
