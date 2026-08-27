# Foreman

A multi-model orchestration engine for AI coding agents. A **director** (you, or a Claude
session) writes tickets; a **workforce** with a hierarchy — leads on a premium model,
coders/testers on a standard one, drones/librarians on a cheap one — executes them through
opencode under hard budgets and context caps. Foreman routes, launches, meters, gates,
escalates and shows you everything. Design: `docs/WORKFORCE_PLAN.md`.

```
director ─▶ lead (premium: plan · review · gates · feedback)
              ├─▶ coder   (standard: implement under a brief + budget)
              ├─▶ tester  (standard: tests from criteria)
              ├─▶ drone   (economy: reports, summaries, chores)
              └─▶ librarian (economy: where is X, context briefs)
```

## Workforce quick start
```
cd my-project && foreman init --name my-project   # roster in .foreman/agents/, synced to .opencode/agent/
foreman models --probe          # ping every configured model; dead/hanging ones are skipped by the router
foreman agents                  # role · tier · resolved model · supervisor · phase · spend
foreman ask lead "Split T001 into subtasks a standard model can finish in 40 minutes each"
foreman work --watch            # scheduler: ready tasks → agents, gates, escalation ladder
foreman cost --by model         # spend, tokens, stall rate
foreman                         # dashboard: 1 stream · 2 org (prompt any agent) · 3 tasks · 4 cost
```

How tokens are kept down (binding rules, see the plan §3): deterministic before generative
(digests, diffs, gate parsing, briefs are code); the premium tier only judges from capped
briefs; volume work goes down-tier; every run has an enforced budget (steps, output tokens,
context, USD, minutes); sessions are never continued past their tier's context cap — a
fresh session starts from a deterministic checkpoint brief; failures retry cheap first
(fresh → lead review → blocked), and a model that stalls twice on a ticket yields to its
tier's fallback.

## v1 in one paragraph
One agent plans, specifies, reviews and verifies; another executes. Foreman is the pipe.

```
   MANAGER (Claude)                 FOREMAN                     WORKER (opencode, headless)
   ─────────────────                ───────                     ──────────────────────────
   writes ticket  ─────────────▶  run <id>  ──────────────▶  reads PROTOCOL + ticket
                                  streams JSONL to disk  ◀──  edits, runs, tests
   tails digest   ◀─────────────  digests events
   reads REPORT   ◀─────────────  report <id>  ◀───────────  writes REPORT.md, stops
   runs gate      ─────────────▶  verify <id>   (runs the ticket's commands itself)
   writes feedback ────────────▶  run <id> --continue  ───▶  SAME session, context intact
   commits when verified
```

## Why this shape
- **Tickets, not prompts.** A ticket has a goal, context, numbered requirements, acceptance
  criteria, explicit out-of-scope, and verify commands. It is a document the manager can
  refine between runs and that survives the run.
- **The worker's word is never the gate.** Foreman runs the verify commands; the report is
  read, not trusted.
- **Feedback goes into the same session.** `--continue` resumes the worker's session id, so
  refinements build on what it already knows instead of starting cold.
- **Everything is on disk.** Raw JSONL, a readable digest, the composed message, the report,
  verify logs, and a state file with tokens/duration/exit per run.

