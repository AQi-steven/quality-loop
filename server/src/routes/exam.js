/**
 * 检验池（出图考试）
 *
 * 定位：对「千里行质量库」(IMA 000千里行质量库) 文档内容出题，自动批改、计分、排名。
 *   - 题库（exam_questions）由 AI 从 IMA 内容出题、按专业打标，预建入库（见 seed-exam.js）。
 *   - 出题范围：建筑 / 给排水 / 暖通 / 通信 / 电气 / 通用（多选；通用=无专业倾向的题）。
 *   - 即时组卷：点击「开始考试」按所选范围抽取 10 道选择题（按范围比例 + 宣贯内容加权），
 *     每题 1 正确 + 3 接近选项，ABCD 每人独立乱序（防作弊）。
 *   - 计分：答对 +10，答错/不答 0 分；提交后服务端权威批改。
 *   - 个人「历次成绩」：记录本人每场考试的得分。
 *   - 排名：超级管理员 / 专总 / 院长 可选某场考试，自动按 分数降序 → 用时升序 排名。
 *
 * 权限：全部需登录；游客（isGuest）仅可浏览列表，不能发起 / 作答，但可查看排名（只读）。
 *   发起 / 删除考试（轮次）：仅 超级管理员 / ××× / ××× 三人。排名：超级管理员 + 专总 + 院长。
 */
const express = require('express');
const db = require('../db/connection');
const authMiddleware = require('../middleware/auth');
const rbac = require('../rbac');

const router = express.Router();
router.use(authMiddleware);

// 可选专业范围（前端复选框顺序也按此）
const DISCIPLINES = ['建筑', '给排水', '暖通', '通信', '电气', '通用'];

// 排名权限：已登录用户均可查看（含游客只读角色），不设角色限制。
// 发起 / 删除考试权限（创建轮次 + 删除轮次）：仅 超级管理员(superadmin) / ×××(wuzhenwu) / ×××(panhongyao) 三人
const EXAM_ADMINS = ['superadmin'];
const EXAM_ADMIN_NAMES = ['超级管理员', '×××', '×××'];
function isExamAdmin(u) {
  if (!u || u.isGuest) return false;
  if (EXAM_ADMINS.includes(u.username)) return true;
  if (EXAM_ADMIN_NAMES.includes(u.realName)) return true;
  return false;
}

