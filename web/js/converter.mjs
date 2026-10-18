// converter.js — ExcelJS Workbook -> Univer IWorkbookData (ES module, pure JS)
// Handles: bold/italic/size/font-color, solid fill fgColor, alignment, borders,
// theme colors (with tint), indexed colors, column widths, row heights, merges.

// 修复 WPS 生成的非标准 xlsx：zip 内部路径用反斜杠（xl\workbook.xml），
// ExcelJS 按 OPC 规范只认正斜杠 → 解析出 0 个工作表（2026-10-11 线上宣贯附件实证）。
// 检测到反斜杠条目时用 JSZip 重打包为标准路径；正常文件原样返回（零开销）。
export async function normalizeZipPaths(buffer) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) return buffer;
  const z = await JSZip.loadAsync(buffer);
  const names = Object.keys(z.files);
  if (!names.some(n => n.indexOf('\\') >= 0)) return buffer; // 标准包，无需处理
  const out = new JSZip();
  for (const n of names) {
    const f = z.files[n];
    const fixed = n.replace(/\\/g, '/');
    if (f.dir) { out.folder(fixed); continue; }
    const data = await f.async('arraybuffer');
    out.file(fixed, data);
  }
  return out.generateAsync({ type: 'arraybuffer' });
}

const STD_INDEXED = [
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080',
  '9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF',
  '00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696',
  '003366','339966','003300','333300','993300','993366','333399','333333',
  '000000','FFFFFF' /* 64 system window background -> white-ish */
];

// Resolve the 12 theme colors from the xlsx theme1.xml via JSZip.
// ExcelJS (0.18.x) does not expose wb.themes reliably, so we parse it ourselves.
export async function extractThemeColors(buffer) {
  try {
    const JSZip = globalThis.JSZip;
    if (!JSZip) return {};
    const z = await JSZip.loadAsync(buffer);
    const files = Object.keys(z.files);
    const tf = files.find(f => /^xl\/theme\/theme\d+\.xml$/.test(f));
    if (!tf) return {};
    const xml = await z.file(tf).async('string');
    const names = ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
    const map = {};
    names.forEach((n, i) => {
      const re = new RegExp('<a:' + n + '>([\\s\\S]*?)<\\/a:' + n + '>', 'g');
      const m = re.exec(xml);
      if (!m) return;
      const inner = m[1];
      let rgb = null;
      const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(inner);
      if (srgb) rgb = srgb[1];
      else {
        const sys = /<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(inner);
        if (sys) rgb = sys[1];
      }
      if (rgb) map[i] = '#' + rgb.toUpperCase();
    });
    return map;
  } catch (e) { return {}; }
}

function applyTint(hex, tint) {
  if (tint == null || tint === 0) return hex;
  let r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  const f = (c) => c + (255 - c) * tint;
  const g2 = (c) => c * (1 + tint);
  r = Math.round(tint < 0 ? g2(r) : f(r));
  g = Math.round(tint < 0 ? g2(g) : f(g));
  b = Math.round(tint < 0 ? g2(b) : f(b));
  const h = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2,'0');
  return h(r) + h(g) + h(b);
}

function normColor(c, themeColors) {
  if (!c) return null;
  let rgb = null, tint = null;
  if (typeof c === 'string') rgb = c;
  else if (c.argb) rgb = c.argb;
  else if (c.rgb) rgb = c.rgb;
  else if (c.theme != null) rgb = themeColors[c.theme];
  else if (c.indexed != null) rgb = STD_INDEXED[c.indexed];
  if (c && typeof c === 'object') tint = c.tint;
  if (rgb == null) return null;
  rgb = String(rgb).replace('#','').trim();
  if (rgb.length === 8) rgb = rgb.slice(2);
  if (rgb.length === 6) return '#' + applyTint(rgb.toUpperCase(), tint).toUpperCase();
  return null;
}

const HMAP = { left:1, center:2, right:3, justify:4, fill:1, general:1, distributed:4 };
const VMAP = { top:1, middle:2, bottom:3, center:2, distributed:2 };
const SMAP = { thin:1, medium:2, thick:5, dashed:4, dotted:4, double:6, hair:1,
  mediumDashed:4, dashDot:4, mediumDashDot:4, dashDotDot:4, slantDashDot:4 };

