/**
 * bcrypt 线程池（2026-10-18 大会赛前加固）
 *
 * 背景（生产实测）：
 *   - bcryptjs 是纯 JS，跑在主线程。同步版 cost10 ≈ 93ms/次独占事件循环，
 *     80 人同时登录 = 80×93ms ≈ 7.4s 全站无响应（静态资源/业务接口全部排队）。
 *   - 异步版（bcrypt.compare）每次让出间隔长达 100ms（MAX_EXECUTION_TIME），
 *     高并发下轮询分片仍会饿死 I/O——实测 60 路登录洪峰中，一个静态首页请求
 *     被堵 3.7s（本机 burst 测试：静态 max=3741ms）。
 *   - 原生 bcrypt 模块生产未安装，大会前夜现装需现场编译，风险不可接受。
 *
 * 方案：worker_threads 池。bcrypt 计算全部在子线程完成，主线程事件循环零阻塞；
 * 子线程崩溃/超时/启动失败 → 自动降级回进程内 bcryptjs 异步版，功能不中断
 * （降级后至少不会比改造前更差）。
 *
 * API（Promise 风格）：
 *   compare(plain, hash) -> Promise<boolean>   // 仅在校验失败时 reject（真错误）
 *   hash(plain, rounds)  -> Promise<string>
 */
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');

const POOL_SIZE = Math.min(4, Math.max(2, (os.cpus() || []).length || 2));
const TIMEOUT_MS = 20000; // 单次 bcrypt 正常 ~100ms；20s 无果视为 worker 卡死

let workers = [];        // [{ w, busy, job }]
let queue = [];          // 等待中的任务
let degraded = false;    // 结构性失败（建不起 worker）→ 永久走进程内兜底
let seq = 0;

function log() {
  try { console.error('[bcryptPool]', ...arguments); } catch (_) { /* ignore */ }
}

// 进程内异步兜底：与 2026-10-18 auth.js 异步化改造一致，保证任何情况下登录可用
function inProcessCompare(a, b) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(a, b, (err, valid) => {
      if (err) reject(err); else resolve(!!valid);
    });
  });
}
function inProcessHash(a, rounds) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(a, rounds, (err, hash) => {
      if (err) reject(err); else resolve(hash);
    });
  });
}

function spawn() {
  const w = new Worker(path.join(__dirname, 'bcrypt.worker.js'));
  const item = { w, busy: false, job: null };
  w.on('message', (msg) => {
    const job = item.job;
    item.job = null;
    item.busy = false;
    if (job) {
      clearTimeout(job.timer);
      if (msg && msg.err) job.reject(new Error(msg.err));
      else if (job.op === 'compare') job.resolve(!!(msg && msg.valid));
      else job.resolve(msg && msg.hash);
    }
    pump();
  });
  w.on('error', (e) => {
    log('worker error:', e && e.message);
    failWorker(item, new Error('worker error'));
  });
  w.on('exit', (code) => {
    if (code !== 0) log('worker exit code', code);
    failWorker(item, new Error('worker exit ' + code));
  });
  workers.push(item);
  return item;
}

// worker 不可用：把它上面的任务转进程内兜底，并补充新 worker（除非已降级）
function failWorker(item, err) {
  const job = item.job;
  item.job = null;
  item.busy = false;
  workers = workers.filter((x) => x !== item);
  try { item.w.terminate().catch(() => {}); } catch (_) { /* ignore */ }
  if (job) {
    clearTimeout(job.timer);
    log('job fallback to in-process:', err && err.message);
    job.runFallback();
  }
  if (!degraded && workers.length === 0) {
    try { spawn(); } catch (e) { degraded = true; log('respawn failed, degrade permanently:', e.message); }
  }
  pump();
}

function pump() {
  while (queue.length) {
    const job = queue[0];
    if (degraded) { queue.shift(); job.runFallback(); continue; }
    const free = workers.find((x) => !x.busy);
    if (!free) return;
    queue.shift();
    free.busy = true;
    free.job = job;
    job.timer = setTimeout(() => {
      log('job timeout, terminate worker');
      failWorker(free, new Error('timeout'));
    }, TIMEOUT_MS);
    try {
      free.w.postMessage({ id: job.id, op: job.op, a: job.a, b: job.b });
    } catch (e) {
      failWorker(free, e);
    }
  }
}

function enqueue(op, a, b) {
  return new Promise((resolve, reject) => {
    const job = {
      id: ++seq, op, a, b, resolve, reject, timer: null,
      runFallback() {
        const p = op === 'compare' ? inProcessCompare(a, b) : inProcessHash(a, b);
        p.then(resolve, reject);
      },
    };
    if (degraded) { job.runFallback(); return; }
    queue.push(job);
    pump();
  });
}

// 启动即建池；失败不致命（degraded 后自动走进程内兜底）
for (let i = 0; i < POOL_SIZE; i++) {
  try { spawn(); } catch (e) { degraded = true; log('spawn failed, degrade:', e.message); break; }
}
log('pool size =', workers.length, degraded ? '(degraded)' : '');

module.exports = {
  compare: (plain, hash) => enqueue('compare', plain, hash),
  hash: (plain, rounds) => enqueue('hash', plain, rounds),
  _debug: () => ({ poolSize: POOL_SIZE, alive: workers.length, queued: queue.length, degraded }),
};
