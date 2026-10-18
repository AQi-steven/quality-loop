/**
 * 月冠军结算脚本（由服务器 root crontab 每月 1 号调用，无需 HTTP 鉴权）。
 * 结算上一自然月的小红花月冠军，写入 month_champions 表（幂等）。
 * 用法：node /opt/qc-app/server/src/settleMonth.js
 */
const db = require('./db/connection');
const { settlePreviousMonth, settleBimonthChampion } = require('./flowers');

try {
  const r = settlePreviousMonth(db);
  const b = settleBimonthChampion(db);
  const ts = new Date().toISOString();
  if (r.skipped) {
    console.log(`[${ts}] 月冠军结算跳过：${r.month} 已结算`);
  } else if (r.empty) {
    console.log(`[${ts}] 月冠军结算：${r.month} 无人产生小红花（空结算占位）`);
  } else {
    console.log(`[${ts}] 月冠军结算完成：${r.month} 冠军 = ${JSON.stringify(r.winners)}`);
  }
  // 双月冠军仅在「结算 10 月」时触发（11 月 1 日）；其余月份 skipped(reason=not-october) 属正常
  if (b.settled) {
    console.log(`[${ts}] 双月冠军结算完成：${b.month} 冠军 = ${JSON.stringify(b.winners)}`);
  } else if (b.skipped && b.reason !== 'not-october') {
    console.log(`[${ts}] 双月冠军结算跳过：${b.month} 已结算`);
  }
  process.exit(0);
} catch (e) {
  console.error('[月冠军结算失败]', e.message);
  process.exit(1);
}
