# 质量千里行 · 后端服务

Node.js + Express + SQLite + JWT。详见根目录 README.md 与 docs/ARCHITECTURE.md。

## 常用命令

```bash
npm install          # 安装依赖
npm run db:init      # 初始化/迁移数据库（幂等）
npm start            # 启动（--experimental-sqlite）
npm test             # 冒烟测试（需先启动服务）
```

## 目录

```
src/
├── app.js            # Express 入口
├── routes/           # 业务路由
├── db/               # schema（建表+迁移+种子）/ init / migrations
├── middleware/       # JWT 鉴权 / 管理员门禁
├── qa_index.js       # FTS5 索引构建 CLI
├── ima*.js           # IMA 同步与自检（可选功能）
├── wechat/           # Server酱 微信推送
└── flowers.js        # 小红花发放
```
