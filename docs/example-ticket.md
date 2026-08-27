# Example Ticket — How Foreman Uses Hierarchy & Memory to Ship Auth

> Copy this to `.foreman/tickets/T001-auth.md` and run `foreman run T001 --verify`. Foreman routes it automatically: `lead` (premium) judges the brief, `coder` (standard) implements under budget, `tester` (standard) writes tests, `drone` (economy) writes REPORT.md — all under hard context caps.

```yaml
---
id: T001
title: Add JWT auth to the API
created: 2026-08-27
status: queued
kind: implement
# Hierarchy: this kind routes to `coder` (standard tier) via routing[implement]=coder
# The lead (premium) never implements — it only reviews via --continue feedback
depends_on:
verify:
  # Gates must be able to FAIL on each acceptance criterion — never just `npm test`
  - test -f src/auth/jwt.ts
  - test -f src/auth/jwt.test.ts
  - node --test src/auth/jwt.test.ts 2>&1 | grep -E '^# pass ([3-9]|[1-9][0-9]+)$'
  - "! grep -rn 'jsonwebtoken' src --include='*.ts' | grep -v 'jwt.ts' | grep -v '.test.ts'"
budget:
  steps: 60
  outTokens: 20000
  # Memory: this ticket's budget is bounded by the tier's maxOutPerRun (standard: 30k)
  # If the run exceeds steps/outTokens/ctxCap, the engine SIGTERMs it and escalates
timeout: 40
idle: 4
---

# Add JWT auth to the API

## Goal
When done, `POST /auth/login` accepts `{email,password}` and returns `{token}`, `GET /auth/me` validates `Authorization: Bearer <token>` and returns the user, and all existing tests still pass. This unblocks T002 (protect routes).

## Context
Read first:
- `src/api/server.ts` — how routes are registered (Fastify)
- `src/db/users.ts` — `findByEmail(email)` and `verifyPassword(hash, pw)`
- `docs/WORKFORCE_PLAN.md` §2.6 — checkpoint briefs, not logs, are how you resume
- Existing auth: none — you are adding the first auth module

## Requirements
1. Create `src/auth/jwt.ts` with `sign(payload, secret)` and `verify(token, secret)` using `jose` (already in package.json). No new deps.
2. Create `src/auth/middleware.ts` that reads `Authorization` header, verifies, and attaches `req.user` or 401s with `{"error":"unauthorized"}`.
3. Wire both into `src/api/server.ts` without touching other routes.
4. No `any`, no `// @ts-ignore`, match existing code style (see `src/api/health.test.ts` for test style).

## Acceptance criteria
- [ ] `POST /auth/login` with valid creds returns 200 and `{token: string}` where `jwt.verify(token)` succeeds
- [ ] `POST /auth/login` with bad password returns 401
- [ ] `GET /auth/me` with valid token returns 200 and `{email, id}`
- [ ] `GET /auth/me` without token returns 401
- [ ] New tests in `src/auth/jwt.test.ts` cover all 5 criteria and pass

## Out of scope
- Do not add refresh tokens, OAuth, or password reset
- Do not edit `src/db/users.ts` — read it only
- Do not commit — the manager commits after `foreman verify` passes

## Notes
- Run the narrowest gate first: `node --test src/auth/jwt.test.ts` before full `npm test`
- If the brief is ambiguous, ask in REPORT.md and stop — do not guess on auth
```

## How hierarchy handles this ticket

```
director (you) ──writes T001──▶ lead (premium, 90k ctxCap, 12k out)
                                    │ judges from 6k brief, writes gates
                                    ▼
                              coder (standard, 60k ctxCap, 30k out)
                                    │ implements under budget, runs gates
                                    ▼
                              tester (standard) ── if kind:test
                              drone (economy, 40k ctxCap, 8k out) ── writes REPORT.md
```

- **Routing:** `route(T001)` → `assignee ? routing[kind] → coder` → `tier.standard` → model `muse-spark-1.2` (fallback `mimo-v2.5-free`). See `foreman agents`.
- **Budget:** `steps:60, outTokens:20k, ctxTokens:60k, ctxKill:140k`. The run loop (`foreman.mjs:298` `checkBudget`) SIGTERMs if crossed.
- **Memory:** If `ctx > 60k`, the run may finish but `--continue` is refused — next run starts fresh from a deterministic `checkpointBrief` (`lib.mjs:567` — git diff, REPORT.md, gate tail, 6k cap). No session grows unbounded.

## How memory is kept down (binding rules)

1. **Deterministic before generative** — digests, diffs, gate parsing, briefs are code
2. **Premium = judgement only** — lead never implements, only reviews 6k briefs
3. **Volume down-tier** — coder/standard, drone/economy
4. **Every run has a budget** — engine enforces, not the model
5. **Context caps per tier** — premium 90k, standard 60k, economy 40k; past cap → fresh session + brief
6. **Retry cheap first** — fresh session → gate tail → lead review → blocked
7. **Stable prefix** — PROTOCOL + persona + ticket identical bytes → provider cache hits

Run it:
```bash
foreman run T001 --verify
foreman tail T001         # live digest
foreman report T001       # worker's claims
foreman verify T001       # you run the gates — worker's word is never the gate
foreman cost --by tier    # spend by tier
```

See `foreman ui` → `1 STREAM` (live), `2 ORG` (hierarchy), `3 TASKS` (DAG), `4 COST` (spend).
