/**
 * 检验池题库种子 · 第三批（2026-09-16 增补 · 重点资料深挖）
 *
 * 出题来源（全部来自 IMA 重点资料库「SHARE-知识库 / 09重点资料」原文，已逐篇 fetch 全文）：
 *   - 《设总清单》（folder_7489278514849942 下 word 原文）：设总表单、外来资料验证、归档时限、常见问题
 *   - 《协办卷册主设人自查要点清单（2026版）》：图纸命名、协办卷册负责人=主设人、环保专业分工
 *   - 《建筑结构防水、钢结构墙面埋件做法及接口会议纪要20230112》：防水界面划分、地下站防水等级、内隔墙埋件
 *   - 《通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要20220905》：事故油池提资、管线基坑围护、拆除卷册
 *   - 《213.40-2026 CAD制图标准指导性办法》：专业代字、各专业技术图层
 *   - 《【2026】本院质量提升总体思路及实施方案》：双线五维
 *   - 《项目经理设总.xls》：新能源工程院项目经理/设总名单
 *
 * 本批全部为「重点资料」类（is_dissem=0），按用户要求《项目经理设总》文件出一些、其他文件平均出一些，
 * 六个专业（建筑/给排水/暖通/通信/电气/通用）均覆盖。
 *
 * 出题铁律：discipline 仅取 6 标准桶，绝不写 水工 等会被 drawQuestions 过滤成孤儿的值。
 * 幂等：按 (discipline, stem) 去重，已存在则跳过；可重复执行。
 */
const db = require('./connection');

