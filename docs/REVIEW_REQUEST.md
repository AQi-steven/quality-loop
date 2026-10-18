# Architecture Review Request — for Claude / GPT / Gemini / other frontier LLMs

> Paste this whole document into the LLM of your choice and ask for a review.

## About the project

**Quality Management Platform (设计院质量管理平台)** — a mobile-first quality-management web platform for an
engineering design institute (~100 users). Built by one product owner + an AI pair-programmer,
with no dedicated frontend/backend engineers. It has run in production for ~4 months.

**Hard constraints that shaped every decision:**
- Single VPS with **1 GB RAM** (shared with a file-preview service)
- **Zero build step**: vanilla JS SPA, no framework, no bundler, no npm on the frontend
- Must run **unattended for years** with minimal ops attention
- Chinese-language content; users are engineers on phones

## Stack

- Frontend: vanilla JS hash-router SPA + PWA (add-to-homescreen)
- Backend: Node.js + Express, single process under pm2
- Database: SQLite (single file + WAL), FTS5 trigram full-text search
- Auth: JWT + RBAC (roles: dean/chief/section_leader/designer + read-only "guest" accounts)
- AI: any OpenAI-compatible gateway, with an automatic model fallback chain
- Ops: self-written Node reverse proxy (80/443), Let's Encrypt, cron-based backups

## Architecture (see docs/ARCHITECTURE.md for detail)

```
Browser (vanilla SPA) → Node reverse proxy → Express monolith → SQLite (+FTS5)
                                                          → external: LLM gateway,
                                                            knowledge-base API (COS upload),
                                                            WeChat push (ServerChan)
```

## Modules

1. **Announcements** — formal notices with read-receipt tracking (dynamic "should-read" pool, author-exempt)
2. **Knowledge dissemination** — standards/training posts; publishing earns points
3. **PDCA** — quality-issue lifecycle: found → solving → all-hands case sharing → institute selection
4. **Topics** — thematic collections linking announcements/dissemination/PDCA items
5. **Quality library** — unified FTS5 search across all content incl. attachment text (docx/xlsx/txt)
6. **AI Q&A** — answers grounded in library text with numbered citations; graceful degradation when the LLM fails
7. **Points/flowers** — incentive system with idempotent awarding and monthly leaderboard
8. **Exams** — question bank with scoring and ranking
9. **Reminders** — WeChat push via ServerChan; IMA knowledge-base sync with self-healing

## Design decisions worth scrutinizing

- **SQLite at ~100 users** with 15-min VACUUM INTO backups — what breaks first at 10x scale?
- **FTS5 trigram** for Chinese substring search + 2-gram IDF fallback for zero-hit queries — sane?
- **Vanilla JS with global namespaces** (App/Pages/UI/API) and no build — what would you change?
- **RBAC as role strings + guest accounts** (read-only, view-scope derived from role) — security holes?
- **LLM model fallback chain** (try models in order on quota/timeout errors) + always-200 graceful degradation — risks?
- **Read-receipt pool computed dynamically** (by division/role, author exempt) vs materialized — tradeoffs?
- **Idempotent point awarding** at application layer ((kind, ref_id) unique) — race conditions?

## Questions for the reviewer

1. What are the **top 3 risks** in this architecture for a 3-year unattended run?
2. If you had to **remove one architectural decision**, which would it be and why?
3. What's missing for **production readiness** (observability, CI/CD, testing, security)?
4. How would you **restructure the frontend** to survive 3 more years of feature growth without a build step becoming painful?
5. Any **SQLite-specific** pitfalls in the migration/backup approach?
6. Is the **AI Q&A grounding** design (retrieve → cite → degrade) sound? What would you improve?
7. What would a **senior staff engineer** flag first in code review?

## Context notes

- The codebase is in Chinese (comments and UI). Module names are descriptive.
- Sensitive data (real names, servers, keys, organization names) has been scrubbed; `superadmin` is a placeholder username.
- Licensed under MIT (personal, not on behalf of any organization).