// Fisher-Yates 洗牌，返回新数组
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 原「按范围题量比例」组卷（auto）：多专业复选时沿用。
//   - 每专业独立洗牌后再抽（真随机，破「同范围同题数必重发原题」以致背题的漏洞）；
//   - 宣贯题按 3 倍权重优先进入题集（刚宣贯的重点多考）；
//   - 每被选专业保底 1 题；
//   - 长度稀释：优先抽取「正确答案不是最长选项」的题，把「一律选最长」蒙对率从 83% 压到约 30%（接近随机 25%），防套路；
//   - 兜底：所选范围题量 < n 时自动从「通用」补充（通用=无专业倾向的题）。
function drawAuto(valid, n = 10) {
  const placeholders = valid.map(() => '?').join(',');
  let pool = db.prepare(`SELECT * FROM exam_questions WHERE discipline IN (${placeholders})`).all(...valid);
  if (pool.length < n) {
    const have = new Set(pool.map(q => q.id));
    const generals = db.prepare(`SELECT * FROM exam_questions WHERE discipline='通用'`).all();
    for (const g of generals) { if (!have.has(g.id)) { pool.push(g); if (pool.length >= n) break; } }
  }
  if (pool.length < n) throw { status: 400, message: `当前所选范围题库不足：仅有 ${pool.length} 题，需至少 ${n} 题（可勾选更多专业或「通用」）` };

  // 该题「正确答案是否恰好是最长选项」（用于长度稀释，降低「选最长」蒙对率）
  const optLen = (q) => JSON.parse(q.options).map(o => o.length);
  const ansIsLongest = (q) => { const os = optLen(q); return os[q.answer_index] === Math.max(...os); };
  const weight = (q) => (q.is_dissem ? 3 : 1);

  // 按专业分组；每组构建「false 优先 + 宣贯加权 + 已洗牌」的加权池
  const byDisc = {};
  for (const q of pool) (byDisc[q.discipline] || (byDisc[q.discipline] = [])).push(q);
  function buildPool(list) {
    const falseList = shuffle(list.filter(q => !ansIsLongest(q)));
    const trueList = shuffle(list.filter(q => ansIsLongest(q)));
    const w = [];
    for (const q of falseList) for (let i = 0; i < weight(q); i++) w.push(q);
    for (const q of trueList) for (let i = 0; i < weight(q); i++) w.push(q);
    return w; // false 优先在前、宣贯占 3 份、整体已洗牌
  }
  const pools = {};
  for (const d of Object.keys(byDisc)) pools[d] = buildPool(byDisc[d]);

  const chosen = [];
  const usedIds = new Set();
  const takeFrom = (list, maxTake) => {
    for (const q of list) {
      if (chosen.length >= n || maxTake <= 0) break;
      if (usedIds.has(q.id)) continue;
      chosen.push(q); usedIds.add(q.id); maxTake--;
    }
    return maxTake;
  };
  // 1) 每个被选专业保底 1 题（从该专业加权洗牌池随机取 1）
  for (const d of valid) {
    if (chosen.length >= n) break;
    if (pools[d] && pools[d].length) takeFrom(pools[d], 1);
  }
  // 2) 剩余名额：按选中专业各自可用题量比例分配，从各专业加权洗牌池随机抽
  const remain = n - chosen.length;
  if (remain > 0) {
    const discAvail = {};
    let totalAvail = 0;
    for (const d of valid) {
      const avail = (pools[d] || []).filter(q => !usedIds.has(q.id)).length;
      discAvail[d] = avail;
      totalAvail += avail;
    }
    const discQuota = {};
    let allocated = 0;
    for (const d of valid) {
      const q = totalAvail > 0 ? Math.round((discAvail[d] / totalAvail) * remain) : 0;
      discQuota[d] = q;
      allocated += q;
    }
    if (allocated !== remain && valid.length > 0) {
      const richest = valid.reduce((a, b) => (discAvail[a] || 0) > (discAvail[b] || 0) ? a : b);
      discQuota[richest] += (remain - allocated);
    }
    for (const d of valid) takeFrom(pools[d] || [], discQuota[d] || 0);
  }
  // 3) 若仍未凑满（某专业配额超出其实际题量），从全池加权洗牌后补充（去重）
  if (chosen.length < n) {
    const allWeighted = [];
    for (const d of Object.keys(pools)) for (const q of pools[d]) allWeighted.push(q);
    const fallback = shuffle(allWeighted).filter(q => !usedIds.has(q.id));
    while (chosen.length < n && fallback.length) {
      const q = fallback.shift();
      if (usedIds.has(q.id)) continue;
      chosen.push(q); usedIds.add(q.id);
    }
  }
  return shuffle(chosen); // 题序也随机
}

// ── 组卷：宣贯 / 公告 判定 ──────────────────────────────────────
// 宣贯题：is_dissem=1（千里行「宣贯」内容；占比按整卷口径计）
// 公告题：来源名含「公告」（千里行公告栏内容；按整卷口径设上限）
function isDissemQ(q) { return q.is_dissem === 1 || q.is_dissem === true; }
function isNoticeQ(q) { return /公告/.test(String(q.source || '')); }
// 项目经理/设总 题：is_pm=1（依据《项目经理设总.xls》新能源工程院项目经理/设总名单）
function isPmQ(q) { return q.is_pm === 1 || q.is_pm === true; }

// 组卷模式（由所选范围自动推导，前端无需改动）：
//   ['通用']             → 'general' 全通用卷
//   恰含「通用」+ 1 个专业 → 'mix'     通用与专业各半
//   其它（多专业复选）     → 'auto'    沿用「按范围题量比例」原逻辑
function resolveExamMode(valid) {
  if (valid.length === 1 && valid[0] === '通用') return 'general';
  if (valid.length === 2 && valid.indexOf('通用') >= 0) return 'mix';
  return 'auto';
}

