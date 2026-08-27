# Foreman — Marketing Kit

> **One-line:** Foreman is your decision-making friend — a tiered AI workforce that never forgets, never blows its budget, and shows you everything.

## 1. Positioning

**Category:** Multi-model orchestration engine for AI coding agents (not another agent — the *engine* around them).

**For:** Developers with a lot of work that requires *judgement* — breaking vague goals into tickets, choosing between options, keeping context without drowning, and knowing what to do next.

**Enemy:** 
- Single-prompt agents that blow 300k tokens and stall at 60k context with `cacheRead≈0`
- "Just use one model" — expensive tier doing chores, cheap tier doing design
- Tickets that are really prompts, gates that never fail, workers that are trusted

**Why Foreman:**
- **Tickets, not prompts** — a document that survives the run, with verify commands that can *fail*
- **Hierarchy, not flat** — director → lead (premium, 90k) → coder/tester (standard, 60k) → drone (economy, 40k)
- **Memory, not amnesia** — hard caps per tier, deterministic checkpoint briefs (6k), no session past cap
- **Engine, not guess** — budgets (steps/outTokens/ctx/usd) enforced mid-run, escalation ladder, every hand-off on disk

**Taglines (pick one):**
- *Foreman — the workforce that never forgets.*
- *Foreman — your decision-making friend for heavy workloads.*
- *Foreman — tickets in, verified code out. Budgets enforced.*
- *Foreman — one manager, many minds, zero amnesia.*

## 2. Story — what it solves

**Before:** You have 20 tickets, 3 models, and a deadline. You paste a prompt into a chat, it runs 80 steps, stalls at 58k context, burns $4, and writes a REPORT.md that says "done" while `npm test` fails. You read a 200-line log to decide "fresh or continue?" and pay premium tokens for that reading. The next run does the same.

**After (with Foreman):** You write a ticket with *verify commands that can fail*. You run `foreman run T001 --verify` — it routes to `coder` on `muse-spark-1.2`, streams JSONL to `.foreman/runs/T001/`, enforces `steps:60, outTokens:20k, ctxCap:60k`. If it stalls twice, the router skips that model. If `ctx >60k`, the next run starts fresh from a 6k brief (git diff + REPORT + gate tail). A `lead` on `minimax-m3` writes the feedback, not the code. `foreman companion --watch` nudges you every 30s. `foreman cost --by tier` shows spend. The gate is run *by foreman*, not trusted.

**Proof:** `docs/WORKFORCE_PLAN.md` §3 (binding token-economy rules), `lib.mjs:checkBudget()` one deep seam, `docs/demo.gif` 45s macOS, `docs/example-ticket.md` exemplary JWT auth ticket.

## 3. Names

- **Product:** Foreman
- **NPM:** `@mastaan66/foreman` (`npm i -g @mastaan66/foreman`, `npx @mastaan66/foreman`)
- **CLI:** `foreman` (bin: `bin/foreman` sh, `bin/foreman.cmd`, `bin/foreman.ps1` — all platforms)
- **Site:** `https://mastaan66.github.io/foreman/` (GitHub Pages, `docs/index.html`)
- **Repo:** `https://github.com/mastaan66/foreman`
- **Releases:** `https://github.com/mastaan66/foreman/releases` (v0.3.1 latest, demo + CLI registry)

## 4. Packages — whats that package thing on GitHub?

**npmjs (primary, public discoverability):**
```bash
npm i -g @mastaan66/foreman       # https://www.npmjs.com/package/@mastaan66/foreman
npx @mastaan66/foreman --version
```
`package.json:publishConfig {access:public}` → `npm publish --access public` (needs `npm login`, OTP). Badge: `https://img.shields.io/npm/v/@mastaan66/foreman`.

**GitHub Packages (same tarball, different registry, org-private or provenance):**
```bash
# .npmrc for GitHub Packages
@mastaan66:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}

npm publish --registry https://npm.pkg.github.com
# https://github.com/mastaan66/foreman/packages
```
Same `package.json`, just `registry` override. Use **npmjs for public**, **GitHub Packages for private org installs** or Sigstore provenance. Your repo already has `topics` and `homepage` for discoverability; packages appear under repo sidebar once published.

## 5. What to post — where & when

**Trending mechanic:** GitHub Trending = `stars / hour in 24h`. 80 in a day > 300 over a month. **Compress all launches into one day (Tue-Thu 8:30am ET).**

| Channel | Title / Hook | Body angle | Timing |
|---|---|---|---|
| **Hacker News Show HN** | `Show HN: Foreman — multi-model orchestration with hard budgets and checkpoint briefs` | Why tickets > prompts, why premium never implements, 45s macOS demo, `vhs` | 08:30 ET Tue-Thu, link to repo + site |
| **Reddit r/programming** | `I built a workforce, not a prompt — Foreman routes by tier, caps context, enforces budgets` | Before/after token burn, `foreman cost --by tier` screenshot | +1h after HN |
| **Reddit r/commandline, r/node, r/selfhosted** | `Foreman: foreman init → ticket → run --verify → ui (TUI) — 30s to first verified ticket` | How to use, install one-liner | same morning |
| **X (Twitter) thread** | `Director writes tickets. Lead judges. Coder implements. Drone reports. All under budgets.` (1/5) | 30s clip from `docs/demo.gif` + thread: hierarchy, memory, decision | same morning, 9:16 clip |
| **LinkedIn** | `Decision fatigue is a budget problem — Foreman makes “fresh or continue?” deterministic` | Story: stalls at 55k, briefs at 6k, ladder | same morning |
| **Dev.to / Hashnode** | `How we cut token spend 3× by never letting cheap models plan` | Deep dive: `WORKFORCE_PLAN.md` §2.6-2.9, `checkBudget()` | publish day before, link on launch |

