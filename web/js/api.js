/**
 * API 封装层
 *
 * 自动附带 JWT token；支持 DEMO 模式（无后端时用内存数据演示）
 * DEMO 模式：当 window.DEMO_MODE=true 或后端不可达时启用
 */

const API = (() => {
  const BASE = ''; // 同源，Express 静态托管
  const TOKEN_KEY = 'qc_token';

  // 微信 WebView / 隐私模式下 localStorage 可能不可用（访问即抛 SecurityError），
  // 若直接裸读写会令 App.init() 首行 getToken() 抛错、整页初始化中断 → 白屏。
  // 故统一加 try/catch，并以内存变量兜底（不持久化，但保证不崩溃、登录本次会话可用）。
  let _memToken = null;
  let _lsOk = false;
  try {
    const probe = '__qc_ls_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    _lsOk = true;
  } catch (e) { _lsOk = false; }

  function getToken() {
    if (_lsOk) { try { return localStorage.getItem(TOKEN_KEY); } catch (e) {} }
    return _memToken;
  }
  function setToken(t) {
    _memToken = t;
    if (_lsOk) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  }
  function clearToken() {
    _memToken = null;
    if (_lsOk) { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  }

  async function request(method, path, body) {
    if (window.DEMO_MODE) return DEMO.handle(method, path, body);

    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.includes('/login')) {
        clearToken();
        location.hash = '#/login';
      }
      throw new Error(data.error || '请求失败');
    }
    return data;
  }

  return {
    getToken, setToken, clearToken,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),

    // 上传照片（DEMO 模式返回 base64 预览）
    async upload(files) {
      if (window.DEMO_MODE) {
        const urls = [];
        for (const f of files) urls.push(await fileToDataUrl(f));
        return { urls };
      }
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      const res = await fetch(BASE + '/api/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      return data;
    },
  };
})();

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