// 整卷配额组卷（general / mix）：宣贯/公告/项目经理·设总 占比均按整卷口径（通用+专业合并算）。
//   general：全部从「通用」抽 n 题；宣贯 ≥10%（通用桶宣贯池小，故放宽）。
//   mix：通用出 floor(n/2) 题、所选专业出 n-floor(n/2) 题（各半）；宣贯 ≥25%，公告 ≥1 且 ≤10%。
//   项目经理/设总题（is_pm=1，通用桶）：general 与 mix 均保底 ≥1 道，且补题阶段不再额外塞入（保证整卷恰好 1 道）。
//   范围内宣贯/公告/PM 不足下限时拒绝组卷并提示。
function drawQuota(valid, n, mode) {
  const isGeneral = mode === 'general';
  const D = Math.ceil(n * (isGeneral ? 0.10 : 0.25));  // 宣贯下限：全通用 10%；mix 25%
  const Mmax = isGeneral ? Math.floor(n * 0.10) : Math.max(Math.floor(n * 0.10), 1); // 公告上限 10%
  const Mmin = isGeneral ? 0 : 1;                       // 公告下限：mix 至少 1 道

  const quota = {};
  if (mode === 'general') {
    quota['通用'] = n;
  } else {
    const half = Math.floor(n / 2);
    quota['通用'] = half;
    quota[valid.find(d => d !== '通用')] = n - half;
  }
  const discs = Object.keys(quota);

  const poolByDisc = {};
  for (const d of discs) {
    poolByDisc[d] = db.prepare('SELECT * FROM exam_questions WHERE discipline=?').all(d);
    if (poolByDisc[d].length < quota[d]) {
      throw { status: 400, message: `「${d}」题库仅 ${poolByDisc[d].length} 题，不足本卷所需 ${quota[d]} 题` };
    }
  }

  const chosen = [];
  const usedIds = new Set();
  const takenByDisc = {};
  for (const d of discs) takenByDisc[d] = [];
  let noticeCount = 0;

  // 0) 项目经理/设总 保底（general & mix 至少 1 道），仅从「通用」桶取
  const Pmin = 1;
  let pmCount = 0;
  if (Pmin > 0) {
    for (const d of shuffle(discs)) {
      if (pmCount >= Pmin) break;
      const pms = shuffle(poolByDisc[d].filter(q => !usedIds.has(q.id) && isPmQ(q)));
      while (pms.length && pmCount < Pmin && takenByDisc[d].length < quota[d]) {
        const q = pms.shift();
        chosen.push(q); usedIds.add(q.id); takenByDisc[d].push(q); pmCount++;
      }
    }
    if (pmCount < Pmin) {
      throw { status: 400, message: `本卷需项目经理/设总题 ≥ ${Pmin} 道，但所选范围「通用」桶此类题不足；请先补充该类题库` };
    }
  }

  // 1) 先满足宣贯下限 D：各桶宣贯池轮询抽取、尽量分散（非公告宣贯优先）
  const dissemPool = {};
  for (const d of discs) {
    const ls = poolByDisc[d].filter(isDissemQ);
    dissemPool[d] = shuffle(ls.filter(q => !isNoticeQ(q))).concat(shuffle(ls.filter(q => isNoticeQ(q))));
  }
  let dissemGot = 0, guard = 0;
  while (dissemGot < D && guard++ < 2000) {
    let progressed = false;
    for (const d of shuffle(discs)) {
      if (dissemGot >= D) break;
      if (takenByDisc[d].length >= quota[d]) continue;
      const q = dissemPool[d].shift();
      if (!q) continue;
      chosen.push(q); usedIds.add(q.id); takenByDisc[d].push(q);
      if (isNoticeQ(q)) noticeCount++;
      dissemGot++; progressed = true;
    }
    if (!progressed) break;
  }
  if (dissemGot < D) {
    throw { status: 400, message: `本卷需宣贯题 ≥ ${D} 道（整卷 ≥${Math.round(D / n * 100)}%），但所选范围宣贯题仅 ${dissemGot} 道；请先补充该范围宣贯题库` };
  }

  // 2) 补足各桶剩余名额
  const needByDisc = {};
  for (const d of discs) needByDisc[d] = quota[d] - takenByDisc[d].length;

  // 2a) 公告下限（mix 至少 1 道）：优先于普通题，从含公告的桶取
  if (Mmin > 0) {
    for (const d of shuffle(discs)) {
      if (noticeCount >= Mmin) break;
      const notices = shuffle(poolByDisc[d].filter(q => !usedIds.has(q.id) && isNoticeQ(q)));
      while (notices.length && noticeCount < Mmin && needByDisc[d] > 0) {
        const q = notices.shift();
        chosen.push(q); usedIds.add(q.id); takenByDisc[d].push(q);
        noticeCount++; needByDisc[d]--;
      }
    }
    if (noticeCount < Mmin) {
      throw { status: 400, message: `本卷需公告题 ≥ ${Mmin} 道（本模式要求至少 1 道公告），但所选范围公告题不足；请调整范围` };
    }
  }

  // 2b) 各桶补齐：先取非公告题，再按公告上限（≤Mmax）补公告题
  for (const d of discs) {
    let need = needByDisc[d];
    const rest = shuffle(poolByDisc[d].filter(q => !usedIds.has(q.id)));
    for (const q of rest) {
      if (need <= 0) break;
      if (usedIds.has(q.id) || isNoticeQ(q) || isPmQ(q)) continue;
      chosen.push(q); usedIds.add(q.id); takenByDisc[d].push(q); need--;
    }
    if (need > 0) {
      for (const q of rest) {
        if (need <= 0) break;
        if (usedIds.has(q.id)) continue;
        if (isPmQ(q)) continue;
        if (isNoticeQ(q)) { if (noticeCount >= Mmax) continue; noticeCount++; }
        chosen.push(q); usedIds.add(q.id); takenByDisc[d].push(q); need--;
      }
    }
    if (takenByDisc[d].length < quota[d]) {
      throw { status: 400, message: `组卷失败：题量不足（「${d}」需 ${quota[d]} 题，实得 ${takenByDisc[d].length} 题）` };
    }
  }

  return shuffle(chosen);
}