## 6. Copy-paste posts

### HN Show HN
```
Show HN: Foreman — multi-model orchestration with hard budgets and checkpoint briefs

I was burning 300k tokens on one ticket and stalling at 60k context. Foreman fixes it: director writes tickets (not prompts), lead (premium, 90k cap) judges from 6k briefs, coder (standard, 60k) implements under budgets, drone (economy) writes reports. The engine routes, enforces (steps/outTokens/ctx/usd), and escalates (fresh → lead review → blocked).

- Zero deps, Node ≥22, opencode as substrate
- foreman init → ticket → run --verify → tail/report → cost --by tier
- foreman decide / plan / prioritize / companion --watch for decision-heavy days
- 45s macOS demo, exemplary ticket, GitHub Pages site

Repo: https://github.com/mastaan66/foreman
Site: https://mastaan66.github.io/foreman/
Install: npm i -g @mastaan66/foreman
Demo: docs/demo.gif (vhs docs/demo.tape)

Happy to answer anything about tiering, briefs, or why gates must be able to fail.
```

### Reddit r/programming
```
Title: I built a workforce, not a prompt — Foreman routes by tier, caps context, enforces budgets

Body:
Every agent framework let the same model do everything until it stalled at 55k. Foreman is different: premium judges, standard implements, economy reports — each under its own ctxCap/ctxKill/maxOut. Past cap, --continue is refused; next run starts fresh from a deterministic 6k checkpoint brief (git diff + REPORT + gate tail). No session grows unbounded.

- `checkBudget()` one deep seam, pure, testable (lib.mjs)
- `foreman cost --by tier` shows spend per model
- `docs/example-ticket.md` shows a ticket whose verify can actually fail

45s demo, macOS, Catppuccin Macchiato: https://mastaan66.github.io/foreman/

Would love feedback on the hierarchy — does lead/coder/drone match how you delegate?
```

### X thread (5 tweets, 9:16 clip)
```
1/ Director writes tickets. Lead judges. Coder implements. Drone reports. All under budgets.

Foreman — your decision-making friend for heavy workloads.

45s macOS demo → https://mastaan66.github.io/foreman/

2/ Tickets, not prompts. A ticket has verify commands that can FAIL. The worker's word is never the gate — foreman runs verify itself.

3/ Hierarchy: lead (premium, 90k) → coder/tester (standard, 60k) → drone (economy, 40k). Routing[implement]=coder,Routing[plan]=lead. Hard caps.

4/ Memory: every run has a budget (steps/outTokens/ctx/usd). Past ctxCap, fresh session + 6k brief. No --continue past cap. Ever.

5/ Try it:
npm i -g @mastaan66/foreman
foreman init && foreman ticket hello && foreman run T001 --verify
Star if it saved you a decision: https://github.com/mastaan66/foreman
```

### LinkedIn
```
Decision fatigue is a budget problem.

I was reading 200-line logs to decide "fresh or continue?" and paying premium tokens for that reading. Foreman makes it deterministic: past 60k, --continue is refused. Next run starts fresh from a 6k brief (diff + REPORT + gate tail). Lead writes FEEDBACK.md, coder retries. No blind retries.

For teams with many tickets that need judgement, it’s a workforce, not a prompt.

Site + demo: https://mastaan66.github.io/foreman/
```

## 7. Launch checklist (compress into one day)

- [x] README: one-liner, badges, 45s demo, 30s quickstart, ticket example
- [x] Site: https://mastaan66.github.io/foreman/ (docs/index.html, GitHub Pages building)
- [x] Release: v0.3.1 (CLI registry + demo), v0.3.0
- [x] Topics: agents, ai, cli, dashboard, foreman, llm, multi-model, opencode, orchestration, tui, workforce
- [ ] npm: `npm login && npm publish --access public` → badge flips from unknown to 0.3.1 (see §4)
- [ ] GitHub Packages (optional): `npm publish --registry https://npm.pkg.github.com`
- [ ] Posts: HN 08:30 ET, Reddit +1h, X/LinkedIn same morning (templates above)
- [ ] After 24h: `gh api repos/mastaan66/foreman --jq .stargazers_count` + `star-history.com/#mastaan66/foreman` + `Insights → Traffic` → double down on winner

## 8. Measure “more used”

- `stars / hour in 24h` (Trending)
- `npm view @mastaan66/foreman downloads --json` (after publish)
- `gh api repos/mastaan66/foreman --jq .stargazers_count`
- Retention: `foreman cost --by tier` per verified ticket — are users verifying, not just staring?
```
