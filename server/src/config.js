/**
 * 配置文件
 *
 * 登录方案：管理员分配账号+密码，零外部依赖
 * 腾讯文档API配置需要在 docs.qq.com/developer/ 注册应用后获取
 */

module.exports = {
  // 服务端口
  port: process.env.PORT || 3000,

  // JWT密钥（生产环境应使用强随机字符串）
  jwtSecret: process.env.JWT_SECRET || 'quality-app-jwt-secret-change-in-production',
  jwtExpiresIn: '7d', // 7天有效期

  // 密码配置
  password: {
    minLength: 6, // 最小长度
    defaultPassword: 'ChangeMe123!', // 初始默认密码
    bcryptRounds: 10, // bcrypt加密轮数
  },

  // 腾讯文档API配置（待填写）
  tencentDocs: {
    appId: process.env.TXDOC_APPID || '', // 腾讯文档开放平台应用ID
    appSecret: process.env.TXDOC_APPSECRET || '', // 腾讯文档开放平台应用密钥
  },

  // 已有腾讯文档file_id映射
  docIds: {
    q1MonthlyReport: 'VJMXsFWZqfwH', // 月度质量报告(Q1)
    q2aIssueList: 'EfDQVdpAcxSS', // 质量问题清单(Q2a)
    q4aSpecialList: 'JmoFsbOthvCJ', // 质量分析会专项清单(Q4a)
    q4bAnnualPlan: 'KMSdmZKlLnto', // 年度质量提升计划(Q4b)
  },

  // 数据库路径
  db: {
    path: './data/quality.db',
    backupsDir: './backups',
  },

  // 文件上传
  upload: {
    dir: './uploads',
    maxSize: 50 * 1024 * 1024, // 50MB（与 upload.js limits.fileSize 统一）
    maxFiles: 9, // 最多9张照片
  },

  // 数据同步
  sync: {
    interval: 30 * 60 * 1000, // 30分钟
    retryInterval: 5 * 60 * 1000, // 失败重试间隔5分钟
  },

  // 问题类型（对应Q2a的8类分类）
  issueTypes: [
    '设计深度及完整度',
    '提资会签',
    '图纸表达及成品显示',
    '图纸分级',
    '卷册图纸命名',
    '校审要点',
    '图框及信息是否准确',
    '其他',
  ],

  // 工单状态
  ticketStatus: {
    SUBMITTED: 'submitted', // 已提交
    ASSIGNED: 'assigned', // 已分配
    REJECTED: 'rejected', // 已驳回
    PROCESSING: 'processing', // 处理中
    PENDING_CLOSE: 'pending_close', // 待闭环
    CLOSED: 'closed', // 已闭环
  },

  // 用户角色
  userRoles: {
    LEADER: 'leader', // 领导
    ADMIN: 'admin', // 管理员（专总/室主任）
    DESIGNER: 'designer', // 设计师
  },

  // 点子分类
  ideaCategories: [
    '工艺改进',
    '流程优化',
    '工具建议',
    '经验分享',
    '其他',
  ],
};
