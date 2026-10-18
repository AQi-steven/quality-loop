/**
 * 建筑专业 18 位设计师 → 腾讯文档「项目工期」完整链接映射
 *
 * 用途：项目工期模块「腾讯文档直达」——不快照、不写回，
 * 仅把每个人的共享文档链接展示出来，点开即看实时内容。
 *
 * 存完整 URL（含 ?tab= 参数），不拼 file_id。
 * 链接稳定不变，仅当文档被删/取消分享/改权限时才会失效；
 * 获取方式：在文档内点「分享 → 复制链接」得到的 D 格式
 * （https://docs.qq.com/sheet/D<id>?tab=000001）。
 * 注意：带 ?_fid= 的 V/f 格式为内部 file_id，不可用。
 *
 * 当前 18 人 D 格式链接已全部配置。
 */

const OWNER_URLS = {
  '×××': 'https://docs.qq.com/sheet/DZmVabVNsRUdSUmdt?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZkNiY3pOVFZpR1Zw?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZnBUaHp1VnhBRXN0?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZmdDRUhmY2FnQWdq?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZk1JWXBCZndFR1hH?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZnFmbEdBV3FiZG1I?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZm9HeFhXRU5LbnZa?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZmRHWFduZFJZQ29u?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZmxOTWdtR0tSSXpV?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZkNYS0xJTVFGeVBx?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZkx1WFNZZ0tYR0ZH?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZnBYUFJ5dnp3S1RR?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZkJYa2FicXF4T2tW?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZm52RnNLR3FnbFZH?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZmhXQ0pZeUdLSGRS?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZmh3Y2xtVnZjVndU?tab=000001',
  '×××': 'https://docs.qq.com/sheet/DZkRtZWdUcGVYSUVZ?tab=000001',
  '周昊炯': 'https://docs.qq.com/sheet/DZm56a3ptd29iWU5z?tab=000001',
};

function docUrl(owner) {
  return OWNER_URLS[owner] || '';
}

// 从腾讯文档分享链接提取 file_id（D 格式段）。
// 实测：腾讯文档开放平台 query_file_info 直接用此 D 段也能查到元数据，
// 故无需 V/f 内部 file_id，分享链接即可驱动 doc_meta 缓存与 schedule-seed 同步。
function fileIdFromUrl(url) {
  if (!url) return '';
  const s = String(url);
  const m = s.match(/docs\.qq\.com\/\w+\/(D[\w-]+)/);
  if (m) return m[1];
  const m2 = s.match(/(D[\w-]+)/);
  return m2 ? m2[1] : '';
}

// 18 位设计师 → 腾讯文档 file_id（D 格式），统一从 OWNER_URLS 派生，避免重复维护。
// 供 doc_meta 缓存写入与 schedule-seed.js 同步状态 upsert 共用。
const OWNER_FILES = {};
for (const [owner, url] of Object.entries(OWNER_URLS)) {
  OWNER_FILES[owner] = fileIdFromUrl(url);
}

function listOwners() {
  return Object.keys(OWNER_URLS).map(owner => ({
    owner,
    fileId: OWNER_FILES[owner] || '',
    docUrl: docUrl(owner),
  })).sort((a, b) => a.owner.localeCompare(b.owner, 'zh'));
}

module.exports = { OWNER_URLS, OWNER_FILES, docUrl, fileIdFromUrl, listOwners };
