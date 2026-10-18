# Quality-Management Review Request — for Claude / GPT / Gemini / other frontier LLMs

> Paste this whole document into the LLM of your choice. This is a **business / quality-management-logic**
> review request — a companion to `REVIEW_REQUEST.md` (architecture review). The reviewer is asked to
> evaluate the *module design and quality-management rationale*, not the code.

## Context

**Quality Management Platform (设计院质量管理平台)** — a mobile-first quality-management platform built for
an **engineering design institute** (~100 staff: ~1 dean, ~6 discipline chief engineers, ~10 section leaders,
~80 designers). Built by one product owner (the deputy dean, who owns the quality program) + an AI
pair-programmer. In production ~4 months.

**Hard constraints that shaped every decision:**
- Single VPS with 1 GB RAM; one-person maintenance; must run unattended for years
- Users are engineers, mostly on phones; Chinese-language content
- The institute's quality program follows a "two-lines, five-dimensions, performance-closed-loop" philosophy

## The quality-management model behind the module map

The platform is organized around a deliberate **separation of concerns**, where each module owns one
distinct function in the quality system:

| Module | QM function | ISO 9001:2015 mapping (design intent) |
|---|---|---|
| **Announcements** | Formal downward communication of decisions/rules; read-receipt compliance | 7.4 communication, 7.5 documented information |
| **Knowledge dissemination** | Standards interpretation, methods, lessons — publishing earns points | 7.1.6 organizational knowledge, 7.2 competence |
| **PDCA** | Quality-issue lifecycle: found → solving → all-hands case sharing → institute selection | 10.2 nonconformity & corrective action (CAPA) |
| **Topics** | Thematic/episodic organization: campaigns, campaigns, reviews, stage results | 10.3 continual improvement, 4.4 QMS processes |
| **Quality library** | Unified searchable corpus incl. attachment text (docx/xlsx/txt) + AI Q&A with citations | 7.1.6 organizational knowledge |
| **Exams** | Competence verification against a question bank | 7.2 competence evidence |
| **Points/flowers** | Voluntary contribution recognition; monthly leaderboard (deans/chiefs excluded from ranking) | 5.1 leadership & engagement of people |
| **Read tracking** | Dynamic "should-read" pool by division/role, author exempt | 7.4 communication effectiveness |
| **Reminders** | WeChat push for pending items; sync to an external knowledge base | — |

**Deliberate boundary choices (invite critique):**
- Announcements = formal notices; dissemination = knowledge/standards teaching; PDCA = issue closure;
  topics = process/stage organization. Content that is "formal" goes to announcements, "educational" to
  dissemination, "problem-solving" to PDCA, "thematic" to topics. This boundary is enforced by role
  permissions and UI framing, not hard data types.
- Quality-issue work orders (ticketing) were intentionally deferred out of the first phase — PDCA items
  carry the issue-closure function instead.
- The platform does **not** attempt: project-level quality plans, drawing-review workflow (stays in the
  existing CAD/PLM world), supplier/outsourced-design quality (8.4), or management-review dashboards (9.3).

## Observed usage after 4 months (honest numbers, no names)

- Content production is steady: announcements, dissemination posts, PDCA items all being created and consumed
- **Flower points: 26 awarded, to 17 people (≈16.5% of staff)** — a thin contribution layer
- **Read-acknowledgement rate: ≈35%** of expected readers confirm reads
- **Monthly active users: ≈45%**
- Self-assessment: the platform currently behaves as **"the quality manager's workbench"** rather than a
  whole-staff quality community

## Questions for the reviewer

1. **Module taxonomy.** Is this four-way split (announcements / dissemination / PDCA / topics) coherent
   for an engineering design institute's quality system? Where are the overlaps or missing seams
   (e.g., a lesson-learned that is both knowledge and a corrective action)?
2. **ISO 9001:2015 coverage.** Given the clause mapping above, which high-leverage clauses are absent
   (6.1 risk-based thinking, 8.2 customer feedback, 8.3.4-5 design review/verification, 8.4 outsourced
   processes, 9.2 internal audit, 9.3 management review, 10.2 effectiveness verification)? If you could
   add exactly two of them to this platform, which two and why?
3. **CAPA completeness.** Is the PDCA lifecycle (found → solving → all-hands sharing → institute
   selection) a complete corrective-action loop? What is missing — closure criteria, effectiveness
   verification, recurrence tracking, root-cause taxonomy?
4. **Incentive design.** The points scheme awards ~3 points to a chief for a dissemination post, ~1 to a
   section leader, 2-3 for PDCA items. Does this risk rewarding volume over quality? What incentive
   structures from quality-management practice (quality circles, peer nomination, defect-cost
   transparency, intrinsic motivation) would you digitize instead?
5. **Compliance model.** Read receipts use a dynamically computed "should-read" pool with author
   exemption. Is this the right model for "documented information" communication in 9001 terms? What
   would a lead auditor say about it?
6. **Participation.** 45% MAU and 16.5% contributors after 4 months. What quality-management practices
   proven to raise engagement in engineering organizations (Gemba, cross-discipline review, internal
   audit teams, defect Pareto transparency) could realistically be built into this platform by a
   one-person team?
7. **Metrics.** What is the right KPI set (leading vs lagging) for a design-institute quality platform?
   Current metrics: content volume, read rate, points, MAU. What is misleading or missing
   (first-pass yield, rework hours, recurrence rate, cost of poor quality)?
8. **Knowledge loop.** Dissemination + library + AI Q&A address organizational knowledge. Is the loop
   closed — do PDCA lessons flow back into standards/dissemination/training, and does the exam bank
   track the top defect causes? What is the strongest missing link?
9. **Role design.** Deans/chiefs are excluded from the points ranking by design. Is excluding leadership
   from quality incentives correct for a hierarchical institute, or does it undermine the program?
10. **Roadmap.** If you were the product owner with a one-person maintenance budget for the next year,
    what is your prioritized top-5 roadmap, and what would you explicitly refuse to build?

## What a useful answer looks like

- Concrete, opinionated critique of the module map (not generic ISO 9001 summaries)
- The two highest-leverage additions, with rationale tied to design-institute reality
- A KPI proposal that a quality manager could actually put on a monthly slide
- Honest assessment of whether the "manager's workbench" trajectory is fixable within this architecture

## Context notes

- The codebase is in Chinese (comments and UI). For architecture/tech review see `REVIEW_REQUEST.md` and
  `docs/ARCHITECTURE.md` in this repository.
- Sensitive data (real names, servers, keys, organization names) has been scrubbed. Usage statistics are
  aggregates only.
- Licensed under MIT (personal, not on behalf of any organization).