// 组装入口：按所选范围自动选择组卷模式
function drawQuestions(scope, n = 10) {
  const valid = (scope || []).filter(d => DISCIPLINES.includes(d));
  if (!valid.length) throw { status: 400, message: '请至少选择一个专业范围' };
  const mode = resolveExamMode(valid);
  if (mode === 'auto') return drawAuto(valid, n);
  return drawQuota(valid, n, mode);
}

// 由 round + attempt 生成批改结果（含每题解析；答案密钥来自 attempt.key_secret）
function buildResult(attempt, round) {
  const snapshot = JSON.parse(round.snapshot);
  const { perms } = JSON.parse(attempt.key_secret);
  const answers = attempt.answers ? JSON.parse(attempt.answers) : [];
  const details = snapshot.map((q, k) => {
    const presentedOptions = perms[k].map(i => q.options[i]);
    const correctPresented = perms[k].indexOf(q.answer_index);
    const your = answers[k];
    return {
      stem: q.stem,
      options: presentedOptions,
      yourAnswer: your == null ? null : your,
      correctAnswer: correctPresented,
      correct: your === correctPresented,
      explanation: q.explanation,
    };
  });
  return { score: attempt.score, correct_count: attempt.correct_count, total: details.length, duration_ms: attempt.duration_ms, details };
}

function roundQidCount(roundId) {
  const r = db.prepare('SELECT question_ids FROM exam_rounds WHERE id=?').get(roundId);
  if (!r) return 0;
  try { return JSON.parse(r.question_ids).length; } catch (e) { return 0; }
}

// ── 题库统计（供前端展示可用题量）────────────
router.get('/questions/count', (req, res) => {
  const rows = db.prepare('SELECT discipline, COUNT(*) c FROM exam_questions GROUP BY discipline').all();
  const byDisc = {};
  for (const d of DISCIPLINES) byDisc[d] = 0;
  for (const r of rows) byDisc[r.discipline] = r.c;
  const total = db.prepare('SELECT COUNT(*) c FROM exam_questions').get().c;
  res.json({ total, byDisc });
});