## Install
Requires Node ≥ 22 and [opencode](https://opencode.ai) on `PATH`.

```
ln -s ~/Projects/foreman/bin/foreman ~/.local/bin/foreman
```

## The dashboard
```
cd my-project
foreman               # opens the live dashboard (same as `foreman ui`)
foreman ui --queue    # open it and start the queue in one go
foreman ui --once     # print one frame and exit (for logs / screenshots)
```

```
 FOREMAN  spashta  ~/Projects/spashta  worker: opencode default  20:03:04
┌ MANAGER · Claude ──────────────┐                ┌ WORKER · opencode ───────────────────────┐
│ phase   dispatching T005 run #1│ ticket         │ phase   planning 8 todos                 │
│ since   1m19s                  │ ▶═══▶═══▶═══▶▶ │ ticket  T005 run #1                      │
│ tickets 6  ● 4  ◔ 0  ✗ 0       │ ────────────── │ elapsed 1m19s   last event 2s ago        │
│ queue   running                │ report         │ steps 10 · tools 31 · tokens 77k         │
└────────────────────────────────┘                └──────────────────────────────────────────┘
┌ PIPELINE  tickets by dependency depth · edges = depends_on ─────────────────────────────────┐
│ ● T001 Scaffold ──┬──▶● T002 Ledger ──┬─▶⠋ T005 Defects ──┬▶○ T006 API                      │
│                   ├──▶● T003 Crawl    └───────────────────┘                                 │
│                   └──▶● T004 OCR                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ TICKETS ───────────────────────┐ ┌ WORKER STREAM  T005 ────────────────────────────────────┐
│ ● T001 verified  r2 gate✓ 351k │ │  1m14s [worker] Ledger spec mapped — drafting each rule  │
│ ◐ T005 running   r1 gate–  77k │ │  1m17s [tool:todowrite] 8 todos                          │
└────────────────────────────────┘ └──────────────────────────────────────────────────────────┘
 r run  c continue+msg  v verify  a accept  q queue  tab stream/activity/report  Q quit
```

- **NOW** — three plain sentences, always current: what the worker is doing this second
  (inferred from its event stream), what the manager is doing, and what the queue will
  dispatch next. Read this line first.
- **Spend / USD** — per run, per ticket and total, from opencode's own per-step `cost`.
  On a free-tier model it reports `$0.00 free tier`. To estimate for a model that doesn't
  report cost, set `worker.pricing: { "inputPerM": 3, "outputPerM": 15 }` (USD per
  million tokens) in `.foreman/foreman.json`; the header then says *estimated*.
- **Theme** — phosphor green on your terminal's black, amber for the worker and warnings,
  red for faults, cyan for the manager's side. 256-colour terminal recommended.
- **MANAGER / WORKER** boxes show each agent's current phase (the worker's is inferred live
  from its event stream: reading / editing / running / thinking / reporting), and the pipe
  between them animates in the direction work is flowing — ticket → worker while a run is
  live, report → manager when it's the manager's turn.
- **PIPELINE** draws the ticket DAG from `depends_on`, one column per dependency depth,
  status glyph per node (○ queued, spinner running, ◔ needs review, ● verified, ✗ broken).
- **TICKETS / WORKER STREAM / ACTIVITY / REPORT** — `tab` cycles the right panel between the
  worker's digest, the hand-off feed (who did what, when), and the selected ticket's report.
- Keys act on the selected ticket: `r` run, `c` continue with a typed message into the same
  session, `v` verify, `a` accept (with note), `q` start the queue. Actions are detached
  processes — quitting the dashboard never stops a worker.

## Use
```
cd my-project
foreman init --name my-project
foreman ticket scaffold --title "Scaffold the monorepo"     # edit .foreman/tickets/T001-scaffold.md
foreman run T001 --verify                                     # dispatch, then gate
foreman tail T001                                             # watch the digest
foreman report T001                                           # read the worker's report
foreman run T001 --continue --message "The tests you added mock the DB; use pg-mem instead."
foreman status
foreman queue --max 3       # run queued tickets in depends_on order, gating each; stops at first failure
```

`queue` is deliberately conservative: it only dispatches a ticket whose every `depends_on`
is already `verified`, and it halts the moment a gate fails so the manager reviews before
anything builds on a broken foundation. A green gate is still not acceptance — read the
report and the diff before committing.

`.foreman/foreman.json` sets the default worker model/variant/agent/timeout and project-wide
verify commands. Ticket frontmatter can override `model`, `variant`, `agent`, `timeout`, `verify`.

## Layout in a project
```
.foreman/
  foreman.json        worker defaults, project verify commands
  PROTOCOL.md         rules the worker gets on every run (edit to taste)
  state.json          per-ticket runs, tokens, verify results
  tickets/T001-*.md   the briefs
  runs/T001/
    run-1.message.md  exactly what the worker was sent
    run-1.jsonl       raw event stream
    run-1.log         readable digest
    verify-1.log      gate output
    REPORT.md         the worker's report (rewritten on each continue)
```
