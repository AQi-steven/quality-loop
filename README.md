# 设计院质量管理平台 · Quality Management Platform

[English](#english) · [简体中文](#简体中文)

---

## English

A **quality management platform** for engineering design and R&D teams: announcements,
knowledge sessions, PDCA issue loops, quality topics, read-acknowledgement tracking,
incentive points ("little red flowers"), knowledge-base Q&A and exams — all in one
mobile-first web app.

> Prototyped from real quality-management practice at an engineering design institute
> (~100 staff). Single deployable app, zero build step, runs comfortably on a 1 GB server.

## Features

| Module | Description |
|---|---|
| Announcements | Formal notices with exposure-period management, pinning, all-hands read tracking |
| Knowledge Sessions | Standards/methods explainers; publishing earns flower points; review flow |
| PDCA | On-site quality issue loops: Found → Solving → Everyone Presents (case sharing) → Institute Selection |
| Quality Topics | Organise text/image updates by theme, phase, process and outcome; link announcements / sessions / PDCA |
| Knowledge Base | Unified full-text search across all content (SQLite FTS5, Chinese-capable) |
| KB Q&A | AI answers grounded in library sources with clickable citations; automatic model failover + graceful degradation |
| Flower Points | Quality-behaviour incentives with monthly leaderboard and traceable awards |
| Read Tracking | Dynamic required-reader pool (authors exempt), unread reminders |
| Exam Pool | Question-bank exams with score ranking |
| WeChat Alerts | ServerChan push (review to-dos, institute selections, PDCA to-dos, system alerts) |
| IMA Sync | Auto-sync announcements / sessions / case talks to an IMA knowledge base (optional) |

## Tech Stack

- **Frontend**: zero-build vanilla JS SPA (hash router) + PWA (installable to phone home screen)
- **Backend**: Node.js + Express + SQLite (FTS5 full-text search)
- **Auth**: JWT + RBAC (roles: dean / chief / section_leader / designer, plus a read-only guest account system)
- **AI**: any OpenAI-compatible gateway (automatic model-chain failover + graceful degradation)
- **Deploy**: pm2 + hand-written Node reverse proxy (80/443) + Let's Encrypt

## Quick Start

```bash
# 1. Install backend dependencies
cd server && npm install

# 2. Initialise the database (tables + seeds)
npm run db:init

# 3. Configure
cp ../.env.example .env   # edit JWT_SECRET etc.

# 4. Start
npm start                 # port 3000 by default

# 5. Frontend: serve web/ with any static server (same origin as the API, or configure a reverse proxy)
#    For development: cd web && npx serve .
```

First boot creates a default administrator (username `admin`, forced password change on
first login). **The super-admin check uses the example username `superadmin` — do a global
search and change it to your own super-admin username.**

## Demo Mode

`web/js/demo.js` provides pure front-end demo data (all names fictional); no backend needed.
Remove the corresponding `<script>` tag from `index.html` in production.

## Directory Layout

```
├── web/                        # front end (zero build, static hosting)
│   ├── index.html              # entry (with ?v= cache-busting stamps)
│   ├── js/
│   │   ├── app.js              # bootstrap / router / permission derivation
│   │   ├── pages*.js           # per-tab rendering logic
│   │   ├── ui.js / api.js      # component library / API wrapper
│   │   └── demo.js             # demo data (fictional)
│   ├── css/style.css
│   └── vendor/                 # third-party libs (Univer/ExcelJS/JSZip, see NOTICE)
└── server/                     # back end
    └── src/
        ├── app.js              # Express entry
        ├── routes/             # business routes
        ├── db/schema.js        # tables + idempotent migrations + seeds
        ├── qa_index.js         # FTS5 index builder (CLI)
        ├── ima*.js             # IMA sync + health check + key reminder (optional)
        └── wechat/             # ServerChan WeChat push
```

## Configuration

| Env var | Required | Description |
|---|---|---|
| JWT_SECRET | Yes | Signing secret |
| PORT | No | Default 3000 |
| LLM_API_KEY / LLM_BASE_URL / LLM_MODEL | No | KB Q&A AI; any OpenAI-compatible gateway |
| LLM_FALLBACK_MODELS | No | Fallback model chain (comma-separated) |
| IMA_CLIENT_ID / IMA_API_KEY | No | IMA knowledge-base sync |
| IMA_ALERT_SCKEY | No | WeChat alert on IMA auth failure |

## Operations Notes

- **Backup**: SQLite WAL + `VACUUM INTO` incremental every 15 min + full weekly snapshot (strategy in docs/ARCHITECTURE.md)
- **Version stamps**: front-end changes must update every `?v=` stamp in `index.html` (browser cache strategy)
- **Index rebuild**: `node src/qa_index.js` (run after content changes; wait a few seconds after a pm2 restart to avoid "database is locked")

## Security Notes

- No real keys or credentials in the code (.env is git-ignored, see .gitignore)
- Default password policy: forced change on first login
- The read-only guest account system is enforced by backend middleware — non-GET requests always return 403

## License

MIT License © 2026 Steven Lee (released in a personal capacity, unaffiliated with any
organisation). See [LICENSE](LICENSE).

## Acknowledgements

Univer / ExcelJS / JSZip / SheetJS (see NOTICE).

---

## 简体中文

一个面向工程设计与研发团队的**质量管理平台**：把质量公告、知识宣贯、问题闭环（PDCA）、
质量专题、已阅追踪、激励积分（小红花）、知识库问答、考试检验整合到一个手机优先的 Web 应用里。

> 原型来自工程设计研究院的质量管理实践（约 100 人规模）。单体应用、零构建、1GB 内存服务器可跑。

## 功能总览

| 模块 | 说明 |
|---|---|
| 质量公告 | 正式通知发布，公示期管理，置顶，全员已阅追踪 |
| 质量宣贯 | 知识/标准/方法讲解，发布即得小红花，审核流 |
| PDCA | 现场质量问题闭环：发现 → 解决 → 人人讲（案例分享）→ 院选 |
| 质量专题 | 按主题/阶段/过程/成果组织图文动态，关联公告/宣贯/PDCA |
| 质量库 | 全站内容统一检索（SQLite FTS5 全文索引，支持中文） |
| 库问答 | AI 基于质量库原文回答，附可点击来源；模型故障自动降级 |
| 小红花 | 质量行为积分，月度榜单，可追溯发放 |
| 已阅追踪 | 应阅池动态计算（作者豁免），未阅提醒 |
| 检验池/考试 | 题库考试、成绩排名 |
| 微信提醒 | Server酱 推送（审核待办、院选、PDCA 待办、系统告警） |
| IMA 同步 | 公告/宣贯/人人讲自动同步到 IMA 知识库（可选） |

## 技术栈

- **前端**：无构建 vanilla JS 单页应用（hash 路由）+ PWA（可加手机桌面）
- **后端**：Node.js + Express + SQLite（FTS5 全文检索）
- **鉴权**：JWT + RBAC（角色：dean/chief/section_leader/designer + 游客只读账号体系）
- **AI**：任意 OpenAI 兼容网关（模型链自动故障切换 + 优雅降级）
- **部署**：pm2 + 自写 Node 反代（80/443）+ Let's Encrypt

## 快速开始

```bash
# 1. 安装后端依赖
cd server && npm install

# 2. 初始化数据库（自动建表 + 种子）
npm run db:init

# 3. 配置
cp ../.env.example .env   # 按需修改 JWT_SECRET 等

# 4. 启动
npm start                 # 默认 3000 端口

# 5. 前端：用任意静态服务器托管 web/（需与 API 同域，或配反代）
#    开发时可直接：cd web && npx serve .
```

首次启动会创建默认管理员（用户名 `admin`，首次登录强制改密）。
**所有超管判断的用户名为示例值 `superadmin`，请全局搜索后改为你的超管用户名。**

## 演示模式

`web/js/demo.js` 提供纯前端演示数据（全虚构人名），不接后端即可体验界面。
生产部署时删除 `index.html` 中对应的 `<script>` 引用即可。

## 目录结构

```
├── web/                        # 前端（无构建，直接静态托管）
│   ├── index.html              # 入口（含版本戳 ?v=）
│   ├── js/
│   │   ├── app.js              # 引导/路由/权限派生
│   │   ├── pages*.js           # 各 tab 渲染逻辑
│   │   ├── ui.js / api.js      # 组件库 / API 封装
│   │   └── demo.js             # 演示数据（虚构）
│   ├── css/style.css
│   └── vendor/                 # 第三方库（Univer/ExcelJS/JSZip，见 NOTICE）
└── server/                     # 后端
    └── src/
        ├── app.js              # Express 入口
        ├── routes/             # 各业务路由
        ├── db/schema.js        # 建表 + 幂等迁移 + 种子
        ├── qa_index.js         # FTS5 索引构建（CLI）
        ├── ima*.js             # IMA 同步 + 自检 + 提醒（可选）
        └── wechat/             # Server酱 微信推送
```

## 配置说明

| 环境变量 | 必填 | 说明 |
|---|---|---|
| JWT_SECRET | 是 | 签名密钥 |
| PORT | 否 | 默认 3000 |
| LLM_API_KEY / LLM_BASE_URL / LLM_MODEL | 否 | 库问答 AI，任意 OpenAI 兼容网关 |
| LLM_FALLBACK_MODELS | 否 | 备用模型链（逗号分隔） |
| IMA_CLIENT_ID / IMA_API_KEY | 否 | IMA 知识库同步 |
| IMA_ALERT_SCKEY | 否 | IMA 失效微信告警 |

## 运维要点

- **备份**：SQLite WAL + 每 15 分钟 `VACUUM INTO` 增量 + 周日全量（策略详见 docs/ARCHITECTURE.md 运维体系）
- **版本戳**：前端改动必须同步 `index.html` 中所有 `?v=` 戳（浏览器缓存策略）
- **索引重建**：`node src/qa_index.js`（内容变更后跑；pm2 重启后等几秒再跑，避免 database is locked）

## 安全说明

- 代码中不含任何真实密钥/凭证（.env 不入库，见 .gitignore）
- 默认密码策略：首次登录强制改密
- 游客账号体系（只读）通过后端中间件兜底，非 GET 一律 403

## 许可证

MIT License © 2026 Steven Lee（个人名义开源，与任何单位无关）。详见 [LICENSE](LICENSE)。

## 致谢

Univer / ExcelJS / JSZip / SheetJS（见 NOTICE）。