function borderSide(e, themeColors) {
  if (!e || !e.style) return null;
  return { s: SMAP[e.style] || 1, cl: { rgb: normColor(e.color, themeColors) || '#000000' } };
}

function cellValue(cell) {
  const v = cell.value;
  if (v == null) return undefined;
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result;
    if (v.formula !== undefined) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.text != null) return v.text;
    return undefined;
  }
  if (v instanceof Date) return cell.text || v.toISOString().slice(0,10);
  return v;
}

function a1ToRC(a1) {
  const m = String(a1).match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0; const letters = m[1];
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return { r: parseInt(m[2],10), c: col };
}

export function exceljsToUniver(wb, LocaleType, themeColors) {
  themeColors = themeColors || {};

  function styleOf(cell) {
    const out = {};
    const f = cell.font;
    if (f) {
      if (f.bold) out.bl = 1;
      if (f.italic) out.it = 1;
      if (f.size) out.fs = Math.round(f.size);
      const fc = normColor(f.color, themeColors);
      if (fc) out.cl = { rgb: fc };
    }
    const fl = cell.fill;
    if (fl && fl.type === 'pattern' && fl.pattern && fl.pattern !== 'none') {
      const bg = normColor(fl.fgColor, themeColors);
      if (bg) out.bg = { rgb: bg };
    }
    const a = cell.alignment;
    if (a) {
      if (a.horizontal && HMAP[a.horizontal] != null) out.ht = HMAP[a.horizontal];
      if (a.vertical && VMAP[a.vertical] != null) out.vt = VMAP[a.vertical];
      if (a.wrapText) out.tb = 2;
    }
    const b = cell.border;
    if (b) {
      const bd = {};
      const t = borderSide(b.top, themeColors), bo = borderSide(b.bottom, themeColors),
            l = borderSide(b.left, themeColors), r = borderSide(b.right, themeColors);
      if (t) bd.t = t; if (bo) bd.b = bo; if (l) bd.l = l; if (r) bd.r = r;
      if (Object.keys(bd).length) out.bd = bd;
    }
    return out;
  }

  const styles = {}; const cache = {}; let sid = 0;
  function getStyle(cell) {
    const st = styleOf(cell);
    const key = JSON.stringify(st);
    if (cache[key] != null) return cache[key];
    if (!Object.keys(st).length) return null;
    const id = 's' + (++sid); styles[id] = st; cache[key] = id; return id;
  }

  const sheets = {}; const sheetOrder = []; let gid = 0;
  wb.worksheets.forEach((ws) => {
    const rowCount = ws.rowCount || 0;
    const columnCount = ws.columnCount || 0;
    const cellData = {};
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= columnCount; c++) {
        const cell = row.getCell(c);
        const v = cellValue(cell);
        const st = getStyle(cell);
        if (v !== undefined || st) {
          if (!cellData[r-1]) cellData[r-1] = {};
          const o = {};
          if (v !== undefined) o.v = v;
          if (st) o.s = st;
          cellData[r-1][c-1] = o;
        }
      }
    }
    const rowData = {}, columnData = {};
    for (let c = 1; c <= columnCount; c++) {
      const col = ws.getColumn(c);
      if (col && col.width) columnData[c-1] = { w: Math.round(col.width * 7) };
    }
    for (let r = 1; r <= rowCount; r++) {
      const rh = ws.getRow(r).height;
      if (rh) rowData[r-1] = { h: Math.round(rh * 1.333) };
    }
    const mergeData = (ws.model.merges || []).map((m) => {
      const [a, b] = String(m).split(':');
      const s = a1ToRC(a);
      const e = b ? a1ToRC(b) : s;
      if (!s || !e) return null;
      return { startRow: s.r-1, endRow: e.r-1, startColumn: s.c-1, endColumn: e.c-1 };
    }).filter(Boolean);

    const id = 'sheet' + (++gid);
    sheetOrder.push(id);
    sheets[id] = {
      id, name: ws.name, rowCount, columnCount,
      defaultColumnWidth: 72, defaultRowHeight: 20, showGridlines: 1,
      cellData, rowData, columnData, mergeData
    };
  });

  return {
    id: 'wb1', name: (wb.worksheets[0] && wb.worksheets[0].name) || 'Sheet',
    appVersion: '0.10.2', locale: LocaleType.EN_US,
    styles, sheetOrder, sheets
  };
}
