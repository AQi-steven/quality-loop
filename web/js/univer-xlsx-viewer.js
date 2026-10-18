// univer-xlsx-viewer.js — 高保真 Excel 只读预览（Univer + ExcelJS）。
// 仅在本文件被动态 import 时才会下载 Univer 引擎，首次打开 Excel 才触发，之后浏览器缓存。
// 2026-10-12：新增触屏手势层（单指拖动=滚动、双指捏合=缩放、双击=放大复原、浮钮），见 attachGestures。
import { createUniver, LocaleType, mergeLocales, enUS, UniverSheetsCorePreset } from '../vendor/univer/univer.mjs';
import { exceljsToUniver, extractThemeColors, normalizeZipPaths } from './converter.mjs';

// 懒加载 UMD 全局依赖（ExcelJS / JSZip / Univer CSS），仅首次预览时下载
function injectScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}
function injectCss(href) {
  if (document.querySelector('link[href="' + href + '"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
let _libsReady = null;
function ensureLibs() {
  if (_libsReady) return _libsReady;
  const v = (document.querySelector('meta[name="build-version"]') || {}).content || '';
  _libsReady = Promise.all([
    injectCss('vendor/univer/univer.css?v=' + v),
    injectScript('vendor/exceljs/exceljs.min.js?v=' + v),
    injectScript('vendor/jszip/jszip.min.js?v=' + v),
  ]).then(() => {
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS 组件未就绪');
  });
  return _libsReady;
}

let _inst = null;
function disposePrev() {
  try { if (_inst && typeof _inst.dispose === 'function') _inst.dispose(); } catch (e) {}
  _inst = null;
}

// ── 触屏手势层（2026-10-12）────────────────────────────
// Univer 是 canvas 渲染，CSS transform 平移只会露出空白区，必须把触摸手势转成
// Univer 自己的事件机制。已从 vendor/univer/univer.mjs 源码实证：
//   ① 引擎把 'wheel' 直接绑在引擎 canvas 元素上（getCanvasElement().addEventListener）；
//   ② 普通 wheel → 工作表滚动（delta 按 scene 缩放折算）；
//   ③ ctrl+wheel → 缩放：inc = clamp(-deltaY*0.008, 放大±0.07 / 缩小±0.14)，倍率截断 [0.1, 4]，0.01 取整。
// 因此：单指拖动 → 合成 wheel（滚动）；双指捏合 → 合成 ctrl+wheel（缩放）+中点位移滚动；
// 双击 → 1x↔2.5x；右下角浮钮 +/−/⦿（仅触屏设备显示，桌面用原生 ctrl+滚轮）。
const G_ZOOM_MIN = 0.5, G_ZOOM_MAX = 4;

function attachGestures(container, inst) {
  let canvas = null;
  let estZoom = 1;   // 镜像倍率（facade 取不到时兜底；每次派发后按 Univer 规则同步）
  function findCanvas() {
    if (canvas && container.contains(canvas)) return canvas;
    let best = null, bestA = 0;
    container.querySelectorAll('canvas').forEach(cv => {
      const r = cv.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestA) { best = cv; bestA = a; }
    });
    canvas = best;
    return canvas;
  }
  function currentZoom() {
    try {
      const ws = inst.getActiveWorkbook().getActiveSheet();
      if (ws && typeof ws.getZoomRatio === 'function') {
        const z = Number(ws.getZoomRatio());
        if (Number.isFinite(z) && z > 0) return z;
      }
    } catch (e) {}
    return estZoom;
  }
  // deltaRatio>0 放大、<0 缩小；自动拆成多事件（单事件步长受 Univer 上限约束）
  function dispatchZoom(deltaRatio) {
    const cv = findCanvas();
    if (!cv || !Number.isFinite(deltaRatio) || Math.abs(deltaRatio) < 0.001) return;
    const r = cv.getBoundingClientRect();
    let remaining = deltaRatio, guard = 0;
    while (Math.abs(remaining) > 0.005 && guard++ < 80) {
      const per = remaining < 0 ? 0.14 : 0.07;                    // 放大单步上限 0.07，缩小 0.14（源码 Y1t/X1t）
      const inc = Math.max(-per, Math.min(per, remaining));
      const dy = -inc / 0.008;                                    // 源码 q1t=0.008
      cv.dispatchEvent(new WheelEvent('wheel', {
        deltaX: 0, deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      estZoom = Math.round(Math.max(0.1, Math.min(4, estZoom + inc)) * 100) / 100;
      remaining -= inc;
    }
  }
  function dispatchScroll(dx, dy, x, y) {
    const cv = findCanvas();
    if (!cv || (!dx && !dy)) return;
    cv.dispatchEvent(new WheelEvent('wheel', {
      deltaX: dx, deltaY: dy, ctrlKey: false, bubbles: true, cancelable: true, view: window, clientX: x, clientY: y,
    }));
  }

  const S = { mode: 'idle', lx: 0, ly: 0, d0: 1, z0: 1, mx: 0, my: 0, tapT: 0, tapX: 0, tapY: 0 };
  container.style.touchAction = 'none';
  container.addEventListener('touchstart', e => {
    const t = e.touches;
    if (t.length === 1) {
      const x = t[0].clientX, y = t[0].clientY, now = Date.now();
      if (S.tapT && now - S.tapT < 300 && Math.hypot(x - S.tapX, y - S.tapY) < 30) {
        const target = currentZoom() > 1.3 ? 1 : 2.5;   // 双击：放大 ↔ 复原
        dispatchZoom(target - currentZoom());
        S.tapT = 0;
      } else {
        S.tapT = now; S.tapX = x; S.tapY = y;
      }
      S.lx = x; S.ly = y; S.mode = 'pan';
    } else if (t.length >= 2) {
      S.mode = 'pinch';
      S.d0 = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
      S.z0 = currentZoom();
      S.mx = (t[0].clientX + t[1].clientX) / 2;
      S.my = (t[0].clientY + t[1].clientY) / 2;
      S.tapT = 0;
    }
  }, { passive: false });
  container.addEventListener('touchmove', e => {
    e.preventDefault();   // 手势层接管，防浏览器滚动/下拉刷新
    const t = e.touches;
    if (S.mode === 'pan' && t.length === 1) {
      const x = t[0].clientX, y = t[0].clientY;
      // 触屏语义=内容跟随手指：手指下拉应看上方内容 → wheel 位移取反（滚轮语义与触屏相反，2026-10-12 用户实测反馈）
      dispatchScroll(-(x - S.lx), -(y - S.ly), x, y);
      S.lx = x; S.ly = y;
    } else if (S.mode === 'pinch' && t.length >= 2) {
      const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
      const target = Math.max(G_ZOOM_MIN, Math.min(G_ZOOM_MAX, S.z0 * d / S.d0));
      const need = target - currentZoom();
      if (Math.abs(need) > 0.005) dispatchZoom(need);
      const mx = (t[0].clientX + t[1].clientX) / 2, my = (t[0].clientY + t[1].clientY) / 2;
      dispatchScroll(-(mx - S.mx), -(my - S.my), mx, my);   // 捏合中点位移=平移（同样取反）
      S.mx = mx; S.my = my;
    }
  }, { passive: false });
  const end = e => {
    const t = e.touches;
    if (t.length === 1) { S.mode = 'pan'; S.lx = t[0].clientX; S.ly = t[0].clientY; }   // 捏合收指→单指续航不跳变
    else if (!t.length) S.mode = 'idle';
  };
  container.addEventListener('touchend', end, { passive: true });
  container.addEventListener('touchcancel', end, { passive: true });

  // 右下角浮钮（桌面 pointer:fine 隐藏，见 style.css）
  const bar = document.createElement('div');
  bar.className = 'xls-gz-bar';
  bar.innerHTML = '<button type="button" data-a="in" aria-label="放大">＋</button>'
    + '<button type="button" data-a="reset" aria-label="复原">⦿</button>'
    + '<button type="button" data-a="out" aria-label="缩小">－</button>';
  bar.addEventListener('click', e => {
    const a = e.target && e.target.getAttribute('data-a');
    if (!a) return;
    e.stopPropagation();
    if (a === 'in') dispatchZoom(0.25);
    else if (a === 'out') dispatchZoom(-0.25);
    else dispatchZoom(1 - currentZoom());
  });
  container.appendChild(bar);
}

// 渲染入口：container = 定位容器(.xls-univer)，arrayBuffer = xlsx 文件字节
async function previewExcelUniver(container, arrayBuffer) {
  await ensureLibs();
  disposePrev();
  container.innerHTML = '';
  // WPS 反斜杠路径包先归一化（否则 ExcelJS 解析出 0 个工作表）
  const stdBuf = await normalizeZipPaths(arrayBuffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(stdBuf));
  const themeColors = await extractThemeColors(stdBuf);
  const data = exceljsToUniver(wb, LocaleType, themeColors);
  const host = document.createElement('div');
  host.className = 'xls-univer-host';
  container.appendChild(host);
  const res = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(enUS) },
    presets: [UniverSheetsCorePreset({ container: host })],
  });
  _inst = res.univer;
  const wbook = res.univerAPI.createWorkbook(data);
  if (wbook && typeof wbook.setEditable === 'function') wbook.setEditable(false);
  attachGestures(container, res.univerAPI);
  // 当前缩放倍率（调试/验证用；facade 无 getZoomRatio 时返回 null）
  window.UniverXlsx.getZoomRatio = function () {
    try {
      const ws = res.univerAPI.getActiveWorkbook().getActiveSheet();
      if (ws && typeof ws.getZoomRatio === 'function') { const z = Number(ws.getZoomRatio()); return Number.isFinite(z) && z > 0 ? z : null; }
    } catch (e) {}
    return null;
  };
  return res.univer;
}

// ⚠️ 挂到独立命名空间 window.UniverXlsx，而不是 window.UI：
// ui.js 的 UI 是顶层 `const UI = (...)()`（词法绑定），不挂 window——若挂到 window.UI 上，
// ui.js 里的 `UI.previewExcelUniver` 永远取不到 → 所有 Excel 预览都走「引擎加载失败」兜底
// （2026-10-11 线上实证：首版上线后全部预览失败即此因）。
window.UniverXlsx = window.UniverXlsx || {};
window.UniverXlsx.previewExcelUniver = previewExcelUniver;
window.UniverXlsx.disposeExcelUniver = disposePrev;
export { previewExcelUniver };