const QUESTIONS = [
  // ─────────────── 建筑 · 防水界面与等级（建筑结构防水分工纪要20230112） ───────────────
  {
    discipline: '建筑', source: '建筑结构防水、钢结构墙面埋件做法及接口会议纪要(2023-01-12)',
    stem: '根据《建筑结构防水、钢结构墙面埋件做法及接口会议纪要》（2023-01-12），地下站房工程的防水界面分工，下列哪项正确？',
    options: [
      '室外地坪以上外墙和屋顶防水、以及室外地坪以下地下室底板/外墙/顶板的外防水由建筑专业负责；结构自防水及施工缝/变形缝/后浇带/诱导缝中的防水措施（如中埋式、外贴式止水带）由结构专业负责',
      '全部防水（含结构自防水、止水带）均由建筑专业负责',
      '全部防水均由结构专业负责',
      '地下室外防水由结构负责，地上防水由建筑负责',
    ],
    answer_index: 0,
    explanation: '纪要：室外地坪以上外墙和屋顶防水、室外地坪以下地下室底板/外墙/顶板外防水属建筑专业；结构自防水及施工缝/变形缝/后浇带/诱导缝中的防水措施（中埋式/外贴式止水带）属结构专业。',
    is_dissem: 0,
  },
  {
    discipline: '建筑', source: '建筑结构防水、钢结构墙面埋件做法及接口会议纪要(2023-01-12)',
    stem: '同上纪要，地下变电站工程的防水等级要求是？',
    options: [
      '客户项目地下站防水等级均为一级；非客户项目220kV按一级、110kV按二级',
      '所有地下站防水等级均为一级',
      '所有地下站防水等级均为二级',
      '由设计人自行确定，无统一规定',
    ],
    answer_index: 0,
    explanation: '纪要：地下站防水等级——客户均一级，非客户220kV按一级、110kV按二级。',
    is_dissem: 0,
  },
  {
    discipline: '建筑', source: '建筑结构防水、钢结构墙面埋件做法及接口会议纪要(2023-01-12)',
    stem: '同上纪要，建筑内隔墙（轻钢龙骨石膏板）墙面上的埋件及开孔由哪个专业出图？',
    options: [
      '由建筑专业出图',
      '由结构专业出图',
      '由电气专业出图',
      '由厂家直接出图，设计不表达',
    ],
    answer_index: 0,
    explanation: '纪要：建筑内隔墙（轻钢龙骨石膏板）墙面埋件/开孔属建筑出图范围。',
    is_dissem: 0,
  },
  {
    discipline: '建筑', source: '通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要(2022-09-05)',
    stem: '根据《通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要》（2022-09-05），拆除卷册的专业分工是？',
    options: [
      '户外设备及基础/构筑物拆除由结构专业负责，建筑物拆除由建筑专业负责',
      '全部拆除卷册由建筑专业负责',
      '全部拆除卷册由结构专业负责',
      '拆除卷册由水工专业负责',
    ],
    answer_index: 0,
    explanation: '纪要：拆除卷册——户外设备及基础/构筑物由结构负责，建筑物由建筑负责。',
    is_dissem: 0,
  },
  {
    discipline: '建筑', source: '213.40-2026 CAD制图标准指导性办法(建筑图层)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》，下列建筑专业图层命名与含义对应正确的是？',
    options: [
      'WALL=墙线、WINDOWS=窗及百叶、PUB_TEXT=房间名称/面积/防火分区面积、A_SG_LK=给排水留孔',
      'WALL=窗及百叶、WINDOWS=墙线',
      'PUB_TEXT=轴线、DOTE=房间名称',
      'A_DQ_LK=暖通留孔、A_NT_LK=电气留孔',
    ],
    answer_index: 0,
    explanation: 'CAD标准：建筑图层 WALL(墙线)、WINDOWS(窗及百叶)、COLUMN(柱)、STAIR(楼梯)、PUB_TEXT(房间名称/面积/防火分区面积)、A_DQ_LK(电气留孔)、A_NT_LK(暖通留孔)、A_SG_LK(给排水留孔)、DOTE(轴线)。',
    is_dissem: 0,
  },

  // ─────────────── 给排水 · 事故油池/稳压泵/管线围护（接口纪要+设总清单） ───────────────
  {
    discipline: '给排水', source: '通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要(2022-09-05)',
    stem: '根据《通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要》（2022-09-05），事故油池在总图/结构/建筑配合时的提资要点是？',
    options: [
      '结构或建筑画总图时按水工提资的有效容积选尺寸；水工关注有效容积对应 L/B/H1，建筑关注 L/B',
      '事故油池尺寸完全由建筑专业独立决定',
      '事故油池仅水工专业出图，其他专业不提资',
      '事故油池尺寸按建筑平面随意划定，不需水工提资',
    ],
    answer_index: 0,
    explanation: '纪要：事故油池——结构/建筑画总图时按水工提资的有效容积选尺寸，水工关注 L/B/H1，建筑关注 L/B。',
    is_dissem: 0,
  },
  {
    discipline: '给排水', source: '设总清单(常见问题)',
    stem: '根据《设总清单》"常见问题"记录，消防稳压泵扬程的统一提资要求是？',
    options: [
      '消防稳压泵扬程应统一在常规计算值基础上 +10m 提资',
      '消防稳压泵扬程无需统一，按各项目自行计算',
      '消防稳压泵扬程统一 -10m',
      '消防稳压泵扬程一律取固定 30m',
    ],
    answer_index: 0,
    explanation: '设总清单常见问题：消防稳压泵扬程统一 +10m 提资（避免各项目不一致）。',
    is_dissem: 0,
  },
  {
    discipline: '给排水', source: '通用设计宣贯及建筑、给排水、结构接口讨论会会议纪要(2022-09-05)',
    stem: '同上接口纪要，管线基坑围护的提资触发条件是？',
    options: [
      '新建站开挖深度 >3m、改造站开挖深度 >2m 时，由水工专业向结构/技经提资基坑围护',
      '任何开挖均需水工提资基坑围护',
      '仅开挖 >5m 才需提资',
      '基坑围护一律由建筑专业负责，与水工无关',
    ],
    answer_index: 0,
    explanation: '纪要：管线基坑围护——新建站开挖 >3m、改造站 >2m 时，水工向结构/技经提资。',
    is_dissem: 0,
  },

  // ─────────────── 暖通 · 气流组织/图层/环保分工 ───────────────
  {
    discipline: '暖通', source: '设总清单(常见问题)',
    stem: '根据《设总清单》"常见问题"记录，暖通专业在图纸表达上容易被审查退回的问题是？',
    options: [
      '气流组织表达不清（如未交代清楚送排风、气流走向），需在图纸中准确表达气流组织',
      '风管尺寸标注过大',
      '未标注风机型号',
      '未画系统图',
    ],
    answer_index: 0,
    explanation: '设总清单常见问题：暖通气流组织（图纸中需把气流组织表达清楚，避免审查退回）。',
    is_dissem: 0,
  },
  {
    discipline: '暖通', source: '213.40-2026 CAD制图标准指导性办法(暖通图层)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》，暖通专业图层以 NT- 开头，下列颜色/含义对应正确的是？',
    options: [
      'NT-通风=6、NT-空调=4、NT-防排烟=1、NT-提资=5',
      'NT-通风=1、NT-防排烟=6、NT-空调=4',
      'NT-通风=30、NT-室内消防=1',
      'NT-图层以 SG- 开头',
    ],
    answer_index: 0,
    explanation: 'CAD标准：暖通 NT-通风(6)、NT-空调(4)、NT-防排烟(1)、NT-提资(5)。',
    is_dissem: 0,
  },
  {
    discipline: '暖通', source: '协办卷册主设人自查要点清单(2026版)(环保分工)',
    stem: '根据《协办卷册主设人自查要点清单（2026版）》环保专业分工，暖通专业在环评/环保篇章中负责的内容是？',
    options: [
      '噪声排放标准、声环境质量',
      '工程概况、大气、固废、环保管理（属设总）',
      '污水排放标准、环境风险（属给排水）',
      '电磁环境（属电气一次）',
    ],
    answer_index: 0,
    explanation: '自查要点环保分工：设总=工程概况/大气/固废/环保管理；土建总图=生态敏感区；电气一次=电磁；暖通=噪声排放标准/声环境质量；给排水=污水排放标准/环境风险；结构=振动。',
    is_dissem: 0,
  },

  // ─────────────── 通信 · 代字与图层 ───────────────
  {
    discipline: '通信', source: '213.40-2026 CAD制图标准指导性办法(专业代字)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》专业代字，系统通信专业的代字是？',
    options: [
      'U（系统通信）',
      'X（系统）',
      'R（继保）',
      'Y（运动）',
    ],
    answer_index: 0,
    explanation: 'CAD标准专业代字：A综合、X系统、R继保、U系统通信、Y运动、ZD自动化、J电气、T结构、Z建筑、N暖通、S水工、P环保、E技经。',
    is_dissem: 0,
  },
  {
    discipline: '通信', source: '213.40-2026 CAD制图标准指导性办法(通信图层)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》，系统通信专业图层以 XTS- 开头，下列对应正确的是？',
    options: [
      'XTS-XS-MG=通信埋管(白色)、XTS-XS-BD=通信布点(青色)',
      'XTS-XS-MG=通信布点、XTS-XS-BD=通信埋管',
      'XTS-图层以 BD- 开头',
      'XTS-XS-MG=桥架',
    ],
    answer_index: 0,
    explanation: 'CAD标准：通信/系统 XTS-XS-MG(埋管白色)、XTS-XS-BD(布点青色)。',
    is_dissem: 0,
  },

  // ─────────────── 电气 · 代字与图层 ───────────────
  {
    discipline: '电气', source: '213.40-2026 CAD制图标准指导性办法(专业代字)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》专业代字，电气专业的代字及下属分支是？',
    options: [
      'J=电气，含 BD(变电电气)、SD(送电电气)、FD(发电电气)',
      'A=电气',
      'T=电气',
      'Z=电气',
    ],
    answer_index: 0,
    explanation: 'CAD标准：J=电气，下分 BD变电电气、SD送电电气、FD发电电气。',
    is_dissem: 0,
  },
  {
    discipline: '电气', source: '213.40-2026 CAD制图标准指导性办法(电气图层)',
    stem: '按《213.40-2026 CAD制图标准指导性办法》，变电电气专业图层以 BD- 开头，下列对应正确的是？',
    options: [
      'BD-SB=设备、BD-DT=导体(青色)、BD-QJ=桥架、BD-JX=主接线',
      'BD-SB=桥架、BD-QJ=设备',
      'BD-图层以 SG- 开头',
      'BD-DT=主接线、BD-JX=导体',
    ],
    answer_index: 0,
    explanation: 'CAD标准：电气 BD-SB(设备)、BD-DT(导体青色)、BD-QJ(桥架)、BD-JX(主接线)。',
    is_dissem: 0,
  },

  // ─────────────── 通用 · 设总表单/外来资料/归档/双线五维/名单/命名/协办卷册 ───────────────
  {
    discipline: '通用', source: '设总清单(表单)',
    stem: '根据《设总清单》，设总在项目管理中常用的表单及对应企标编号是？',
    options: [
      '勘测设计产品要求评审表 Q/ENT-211.18；子项目设计计划表/会议记录表/设计评审记录表 Q/ENT-215.03；外来资料清单/验证记录 Q/ENT-215.04',
      '仅 Q/ENT-212.07 一种表单',
      '勘测设计产品要求评审表 Q/ENT-215.03',
      '外来资料清单 Q/ENT-211.18',
    ],
    answer_index: 0,
    explanation: '设总清单：表单含勘测设计产品要求评审表(Q/ENT-211.18)、子项目设计计划表/会议记录表/设计评审记录表(Q/ENT-215.03)、外来资料清单/验证记录(Q/ENT-215.04)。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '设总清单(外来资料验证)',
    stem: '根据《设总清单》，对外来资料（如业主提供的文号文件）的验证要求是？',
    options: [
      '有盖章或文号（红头文）的外来资料免验证、直接归档；无盖章/文号的需验证，验证人一般为项目经理(设总)或主设人',
      '所有外来资料均需重新验证后方可归档',
      '外来资料一律免验证',
      '验证人只能是院总工',
    ],
    answer_index: 0,
    explanation: '设总清单：有盖章/文号(红头文)免验证直接归档；否则需验证，验证人一般为项目经理(设总)或主设人。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '设总清单(归档时限)',
    stem: '根据《设总清单》引用的归档规定 Q/ENT-212.07-2018，勘测设计技术文件的归档时限是？',
    options: [
      '成品出版后随时归档；勘测设计技术文件在阶段完成后二个月内归档',
      '成品出版后一年内归档即可',
      '项目竣工后统一归档',
      '无明确时限',
    ],
    answer_index: 0,
    explanation: '设总清单：归档按 Q/ENT-212.07-2018——成品出版后随时归档，勘测设计技术文件阶段完成后二个月内归档。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '【2026】本院质量提升总体思路及实施方案',
    stem: '根据2026年本院质量提升"双线五维，绩效闭环"总体思路，"设计人—主设人—设总"属于哪条管理体系线？',
    options: [
      '"设计人—主设人—设总" 立体化质量管理体系线（与"组长—专总—院长"并列构成双线）',
      '"组长—专总—院长" 线',
      '市场营销线',
      '财务管控线',
    ],
    answer_index: 0,
    explanation: '实施方案：构建"组长—专总—院长"、"设计人—主设人—设总"的立体化"双线"质量管理体系。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '项目经理设总.xls(新能源工程院)',
    stem: '根据《项目经理设总.xls》，新能源工程院"设总"名单中下列哪位属于设总（而非项目经理）？',
    options: [
      '陈丹丹（设总）',
      '蒋浩（项目经理）',
      '孙雷（项目经理）',
      '周威崴（项目经理）',
    ],
    answer_index: 0,
    explanation: '项目经理设总.xls：新能源工程院项目经理为蒋浩、孙雷、曲海波、周威崴、王思平；设总含陈丹丹、仲雅娟、王朝阳、徐以强等。本题以陈丹丹为设总示例。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '协办卷册主设人自查要点清单(2026版)(图纸命名)',
    stem: '根据《协办卷册主设人自查要点清单（2026版）》，配电网与新能源项目的图纸命名规则前缀分别是？',
    options: [
      '配电网 DW/PW0001BC-Z(N/S)-01；新能源 NYXXXNK-A01-BD/BT/SD/Z-01',
      '配电网 NYXXXNK-…；新能源 DW/PW-…',
      '两者均用 DW/PW 前缀',
      '两者均用 NYXXXNK 前缀',
    ],
    answer_index: 0,
    explanation: '自查要点：配电网图纸命名 DW/PW0001BC-Z(N/S)-01；新能源 NYXXXNK-A01-BD/BT/SD/Z-01。',
    is_dissem: 0,
  },
  {
    discipline: '通用', source: '协办卷册主设人自查要点清单(2026版)(卷册负责人)',
    stem: '根据《协办卷册主设人自查要点清单（2026版）》，协办卷册的卷册负责人及校审单发起要求是？',
    options: [
      '协办卷册的卷册负责人应为主设人，校审单由主设人发起',
      '卷册负责人应为设总，校审单由设总发起',
      '卷册负责人应为校核人',
      '校审单由项目经理发起',
    ],
    answer_index: 0,
    explanation: '自查要点：协办卷册卷册负责人应为主设人，校审单由主设人发起。',
    is_dissem: 0,
  },
];

