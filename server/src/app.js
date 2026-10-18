/**
 * Express应用入口
 *
 * 核心中间件：cors、JSON解析、静态文件服务
 * API路由：auth、issues、tickets、goals、ideas、upload
 */

// ── 加载部署环境变量（server/.env）──────────────────
// pm2 不会自动把 .env 注入 process.env，而 IMA 等密钥依赖此文件。
// 放在所有 require 之前，确保 config / ima 等模块在加载时即可读到环境变量。
const { loadDeployEnv } = require('./env');
loadDeployEnv();

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const config = require('./config');
const compression = require('compression');

// 安全护栏：绝不允许使用源码内默认 JWT 密钥启动（无论环境）。
// 默认密钥写在源码里，任何人可读 → 可伪造 {username:'superadmin',role:'admin'} token 提权。
// 本地开发请显式设置 JWT_SECRET=dev（或任意非默认值）绕过。
const DEFAULT_JWT = 'quality-app-jwt-secret-change-in-production';
if (config.jwtSecret === DEFAULT_JWT) {
  console.error('[FATAL] JWT_SECRET 未配置或使用了源码默认值，拒绝启动（存在 token 伪造提权风险）。');
  console.error('[FATAL] 请在 server/.env 设置 JWT_SECRET（本地开发可设为 dev）。');
  process.exit(1);
}

const app = express();

// CORS配置：生产环境可用 CORS_ORIGIN 环境变量指定允许的源（逗号分隔），
// 未配置时同域访问（Express 同时托管前端与 API）不受限。
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : '*';
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// ── 安全响应头（微信安全评分 + 通用防护）────────────────
// 微信内置浏览器会对打开的链接做安全检测，缺少这些头会降低安全评分、
// 触发"无法确认该网页安全性"警告（即使已有 ICP 备案 + 有效 SSL）。
// 同时防护 clickjacking / MIME 嗅探 / XSS 等常见攻击面。
app.use((req, res, next) => {
  // 隐藏技术栈信息泄露
  res.removeHeader('x-powered-by');
  // HSTS：强制浏览器 90 天内只用 HTTPS 访问（含子域名）
  res.setHeader('Strict-Transport-Security', 'max-age=7776000; includeSubDomains');
  // 防 MIME 嗅探（避免浏览器把 JSON/HTML 当成其他类型执行）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 防点击劫持（禁止被 iframe 嵌入）
  res.setHeader('X-Frame-Options', 'DENY');
  // 启用浏览器 XSS 过滤器
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // 控制 Referer 泄露（跨域请求不发送完整 URL）
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 内容安全策略（限制资源加载来源，防 XSS 注入第三方脚本）
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' https:; " +
    "frame-ancestors 'none'"
  );
  next();
});

