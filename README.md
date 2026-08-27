# Foreman

[![npm version](https://img.shields.io/npm/v/@mastaan66/foreman?color=brightgreen)](https://www.npmjs.com/package/@mastaan66/foreman)
[![GitHub release](https://img.shields.io/github/v/release/mastaan66/foreman?label=release&color=blue)](https://github.com/mastaan66/foreman/releases)
[![CI](https://github.com/mastaan66/foreman/actions/workflows/ci.yml/badge.svg)](https://github.com/mastaan66/foreman/actions)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No dependencies](https://img.shields.io/badge/dependencies-0-blue)

**Multi-model orchestration for AI coding agents — a director writes tickets; a tiered workforce (lead → coder/tester → drone) executes them through [opencode](https://opencode.ai) under hard budgets and gates.**

```
director ─▶ lead (premium: plan · review · gates)
              ├─▶ coder   (standard: implement)
              ├─▶ tester  (standard: tests)
              ├─▶ drone   (economy: reports, chores)
              └─▶ librarian (economy: retrieval)
```

> **Design doc:** [`docs/WORKFORCE_PLAN.md`](docs/WORKFORCE_PLAN.md) · **Zero dependencies · Node ≥22 · opencode as substrate**

<p align="center">
  <img src="docs/demo.gif" alt="foreman demo — macOS, 45s, hierarchy & memory, Catppuccin Macchiato" width="800" />
  <br/>
  <em>45s demo (macOS, Catppuccin Macchiato, 1280×760): <strong>how to use</strong> → <strong>hierarchy</strong> (<code>foreman agents</code>, tiers) → <strong>memory</strong> (<code>ctxCap/ctxKill, checkBudget, checkpointBrief, cost</code>) → <strong>ticket example</strong> (<code>docs/example-ticket.md</code>) → <code>ui --once</code>. Every command in one take. <a href="#recording-a-demo">Record your own with VHS</a> · <code>vhs docs/demo.tape</code> · <a href="docs/example-ticket.md">Example ticket</a></em>
</p>

## 15-second quick start

```bash
# 1. install
npm i -g @mastaan66/foreman
# or: npx @mastaan66/foreman --version

# 2. check
foreman doctor          # Node, opencode, workspace

# 3. init in your project
cd my-project
foreman init --name my-project
# roster → .foreman/agents/ → synced to .opencode/agent/

# 4. first ticket
foreman ticket hello --title "Add a hello test"
# edit .foreman/tickets/T001-hello.md — fill Goal, Requirements, verify
foreman run T001 --verify
foreman report T001      # worker's claims
foreman tail T001        # live digest
```

**One command to see everything:**

```bash
foreman                # live dashboard: 1 STREAM · 2 ORG · 3 TASKS · 4 COST
foreman ui --once      # one frame for screenshots/CI
```

## Install

| Method | Command |
|---|---|
| npm (recommended) | `npm i -g @mastaan66/foreman` |
| npx (no install) | `npx @mastaan66/foreman --help` |
| from source | `git clone https://github.com/mastaan66/foreman && ln -s $PWD/foreman/bin/foreman ~/.local/bin/foreman` |

Requires **Node ≥22** and **opencode ≥1.18** on `PATH`:

```bash
curl -fsSL https://opencode.ai/install | bash
foreman doctor
```

## Why tickets, not prompts?

- **Tickets, not prompts.** Goal + context + numbered requirements + acceptance criteria + out-of-scope + `verify` commands. A document the manager refines between runs, not a prompt that vanishes.
- **The worker's word is never the gate.** Foreman runs `verify` itself; the report is read, not trusted.
- **Same-session feedback.** `foreman run T001 --continue --message "use pg-mem"` resumes the worker's `sessionID`.
- **Everything on disk.** JSONL, digest, message, REPORT.md, verify logs, state with tokens/duration/exit per run.
- **Budgets enforced by the engine.** Steps, output tokens, context, USD, minutes — crossing any limit SIGTERMs the worker and escalates (fresh → lead review → blocked).

Token discipline (binding, see plan §3): deterministic before generative, premium tier judges only from capped briefs, volume goes down-tier, no `--continue` past the tier's context cap — fresh session from a deterministic checkpoint brief instead.

## How it works — the pipe

```
   MANAGER (Claude/you)            FOREMAN                     WORKER (opencode, headless)
   ─────────────────                ───────                     ──────────────────────────
   writes ticket  ─────────────▶  run <id>  ──────────────▶  reads PROTOCOL + ticket
                                  streams JSONL to disk  ◀──  edits, runs, tests
   tails digest   ◀─────────────  digests events
   reads REPORT   ◀─────────────  report <id>  ◀───────────  writes REPORT.md, stops
   runs gate      ─────────────▶  verify <id>   (runs gates itself)
   writes feedback ────────────▶  run <id> --continue  ───▶  SAME session
   commits when verified
```

## Workforce quick start (tiers)

```bash
foreman models --probe          # ping every model; dead ones are skipped by router
foreman agents                  # role · tier · resolved model · supervisor · phase · spend
foreman ask lead "Split T001 into subtasks a standard model can finish in 40m each"
foreman work --watch            # scheduler: ready tasks → agents, gates, escalation ladder
foreman cost --by model         # spend, tokens, stall rate per tier/agent/model/ticket
```

Default tiers in `.foreman/foreman.json`:

| Tier | Default model | ctxCap | ctxKill | max out | Use |
|---|---|---|---|---|---|
| premium | `nvidia/minimaxai/minimax-m3` | 90k | 180k | 12k | plan, review, feedback |
| standard | `opencode/muse-spark-1.2` | 60k | 140k | 30k | implement, fix, test |
| economy | `opencode/hy3-free` | 40k | 90k | 8k | report, chore, research |

`foreman models --probe` marks `dead`/`timeout` models; the router skips them and a run that errors before the first step is auto-re-routed to the next fallback.

## The dashboard

```
cd my-project
foreman               # live
foreman ui --queue    # open and start queue
foreman ui --once     # one frame
```

```
 FOREMAN  spashta  ~/Projects/spashta  worker: opencode default  20:03:04
┌ MANAGER · Claude ──────────────┐                ┌ WORKER · opencode ───────────────────────┐
│ phase   dispatching T005 run #1│ ticket         │ phase   planning 8 todos                 │
│ since   1m19s                  │ ▶═══▶═══▶═══▶▶ │ ticket  T005 run #1                      │
│ tickets 6  ● 4  ◔ 0  ✗ 0       │ ────────────── │ elapsed 1m19s   last event 2s ago        │
│ queue   running                │ report         │ steps 10 · tools 31 · tokens 77k         │
└────────────────────────────────┘                └──────────────────────────────────────────┘
┌ PIPELINE  tickets by dependency depth ───────────────────────────────────────────────────────┐
│ ● T001 Scaffold ──┬──▶● T002 Ledger ──┬─▶⠋ T005 Defects ──┬▶○ T006 API                      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ TICKETS ───────────────────────┐ ┌ WORKER STREAM  T005 ────────────────────────────────────┐
│ ● T001 verified  r2 gate✓ 351k │ │  1m14s [worker] Ledger spec mapped                      │
│ ◐ T005 running   r1 gate–  77k │ │  1m17s [tool:todowrite] 8 todos                          │
└────────────────────────────────┘ └──────────────────────────────────────────────────────────┘
 r run  c continue+msg  v verify  a accept  q queue  tab stream/activity/report  Q quit
```

- **NOW** — three sentences: what the worker is doing this second, what the manager is doing, what the queue dispatches next.
- **PIPELINE** — DAG from `depends_on`, one column per depth, glyphs `○ queued ◐ running ◔ review ● verified ✗ broken/ blocked`.
- **Keys:** `r` run · `c` continue · `v` gate · `a` accept · `q` queue · `w` work · `p` ask lead · `tab` panels · `1-4` views · `Q` quit — detached, so `Q` never kills workers.
- **Spend** — per run/ticket/agent from opencode's `cost`; free tier shows `$0.00` (set `tiers.<name>.inputPerM/outputPerM` to estimate).

## Commands

```
foreman init [dir] [--name n] --sample     create .foreman/ + roster + synced agents
foreman doctor                             check Node, opencode, workspace, models
foreman agents [sync|install]              roster (role/tier/model/supervisor/spend)
foreman models [--probe] [model]           tiers and health
foreman ticket <slug> --title "..." [--kind plan|review|implement|test|chore] [--parent T001]
foreman run <id> [--message "..."] [--continue|--fresh] [--agent a] [--tier t] [--model p/m] [--verify] [--auto-report]
foreman ask <agent> "prompt" [--fresh] [--file f]  ask any agent in its persistent session
foreman work [--concurrency N] [--max N] [--watch]   daemon with escalation ladder
foreman queue [--max N]                    sequential (stops at first failed gate)
foreman verify <id> | accept <id> --note "..." | cost [--by tier|agent|model|ticket] | status | report <id> | tail <id> | diff | note "..."
foreman --version | -v | version
```

`queue` is conservative — only dispatches when every `depends_on` is `verified`, halts on first failed gate. `work` ladder: `attempt 1 → fresh retry · attempt 2 → supervisor review (FEEDBACK.md) · attempt 3 → blocked`.

## Ticket format

```yaml
---
id: T006.2
title: Write server.test.ts from acceptance criteria
kind: test                 # plan | review | implement | fix | test | chore | summarise | report | research
assignee: tester           # optional; else routing[kind]
depends_on: T006.1
budget: { steps: 60, outTokens: 20000 }
verify:
  - node --test "apps/api/src/**/*.test.ts" 2>&1 | grep -E '^# pass ([9]|[1-9][0-9]+)$'
---
# Title
## Goal · Context · Requirements · Acceptance criteria · Out of scope
```

`.foreman/foreman.json` sets `worker.command`, `timeoutMinutes`, `idleMinutes`, `tiers`, `routing`, `concurrency`, `verify`. Ticket frontmatter can override `model`, `variant`, `timeout`, `verify`, `tierMin`.

## Layout in a project

```
.foreman/
  foreman.json        tiers, routing, worker defaults
  PROTOCOL.md         rules the worker gets every run
  state.json          per-ticket runs, tokens, verify results
  tickets/T001-*.md   briefs
  runs/T001/
    run-1.message.md  exactly what was sent
    run-1.jsonl       raw JSONL
    run-1.log         readable digest
    verify-1.log      gate output
    REPORT.md         worker's report (rewritten on --continue)
  agents/<name>/      per-agent sessions, replies
  events.jsonl        append-only hand-off log (rotates at 5 MB)
```

## Recording a demo

```bash
npm i -g vhs                # https://github.com/charmbracelet/vhs
vhs docs/demo.tape          # writes demo.gif — replace the placeholder above
```

`docs/demo.tape` example:

```
Output demo.gif
Set Width 1200
Set Height 700
Type "foreman init --name demo && foreman ticket hello --title 'Hello' && foreman run T001 --verify"
Sleep 2000
```

## Development

```bash
git clone https://github.com/mastaan66/foreman && cd foreman
npm test                    # node --test test/*.test.mjs
npm run check               # node --check
foreman doctor
```

See `CONTRIBUTING.md` and `CHANGELOG.md`.

## License

MIT — see [LICENSE](LICENSE).
