/**
 * 院级配置加载器（实例专属，不进开源仓库）
 *
 * 设计目标：同一套代码供多个院部署。各院只改 institute.config.js（或环境变量），
 *   不碰业务代码与数据库表结构。未来部门合并（计划内）→ schema/字段名三院统一，
 *   仅"值"外置，合并 = 并数据。
 *
 * 本文件做三件事：
 *   1. 优先加载同目录下的 institute.config.js（实例真实配置；开源版不存在，走默认）；
 *   2. 用内置 DEFAULTS 兜底缺失字段，保证「裸 clone 也能跑起来」；
 *   3. 暴露归一化后的配置对象。
 *
 * 注意：DEFAULTS 不是「本院值」，而是「通用占位值」。本院生产靠 institute.config.js
 *   覆盖；开源版由部署者按 institute.config.example.js 自行填写。
 */

let raw = {};
try {
  raw = require('./institute.config');
} catch (e) {
  raw = {};
}

const DEFAULTS = {
  // 平台品牌（前端标题 / manifest / 主题色 / 微信相关文案）
  platform: {
    name: '质量千里行',
    shortName: '质量千里行',
    orgName: '质量信息管理平台',
    domain: '',
    themeColor: '#0f7b6c',
  },
  // 专业 / 科室展示规则（值随院不同；字段名统一，合并无障碍）
  divisions: {
    hidden: ['综管', '综能', '节能'],          // 不出现在任何程序可见列表
    displayHidden: ['咨询'],                    // 不在筛选/下拉出现，但仍计入应阅/PDCA/提醒
    subs: {                                    // 一级专业 → 二级专业
      '暖通': ['空调', '通风', '采暖', '环保'],
      '水工': ['给排水', '化水水工'],
      '通信': ['系统通信', '网络信息'],
      '建筑': ['民用建筑', '变电站建筑'],
    },
    head: ['建筑'],                            // 排序置顶
    tail: ['电气', '建筑电气', '绿建低碳'],    // 排序沉底
  },
  // 不参与小红花评选的专业（与 divisions.displayHidden 同步口径）
  flowerExcludeDivisions: ['咨询'],
  // 质量周期特性（其他院可关闭"质量双月冠军"）
  qualityCycle: {
    bimonthChampion: false,
  },
  // IMA 知识库（各院用自己的 IMA 账号，folder id 各异；空值 = 关闭 IMA 同步）
  ima: {
    kbId: '',
    kbName: 'SHARE-知识库',
    folderId: '',                 // 02 质量人人讲
    folderName: '质量人人讲',
    qualityFolderId: '',          // 01 质量宣贯
    announcementFolderId: '',     // 00 质量公告
    renrenjiangSelectedParent: '',
    renrenjiangSelectedFolderId: '',
    transubParent: '',            // 地区宣贯附件路由父文件夹
    specialRegions: [],
    regionFolderMap: {},
  },
  // 腾讯文档映射（Q1~Q4 报告）；开源版留空，由部署者填
  docs: {
    q1MonthlyReport: '',
    q2aIssueList: '',
    q4aSpecialList: '',
    q4bAnnualPlan: '',
  },
};

// 深合并：以 DEFAULTS 为骨架，用 raw 的同名叶子值覆盖；raw 多出的键也保留。
function fill(def, val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return val === undefined ? clone(def) : val;
  }
  const out = Array.isArray(def) ? [...def] : { ...def };
  for (const k in def) {
    if (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) {
      out[k] = fill(def[k], val[k]);
    } else if (val[k] !== undefined) {
      out[k] = val[k];
    }
  }
  for (const k in val) {
    if (out[k] === undefined) out[k] = val[k];
  }
  return out;
}
function clone(v) {
  return Array.isArray(v) ? [...v] : (v && typeof v === 'object' ? { ...v } : v);
}

module.exports = fill(DEFAULTS, raw);