// kkFileView 文档预览同源反代：kkFileView 跑在宿主机 :8012（Docker host 网络，context-path=/kkf），
// 通过已开放的 3000 端口 /kkf 前缀暴露，避免腾讯云防火墙拦截 8012 端口导致外部/微信无法打开。
// 前端附件链接形如 http(s)://<host>/kkf/onlinePreview?url=<base64(公网文件URL)>，体验与 PDF 内联打开一致。
//
// ── 预览源地址改写（2026-09-15 修复「微信内文档打不开」）────────────────
// 背景：kkFileView 容器内是 JDK 1.8.0_251（2020-04），信任库早于 Let's Encrypt 2026 年
//   根证书轮换（线上链 = leaf→YE1→ISRG Root YE→ISRG Root X2，老 JDK 不含该根），
//   于是 kkFileView 以 https 拉取源文件时必然报
//   `PKIX path building failed: unable to find valid certification path`，
//   预览页只显示「系统暂不支持在线预览」——微信内所有 Word/Excel/PPT 附件都打不开。
// 方案：容器是 host 网络，可直连宿主回环端口，故把"指向本站"的源地址改写为
//   http://127.0.0.1:<PORT>/…，彻底绕开 TLS。签名校验的是 storedPath（与 host 无关），
//   改写后鉴权语义不变；外部域名一律原样透传，不改写。
function rewriteKkfPreviewSource(url, hostHeader) {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return url;
  const pathPart = url.slice(0, qIdx);
  if (!/\/onlinePreview$/.test(pathPart)) return url; // 仅处理在线预览
  let sp;
  try { sp = new URLSearchParams(url.slice(qIdx + 1)); } catch (e) { return url; }
  const raw = sp.get('url');
  if (!raw) return url;
  let src, u;
  try { src = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { return url; }
  try { u = new URL(src); } catch (e) { return url; }
  const selfHosts = new Set(['example.com', 'www.example.com', 'localhost', '127.0.0.1']);
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  if (host) selfHosts.add(host);
  if (!selfHosts.has(u.hostname.toLowerCase())) return url; // 非本站 → 不改写
  const local = 'http://127.0.0.1:' + config.port + u.pathname + u.search;
  sp.set('url', Buffer.from(local, 'utf8').toString('base64'));
  return pathPart + '?' + sp.toString();
}

// ── 预览页资源地址改写（2026-09-15 二次修复「微信内预览只有一圈 loading 坏图」）──────
// 背景：kkFileView 拼 baseUrl 时取的是「它自己收到请求时的 scheme/host/port」。它前面是我们
//   自己写的明文 HTTP 反代，于是它认为站点是 http → 生成的图片地址形如
//   `http://example.com:80/kkf/<fileKey>/0.jpg`（硬编码 :80）。而预览页本身跑在 https 上：
//     · 不升级的实现（微信 X5 / 老 WKWebView）→ 按「混合内容」直接拦掉；
//     · 会升级的实现（新版 Chromium）→ 升成 `https://example.com:80/…`，80 端口跑 TLS 照样失败。
//   两种结局都是图片全坏、只显示 alt="loading"（用户截图即此状）。
// 方案：在反代层把响应 HTML 里的「本站绝对地址」统一改写成同源相对路径（/kkf/…），
//   页面同源 https → `/kkf/…` 自然解析成 https 同源地址，scheme/port 问题一并消除。
//   只改 text/html 且必须未压缩；图片/JS/CSS/二进制原样透传。
function rewriteKkfBody(body, hostHeader) {
  const hosts = new Set(['example.com', 'www.example.com', 'localhost', '127.0.0.1']);
  const h = String(hostHeader || '').split(':')[0].trim().toLowerCase();
  if (h) hosts.add(h);
  const alt = Array.from(hosts).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // http(s)://<本站>[:端口] 且后面紧跟 / → 整段去掉，留下以 / 开头的同源路径
  const re = new RegExp('(?:https?:)?\\/\\/(?:' + alt + ')(?::\\d+)?(?=\\/)', 'gi');
  return body.replace(re, '');
}

app.use('/kkf', (req, res) => {
  let kkfUrl = req.url;
  try { kkfUrl = rewriteKkfPreviewSource(kkfUrl, req.headers.host); }
  catch (e) { console.error('[kkf-rewrite]', e.message); }
  const fwdHeaders = Object.assign({}, req.headers);
  delete fwdHeaders['accept-encoding']; // 要求未压缩响应，才能安全改写 HTML 里的绝对地址
  const options = {
    host: '127.0.0.1',
    port: 8012,
    path: '/kkf' + kkfUrl, // Express 已剥离 /kkf 前缀，req.url 以 / 开头
    method: req.method,
    headers: fwdHeaders, // 保留原始 Host(=浏览器 host)，让 kkFileView 生成的链接同域
  };
  const proxyReq = http.request(options, (proxyRes) => {
    const ctype = String(proxyRes.headers['content-type'] || '');
    const cenc = String(proxyRes.headers['content-encoding'] || '');
    if (!/text\/html/i.test(ctype) || cenc) { // 非 HTML 或已压缩 → 原样透传
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('error', () => { try { res.destroy(); } catch (e) {} });
    proxyRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      let out;
      try { out = rewriteKkfBody(raw.toString('utf8'), req.headers.host); }
      catch (e) { console.error('[kkf-body-rewrite]', e.message); out = null; }
      if (out === null) { res.writeHead(proxyRes.statusCode, proxyRes.headers); res.end(raw); return; }
      const headers = Object.assign({}, proxyRes.headers);
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding']; // ⚠️ 必须删：kkFileView 用 chunked 返回，若同时再带 Content-Length 属协议违规，客户端会直接报错（表现为 502/Bad gateway）
      headers['content-length'] = Buffer.byteLength(out, 'utf8');
      res.writeHead(proxyRes.statusCode, headers);
      res.end(out);
    });
  });
  proxyReq.on('error', (e) => {
    console.error('[kkf-proxy]', e.message);
    if (!res.headersSent) res.status(502).send('文档预览服务暂不可用');
  });
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') req.pipe(proxyReq);
  else proxyReq.end();
});

