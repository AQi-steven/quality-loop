/**
 * 质量千里行 — Service Worker（常驻 · 纯网络透传 · 零缓存）
 *
 * 作用：仅为满足 Chrome / Android「可安装到主屏幕」标准（要求一个带 fetch 处理、
 * 且常驻的 SW）。本 SW 不缓存任何资源、不拦截响应，所有请求直接走网络——
 * 因此绝不会重现旧版 cache-first SW 把 502 当静态资源缓存导致白屏的问题，
 * 也不阻碍部署更新即时生效（每次都走网络 + 入口页版本戳强制刷新）。
 *
 * 首启激活时仍会清空历史遗留缓存（删掉旧版可能损坏的 app.js/css 缓存），
 * 之后常驻控制页面，不再自杀。
 */
self.addEventListener('install', (e) => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 仅清理历史遗留缓存，避免旧版 SW 留下的损坏缓存干扰；之后不再触碰缓存
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 纯透传：不调用 respondWith，浏览器直接走网络（无缓存、无 502 污染）
self.addEventListener('fetch', (e) => { /* no-op: 浏览器直接走网络 */ });
