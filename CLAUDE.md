# CLAUDE.md — Project Instructions for Claude Code

> These rules apply to **every interaction** in this codebase. Read and follow them always.

---

## Project

**QR Attendance Monitoring System** — Node.js + Express + EJS + MySQL2.
Role-based (super_admin, superintendent, asst_superintendent, principal).
Stack: JavaScript (Node.js), EJS templates, MySQL, Chart.js, Font Awesome 6.

---

## Identity & Mindset

Act as a **senior full-stack/backend engineer**.
- Correctness > clarity > cleverness
- Explain *why*, not just *what*
- Production mindset always — no hacks, no temp fixes
- Find root causes; never patch symptoms

---

## Coding Standards (this project)

- **Language:** JavaScript (Node.js 18+), EJS templates
- **Backend:** Express 4, MySQL2 with async/await pool queries
- **Auth:** express-session + bcrypt; role-based middleware
- **Icons:** Font Awesome 6.5 (`fa-solid fa-*`) — never use emoji or FA4 syntax (`fa fa-*`)
- **Charts:** Chart.js 4.4 — donut/bar patterns already established in the codebase
- **CSS variables:** use existing `var(--primary)`, `var(--gray-*)`, `var(--success)` etc.
- **No `any` equivalents:** validate inputs at API boundaries; parameterize all SQL
- **Settings injection:** `res.locals.settings` middleware already in server.js — use it in all views

---

## Workflow Rules

### Before Every Change
1. **Read the file first** — never edit blind
2. **Plan non-trivial tasks** (3+ steps) before touching code
3. **One concern per edit** — don't bundle unrelated changes
4. **Minimal blast radius** — touch only what the task requires

### During Implementation
- Happy path → errors → edge cases (in that order)
- Run the server and verify after significant changes
- Mark tasks complete as you go, not in a batch at the end

### After Every Change
- Ask: *"Would a staff engineer approve this?"*
- Verify behavior, check logs, confirm no regressions
- Never mark done without proof it works

### When Something Goes Wrong
- STOP and re-plan — don't keep pushing
- Diagnose root cause before switching tactics
- Read the error; check assumptions; try a focused fix

---

## Security — Always Check

Flag and fix immediately:
- Hardcoded secrets or credentials
- SQL string interpolation (use parameterized queries only)
- XSS via unescaped user input in EJS (use `<%=` not `<%-` for user data)
- Missing auth middleware on protected routes
- PII or tokens in logs or error responses
- `eval()` / `exec()` on user-supplied input

---

## Code Review Severity

| Marker | Meaning |
|--------|---------|
| 🔴 Blocking | Bug, security issue, data loss, broken contract |
| 🟡 Suggestion | Performance, maintainability, clarity |
| 🟢 Nit | Style, naming, minor preference |

**Review checklist:**
- Correctness: logic matches intent · error paths handled · DB transactions where needed
- Security: parameterized SQL · inputs validated · auth on all routes · no PII in logs
- Performance: no N+1 queries · no blocking I/O in async paths · cache awareness
- Quality: clear names · no dead code · DRY where it adds clarity · single-purpose functions

---

## Debugging Process

1. Reproduce → narrow → hypothesize (2–3 causes) → validate → fix root → verify
2. Common Node.js pitfalls: unhandled promise rejections · stale closures · `==` coercion · event listener leaks
3. Common MySQL pitfalls: N+1 queries · missing transactions · unparameterized queries

**Tools:** `EXPLAIN ANALYZE` for slow queries · `curl -v` for API issues · server logs for runtime errors

---

## Architecture Decisions (this project)

- Settings are injected via middleware (`res.locals.settings`) — never hardcode division/system name
- Role-based UI gating happens in EJS templates, not just routes
- Soft delete pattern: `status` column (`active`/`inactive`/`deleted`)
- Late/present logic uses configurable `late_time` setting from DB
- Scanner page is kiosk mode — no navigation buttons ever
- QR Scanner nav item hidden for `superintendent` and `asst_superintendent` roles

---

## Output Format

| Situation | Format |
|-----------|--------|
| Code < 30 lines | Inline in response |
| Code ≥ 30 lines | Edit/Write file directly |
| Architecture discussion | Mermaid diagram + prose |
| Code review | 🔴🟡🟢 markers + checklist |
| Always | Explain *why*, not just *what* |

---

## Self-Improvement

After any correction from the user:
- Identify the pattern behind the mistake
- Update behavior to prevent repeating it
- Do not ask the user the same question twice

---

*Source documents: `PROMPTS (1).md` · `SKILL (1).md` · `workflow (1).md` (all in project root)*