// JSON解析
app.use(express.json({ charset: 'utf-8' })); // 遵循世界杯教训：统一charset
app.use(express.urlencoded({ extended: true, charset: 'utf-8' }));

// 静态文件服务（照片）
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// 静态托管前端（Web App）：Express 同时提供 API 与前端，同源无 CORS
// 哈希路由（#/home 等）下浏览器只请求一次 '/'，由 express.static 返回 index.html
const webDir = path.join(__dirname, '..', '..', 'web');
const fs = require('fs');
// 自动从 index.html 的 app.js 版本戳探测构建版本号，避免手动同步
function detectBuildVersion() {
  try {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    const m = html.match(/js\/app\.js\?v=([0-9a-z]+)/);
    return m ? m[1] : 'dev';
  } catch (e) { return 'dev'; }
}
const BUILD_VERSION = detectBuildVersion();
// 启动时把 index.html 读入内存，供 SPA 入口注入 __BUILD_VERSION__ 占位符
let INDEX_HTML = null;
try { INDEX_HTML = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'); } catch (e) { INDEX_HTML = null; }

// 击穿微信(HTTP站点)对首页 index.html 的强缓存（白屏反复不愈的终极根因）：
// 微信对「无参数 URL」(http://host:port/) 按 URL 强缓存 HTML，且常忽略 no-store 头，
// 导致旧坏页面被缓存、时通时白。治本：入口「/」「/index.html」一律 302 跳转到带
// 版本号+时间戳的唯一地址 /?v=<BUILD>&_=<ts>，由该唯一地址承载真正的 app HTML。
// 这样①微信永远缓存不到「坏页面」(只会缓存一个 302 重定向)；②每次访问的落地地址都带
// 时间戳→视为新 URL→必重新拉取最新 HTML/JS，旧坏缓存被自动顶掉。深链 hash(#/xxx) 保留。
// ⚠️ 落地页必须**由本中间件返回注入了真实 BUILD_VERSION 的 HTML**，绝不能放行给
//    express.static（它会原样返回含字面量 __BUILD_VERSION__ 占位符的磁盘文件，
//    导致内联脚本跳到 /?v=__BUILD_VERSION__ 形成无限 302 死循环）。
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path !== '/' && req.path !== '/index.html') return next();
  // 已带正确版本（落地地址）：返回注入好 BUILD_VERSION 的 app HTML（200），不走 static
  if (req.query.v === BUILD_VERSION) {
    const html = (INDEX_HTML || '').replace(/__BUILD_VERSION__/g, BUILD_VERSION);
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(200).send(html);
  }
  const hashIdx = req.url.indexOf('#');
  const hash = hashIdx >= 0 ? req.url.slice(hashIdx) : '';
  const target = '/?v=' + BUILD_VERSION + '&_=' + Date.now() + hash;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.redirect(302, target);
});

// 首屏优化①：启用 HTTP 压缩（gzip）。仅压缩 compressible 文本类型（HTML/JS/CSS/JSON）且体积 >1KB；
// 字体(woff2 等)本身已压缩、图片另走静态，默认 filter 会自动跳过，不二次压缩。
// 放在静态资源与 API 路由之前，确保首屏文本资源（约 1.16MB）被压缩到约 1/3。
app.use(compression({ threshold: 1024, level: 6 }));