// ── 发起一场新考试（即时组卷，题数由考试管理员选择，默认 10，仅超级管理员/×××/×××）────────────
router.post('/rounds', (req, res) => {
  const u = req.user;
  if (!isExamAdmin(u)) return res.status(403).json({ error: '仅 超级管理员 / ××× / ××× 可发起考试' });
  const scope = Array.isArray(req.body.scope) ? req.body.scope : [];
  const rawCount = parseInt(req.body.count, 10);
  const count = (Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 50) ? rawCount : 10;
  try {
    const qs = drawQuestions(scope, count);
    const snapshot = qs.map(q => ({
      id: q.id,
      discipline: q.discipline,
      source: q.source,
      stem: q.stem,
      options: JSON.parse(q.options), // 规范顺序，key_secret 决定每人乱序
      answer_index: q.answer_index,
      explanation: q.explanation,
    }));
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // 出题人可自定义测试名称；为空或超长（>60字）时回退默认时间戳标题
    const rawTitle = req.body && typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const title = (rawTitle && rawTitle.length <= 60) ? rawTitle : `检验池考试·${ts}`;
    const info = db.prepare(
      'INSERT INTO exam_rounds (title, scope, question_ids, snapshot, created_by, created_by_name, opened) VALUES (?,?,?,?,?,?,0)'
    ).run(title, JSON.stringify(scope), JSON.stringify(qs.map(q => q.id)), JSON.stringify(snapshot), u.id, u.realName);
    const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(info.lastInsertRowid);
    res.json({
      round: { id: round.id, title: round.title, scope: JSON.parse(round.scope), count: qs.length, created_by_name: round.created_by_name, created_at: round.created_at, settled: round.settled, opened: round.opened || 0 },
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '组卷失败' });
  }
});

