// 一次性/可重跑脚本：重建「项目经理/设总」保底题（is_pm=1，通用桶）。
// 用途：IMA「SHARE-知识库」> 项目经理设总.xls 名册更新后，重新生成全真实姓名版题库。
// 设计：每题正确答案取自新能源工程院真实名册；3 个干扰项取自配网工程院真实名册（不同部门）。
//       全部为真实姓名，无假名（遵守「绝不臆造」铁律）。25 题对应 25 位新能源工程院 PM/设总。
// 运行：cd /opt/qc-app/server && node src/db/generate_pm_questions.js
const db = require('./connection');

// 新能源工程院真实名册（25 人）：前 5 为项目经理，其余为设总
const XNY = ['蒋浩','孙雷','曲海波','周威崴','王思平','陈丹丹','仲雅娟','王朝阳','徐以强','丁伟东','詹小凯','蔡悠然','戴维斯','章刘洋','刘慧芬','陈磊','雷勇','高杨杨','李盛楠','沈彬','鞠凤君','赵心迪','胡清清','苑东瑞','张浩'];
// 配网工程院真实名册（47 人）：前 11 为项目经理，其余为设总
const PW = ['祝陈晨','朱清清','王小丽','庄烨','朱尧','周雅丽','郑明正','张艳','于金丰','殷潇波','姚俊伟','杨艳','杨雷雷','严华','薛鹏','谢容','谢丹丹','王佳来','田岑','沈立','欧阳黔麟','牛婧','毛姝旻','陆俊豪','陆陈健','李辉','李超群','鞠萍','金昳丽','侯俊梁','顾蕙华','陈羽俊','曹与哲','包家闻','许经纬','徐剑伟','孙燕','盛文玥','孟昀','蓝睿','季蕾','×××','吴勇','金勇','董晓成'];

// 确定性 PRNG（mulberry32），保证每次生成稳定、可复核
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
const rnd = mulberry32(20260917);
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

const rows = [];
for (const ans of XNY) {
  const pool = shuffle(PW).slice(0, 3);
  const opts = shuffle([ans, ...pool]);
  const ai = opts.indexOf(ans);
  rows.push({
    discipline: '通用',
    source: '项目经理设总.xls',
    stem: '依据《项目经理设总.xls》最新名单，以下四位均为我院不同工程院的项目经理/设总，哪一位属于新能源工程院？',
    options: JSON.stringify(opts),
    answer_index: ai,
    explanation: '正确答案为「' + ans + '」，属新能源工程院项目经理/设总；其余三位均属配网工程院。',
    is_pm: 1,
  });
}

const del = db.prepare('DELETE FROM exam_questions WHERE is_pm=1').run();
console.log('deleted is_pm rows:', del.changes);

const ins = db.prepare('INSERT INTO exam_questions(discipline,source,stem,options,answer_index,explanation,is_pm) VALUES(@discipline,@source,@stem,@options,@answer_index,@explanation,@is_pm)');
const tx = db.transaction(() => { for (const r of rows) ins.run(r); });
tx();
console.log('inserted is_pm rows:', rows.length);

const all = db.prepare('SELECT id,options,answer_index FROM exam_questions WHERE is_pm=1').all();
const xnySet = new Set(XNY);
let bad = 0;
for (const r of all) {
  const opts = JSON.parse(r.options);
  if (opts.length !== 4 || new Set(opts).size !== 4 || !xnySet.has(opts[r.answer_index])) bad++;
}
const total = db.prepare('SELECT COUNT(*) c FROM exam_questions WHERE is_pm=1').get().c;
console.log('verify: is_pm total =', total, '| anomalies =', bad);