// ── 幂等插入 ──
function seed() {
  let inserted = 0, skipped = 0, dissemAdded = 0;
  const ins = db.prepare(
    'INSERT INTO exam_questions (discipline, source, stem, options, answer_index, explanation, is_dissem) VALUES (?,?,?,?,?,?,?)'
  );
  const chk = db.prepare('SELECT id FROM exam_questions WHERE discipline=? AND stem=?');
  for (const q of QUESTIONS) {
    if (chk.get(q.discipline, q.stem)) { skipped++; continue; }
    db.prepare('BEGIN').run();
    try {
      ins.run(q.discipline, q.source, q.stem, JSON.stringify(q.options), q.answer_index, q.explanation, q.is_dissem ? 1 : 0);
      db.prepare('COMMIT').run();
      inserted++;
      if (q.is_dissem) dissemAdded++;
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  }
  const total = db.prepare('SELECT COUNT(*) c FROM exam_questions').get().c;
  const dissem = db.prepare('SELECT COUNT(*) c FROM exam_questions WHERE is_dissem=1').get().c;
  const byDisc = {};
  for (const d of ['建筑', '给排水', '暖通', '通信', '电气', '通用']) {
    byDisc[d] = db.prepare('SELECT COUNT(*) c FROM exam_questions WHERE discipline=?').get(d).c;
  }
  console.log(`[seed-exam-batch3] 本次新增 ${inserted} 题（其中宣贯 ${dissemAdded} 题），跳过已存在 ${skipped} 题；题库总数 ${total}，宣贯题累计 ${dissem}。`);
  console.log('[seed-exam-batch3] 按专业分布：', JSON.stringify(byDisc));
}

if (require.main === module) {
  seed();
}

module.exports = { QUESTIONS, seed };