// JS/CSS：URL 已带 ?v= 构建版本戳，内容一变版本号就变 → 不存在"长缓存拿旧文件"的问题，
// 故改用 immutable 长缓存（一年），避免每次访问都重下，显著加速二次/回访加载。
// 字体文件名自带内容 hash，同样 immutable；其余（图片等）不缓存。
const FONT_MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
app.use(express.static(webDir, {
  setHeaders: (res, filePath) => {
    const ext = filePath.split('.').pop().toLowerCase();
    if (['js', 'css'].includes(ext)) {
      // 2026-10-10 改：原为 `public, max-age=31536000, immutable`（永久缓存+immutable），
      //   代价是**浏览器一旦取过某个 URL 就永久锁定**，前端改动后用户不手动刷新就永远看不到新版
      //   （2026-10-10 多选功能已实际发生"改了没生效"的对话）。
      // 现策略：`max-age=60, must-revalidate` + Express 默认开启的 ETag 协商——
      //   ① 60 秒内重复访问直接走本地缓存，零网络请求（保留首屏速度收益）；
      //   ② 超过 60 秒自动带 If-None-Match 回源校验，文件没变返回 **304（几十字节）**；
      //      文件变了返回 200 + 新内容 → **用户无需手动刷新即可拿到新版**。
      //   代价：每次部署后首个访问者会拿到一次 200（新文件），其余仍走 304，整体影响可忽略。
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    } else if (ext === 'html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else if (FONT_MIME[ext]) {
      // 字体：①显式声明 MIME——部分安卓微信 X5/XWeb 内核对字体 MIME 校验很严，
      //         只认标准 font/* 类型，认不出就整站拒绝加载该字体；
      //       ②文件名内含内容 hash（intent-latin.<hash>.woff2），内容一变文件名就变，
      //         不存在"长缓存拿旧字体"的问题 → 放心 immutable 缓存一年。
      res.setHeader('Content-Type', FONT_MIME[ext]);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// API路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/pdca', require('./routes/pdca'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/quality-dissem', require('./routes/qualityDissem'));
app.use('/api/quality-topics', require('./routes/qualityTopics'));
app.use('/api/divisions', require('./routes/divisions'));
app.use('/api/flowers', require('./routes/flowers'));
app.use('/api/ima', require('./routes/imaStatus')); // IMA 同步状态（供主动监控横幅）
app.use('/api/serverchan', require('./routes/serverchan')); // Server酱（ServerChan）微信提醒绑定：粘贴 SendKey，免扫码免 App
app.use('/api/client-log', require('./routes/clientlog')); // 前端错误上报（无鉴权，仅记录，供排查白屏）
app.use('/api/stats', require('./routes/stats'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/download', require('./routes/download')); // 带友好文件名的下载（WPS/微信收藏兼容）
app.use('/api/memos', require('./routes/memos')); // 项目备忘（📝项目备忘子应用，纯增量）
app.use('/api/read-acks', require('./routes/readAcks')); // 已阅确认（取代通用评论：公告/宣贯/PDCA 院选公示）
app.use('/api/exam', require('./routes/exam')); // 检验池（出图考试：出题/批改/计分/排名）
app.use('/api/qa', require('./routes/qa')); // 质量库问答（FTS5 纯检索，Phase 1 无 LLM；索引见 src/qa_index.js）

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// API版本信息
app.get('/api', (req, res) => {
  res.json({
    name: '质量千里行 API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      upload: '/api/upload',
      admin: '/api/admin',
      announcements: '/api/announcements',
    },
  });
});

// 404处理（带 requestId，便于凭错误编号在日志中精准定位请求）
app.use((req, res) => {
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  res.status(404).json({ error: 'Not Found', path: req.path, requestId });
});

// 错误处理
app.use((err, req, res, next) => {
  // 审计 L-2（2026-09-11）：5xx 日志补时间戳/方法/路径/状态码，否则排查线上报错时无法对时间线定位
  console.error(`❌ [${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${err.status || 500} :`, err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── 全局未捕获异常/拒绝守卫（防 async 路由抛错崩服）────────
// Node 22 默认 --unhandled-rejections=throw：任意 async 路由内 await 抛出未 catch 的 rejection
// 会导致整个进程退出（PM2 虽会重启，但期间全站 5xx 且 DB/WAL 重连有抖动）。
// 这里兜底记录并让进程存活；严重错误可后续加 pm2 gracefulRestart 策略。
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason && reason.message || reason, promise);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});

// 启动服务
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 质量千里行 API 服务已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   环境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   健康检查: http://localhost:${PORT}/health`);
});

// ── IMA 同步对账（自愈）──────────────────────────
// 背景：质量宣贯审核通过 / 公告发布 时的 IMA 推送被 try/catch 静默吞掉，
//   任何 IMA/COS 瞬时故障都会永久丢失同步（ima_media_id 残留 null / ima_synced=0），
//   且无法自动恢复。这里在启动后做一次对账，并周期性（6h）重推漏网记录，闭环自愈。
const { reconcileIma } = require('./imaReconcile');
const IMA_RECONCILE_MS = 6 * 60 * 60 * 1000;
// 启动 5s 后首跑（让监听先就绪，避免拖慢启动日志），之后每 6 小时周期跑
setTimeout(() => {
  reconcileIma().catch((e) => console.error('[IMA对账] 启动对账异常：', e && e.message));
}, 5000);
setInterval(() => {
  reconcileIma().catch((e) => console.error('[IMA对账] 周期对账异常：', e && e.message));
}, IMA_RECONCILE_MS);

module.exports = app;