// ── 考试列表（含参与人数 / 本人是否已考）────────────
router.get('/rounds', (req, res) => {
  const u = req.user;
  const rounds = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.round_id=r.id AND a.status='done') AS done_count,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.round_id=r.id AND a.user_id=? AND a.status='done') AS my_done
    FROM exam_rounds r ORDER BY r.created_at DESC LIMIT 50
  `).all(u.id);
  res.json(rounds.map(r => ({
    id: r.id, title: r.title, scope: JSON.parse(r.scope),
    count: (() => { try { return JSON.parse(r.question_ids).length; } catch (e) { return 0; } })(),
    created_by_name: r.created_by_name, created_at: r.created_at,
    done_count: r.done_count, my_done: r.my_done,
    settled: r.settled || 0,
    opened: r.opened || 0,
  })));
});

// ── 开放 / 关闭一场考试（大会开关：仅考试管理员；关闭后新考生不可 start，
//    已 in_progress 的考生草稿/提交不受影响，不卡进行中的作答）──────────
router.post('/rounds/:id/toggle', (req, res) => {
  const u = req.user;
  if (!isExamAdmin(u)) return res.status(403).json({ error: '仅 超级管理员 / ××× / ××× 可操作考试开关' });
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(req.params.id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  const next = round.opened ? 0 : 1;
  db.prepare('UPDATE exam_rounds SET opened=? WHERE id=?').run(next, round.id);
  const inProg = db.prepare("SELECT COUNT(*) n FROM exam_attempts WHERE round_id=? AND status='in_progress'").get(round.id).n;
  res.json({ id: round.id, opened: next, in_progress: inProg });
});

// ── 开始 / 进入一场考试：返回本人乱序后的题目（不含答案），已提交则附带结果 ────
router.post('/rounds/:id/start', (req, res) => {
  const u = req.user;
  if (u.isGuest && !u.canExam) return res.status(403).json({ error: '游客无法参加考试，请登录后作答' });
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(req.params.id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  // 2026-10-19 大会开关：未开放的考试任何人不可 start（也不创建 attempt）。
  // 已 in_progress 的考生若被中途关闭，草稿仍在库，重新开放后可从原 attempt 续答。
  if (!round.opened) return res.status(403).json({ error: '本场考试尚未开放，请等待管理员开放' });
  const snapshot = JSON.parse(round.snapshot);
  let attempt = db.prepare('SELECT * FROM exam_attempts WHERE round_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(round.id, u.id);
  let perms;
  if (!attempt) {
    perms = snapshot.map(() => shuffle([0, 1, 2, 3]));
    const info = db.prepare(
      'INSERT INTO exam_attempts (round_id, user_id, user_name, key_secret, status) VALUES (?,?,?,?,?)'
    ).run(round.id, u.id, u.realName, JSON.stringify({ perms }), 'in_progress');
    attempt = db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(info.lastInsertRowid);
  } else {
    perms = JSON.parse(attempt.key_secret).perms;
  }
  const questions = snapshot.map((q, k) => ({
    id: q.id, discipline: q.discipline, stem: q.stem, options: perms[k].map(i => q.options[i]),
  }));
  const done = attempt.status === 'done';
  res.json({
    round_id: round.id, title: round.title, scope: JSON.parse(round.scope),
    questions, attempt_id: attempt.id, done,
    result: done ? buildResult(attempt, round) : null,
    started_at: attempt.created_at,        // 考生端计时基准（UTC）
    savedAnswers: done ? null : (attempt.answers ? JSON.parse(attempt.answers) : null), // 续答回填
  });
});

// ── 保存作答草稿（进行中保存，不批改、不影响计时；供退出后返回续答）────────────
//   计时始终以 attempt.created_at（首次进入考试时间）为准，草稿只写 answers 字段。
// 同一 attempt 的草稿幂等去重：极短时间内重复提交「相同答案」（多 tab / 网络重发）时跳过写库，
// 减少多人并发时的 DB 写压力；只要答案有变化就一定写库，绝不丢数据。
const _lastDraftSig = new Map();
router.post('/rounds/:id/draft', (req, res) => {
  const u = req.user;
  if (u.isGuest && !u.canExam) return res.status(403).json({ error: '游客无法参加考试' });
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(req.params.id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  const attempt = db.prepare('SELECT * FROM exam_attempts WHERE round_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(round.id, u.id);
  if (!attempt) return res.status(400).json({ error: '请先开始考试' });
  if (attempt.status === 'done') return res.status(400).json({ error: '本场考试已提交，草稿不再保存' });
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const total = roundQidCount(round.id);
  if (answers.length !== total) return res.status(400).json({ error: '草稿题数与试卷不符' });
  const norm = answers.map(a => (Number.isInteger(a) && a >= 0 && a <= 3) ? a : null);
  const sig = attempt.id + '|' + JSON.stringify(norm);
  if (_lastDraftSig.get(attempt.id) === sig) {
    return res.json({ ok: true, answered: norm.filter(a => a !== null).length, total, dedup: true });
  }
  _lastDraftSig.set(attempt.id, sig);
  if (_lastDraftSig.size > 5000) _lastDraftSig.clear();
  db.prepare('UPDATE exam_attempts SET answers=? WHERE id=?').run(JSON.stringify(norm), attempt.id);
  res.json({ ok: true, answered: norm.filter(a => a !== null).length, total });
});

// ── 提交答卷（服务端权威批改）────────────
router.post('/rounds/:id/submit', (req, res) => {
  const u = req.user;
  if (u.isGuest && !u.canExam) return res.status(403).json({ error: '游客无法参加考试' });
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(req.params.id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  const attempt = db.prepare('SELECT * FROM exam_attempts WHERE round_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(round.id, u.id);
  if (!attempt) return res.status(400).json({ error: '请先开始考试' });
  if (attempt.status === 'done') return res.status(400).json({ error: '本场考试已提交，不可重复提交' });
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const snapshot = JSON.parse(round.snapshot);
  if (answers.length !== snapshot.length) return res.status(400).json({ error: '答题不完整' });
  const { perms } = JSON.parse(attempt.key_secret);
  let score = 0, correct = 0;
  answers.forEach((a, k) => {
    if (a === perms[k].indexOf(snapshot[k].answer_index)) { score += 10; correct++; }
  });
  // 用时：以服务端「答卷创建时间→提交时间」为准（防客户端篡改），客户端上报仅作兜底
  let dur = Number(req.body.duration_ms) || null;
  try {
    const nowSec = db.prepare("SELECT strftime('%s','now') t").get().t;
    const startSec = db.prepare("SELECT strftime('%s',?) t").get(attempt.created_at).t;
    if (nowSec != null && startSec != null) dur = Math.max(0, (nowSec - startSec) * 1000);
  } catch (e) {}
  db.prepare(
    "UPDATE exam_attempts SET answers=?, score=?, correct_count=?, status='done', duration_ms=?, submitted_at=datetime('now') WHERE id=?"
  ).run(JSON.stringify(answers), score, correct, dur, attempt.id);
  const updated = db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(attempt.id);
  res.json({ result: buildResult(updated, round) });
});

// ── 个人历次成绩（仅已完成；total 用 json_each 避免 N+1）────────────────────────
router.get('/my-scores', (req, res) => {
  const u = req.user;
  const rows = db.prepare(`
    SELECT a.id, a.round_id, a.score, a.correct_count, a.status, a.created_at, a.submitted_at, a.duration_ms,
           r.title, r.scope,
           (SELECT COUNT(*) FROM json_each(r.question_ids)) AS total
    FROM exam_attempts a JOIN exam_rounds r ON a.round_id=r.id
    WHERE a.user_id=? AND a.status='done'
    ORDER BY COALESCE(a.submitted_at, a.created_at) DESC, a.created_at DESC
  `).all(u.id);
  res.json(rows.map(r => ({
    id: r.id, round_id: r.round_id, score: r.score, correct_count: r.correct_count,
    total: r.total,
    status: r.status, created_at: r.created_at, submitted_at: r.submitted_at, duration_ms: r.duration_ms,
    title: r.title, scope: JSON.parse(r.scope),
  })));
});

// ── 排名（仅超级管理员/专总/院长）─────────────
router.get('/rounds/:id/ranking', (req, res) => {
  const u = req.user;
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(req.params.id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  const attempts = db.prepare(`
    SELECT a.* FROM exam_attempts a
    WHERE a.round_id=? AND a.status='done'
    ORDER BY a.score DESC, a.duration_ms ASC, a.submitted_at ASC
  `).all(round.id);
  const ranking = attempts.map((a, i) => ({
    rank: i + 1,
    user_name: a.user_name,
    score: a.score,
    correct_count: a.correct_count,
    total: roundQidCount(round.id),
    duration_ms: a.duration_ms,
    submitted_at: a.submitted_at,
  }));
  res.json({ round: { id: round.id, title: round.title, scope: JSON.parse(round.scope), created_by_name: round.created_by_name, created_at: round.created_at }, ranking, participant_count: ranking.length });
});

// ── 结算锁定：考试管理员锁定本场考试（仅作排名锁定标记，不再自动发放小红花；检验池红花改由管理员经「质量工作奖惩」手动发放）────────────
router.post('/rounds/:id/settle', (req, res) => {
  const u = req.user;
  if (!isExamAdmin(u)) return res.status(403).json({ error: '仅 超级管理员 / ××× / ××× 可结算锁定' });
  const id = Number(req.params.id);
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  if ((round.settled || 0) === 1) return res.status(400).json({ error: '本场考试已结算锁定，不可重复结算' });
  db.prepare('UPDATE exam_rounds SET settled=1 WHERE id=?').run(id);
  res.json({ ok: true, message: '本场考试已结算锁定；检验池小红花请通过「质量工作奖惩」手动发放' });
});

// ── 删除一场考试（含其所有答卷），仅考试管理员：超级管理员/×××/××× ─────────────
router.delete('/rounds/:id', (req, res) => {
  const u = req.user;
  if (!isExamAdmin(u)) return res.status(403).json({ error: '仅 超级管理员 / ××× / ××× 可删除考试' });
  const id = Number(req.params.id);
  const round = db.prepare('SELECT * FROM exam_rounds WHERE id=?').get(id);
  if (!round) return res.status(404).json({ error: '考试不存在' });
  db.prepare('DELETE FROM exam_attempts WHERE round_id=?').run(id);
  db.prepare('DELETE FROM exam_rounds WHERE id=?').run(id);
  res.json({ message: '已删除考试及其答卷', id });
});

module.exports = router;
module.exports.drawQuestions = drawQuestions; // 供运维/测试复用（不改路由行为）
