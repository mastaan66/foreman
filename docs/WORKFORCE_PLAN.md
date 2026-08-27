# Foreman Workforce — technical plan

**Status:** approved for implementation, 2026-08-26. Foreman v1 (one manager, one worker,
tickets, gates, dashboard) is the substrate; v2 turns it into a multi-model orchestration
engine with an agent hierarchy, hard token budgets and cost-aware routing.

## 0. Goals and non-goals

Goals
1. A **workforce with hierarchy**: director → leads → workers → drones, each an agent with a
   role, a model tier, permissions, a budget and a supervisor.
2. **Cost-aware routing**: expensive models do little, dense work (plan, review, decide);
   cheap models do the volume (implement under a brief, test, chores, summaries, reports).
3. **Bounded context**: no session grows without limit; no agent ever receives a raw stream;
   hand-offs upward are capped briefs.
4. **Operable**: from the UI, open any agent, see exactly what it is doing, prompt it, read
   its answer; see spend by agent/tier/task; see why something is blocked.
5. **Scales on disk, not in RAM**: state per task and per agent in their own files, an
   append-only event log, the daemon and the UI stream and tail — they never load
   everything.

Non-goals
- Replacing opencode. It stays the execution substrate (tools, providers, sessions,
  per-agent model + permissions). Foreman orchestrates around it.
- Autonomous merging/pushing. Humans (or the director) commit after gates.
- Solving captchas, bypassing rate limits, or hiding cost.

## 1. What today's six tickets taught (constraints that shaped this design)

| Observation (spashta, 2026-08-26) | Design consequence |
|---|---|
| T001 needed 350k tokens; T006 burned 335k across 3 runs and produced half an API | Budgets per task; escalate on the second failure instead of retrying blind |
| The free model stalled 6 times, always on turns with ≥ 55k context and `cacheRead≈0` | Per-tier **context cap**; fresh session from a deterministic **checkpoint brief** instead of `--continue` past the cap |
| A gate of `npm test` went green on a ticket that added nothing | Gates must be able to fail per acceptance criterion (already fixed in the template); the **lead** writes gates, the **worker** never edits them |
| The worker spends its own (expensive-tier) tokens writing REPORT.md, and often stalls right before it | Reports, summaries and briefs are **drone work** by default |
| `--continue` on a big session stalled twice in a row; a fresh 34k session finished in 6 min | Retry ladder: fresh-session-with-brief before anything else |
| The queue never committed; T005's edits mixed with T004's | The daemon records **commit boundaries** per verified task and the director commits from them |
| Reading a 200-line log in the manager's context to decide "resume or restart" costs the most expensive tokens in the system | The manager gets a **digest** (exit reason, last 5 events, gate tail ≤ 40 lines, diff stat) — never the log |
| First daemon run (T006, evening): applying the tier's context cap as a mid-run kill terminated every worker at ~60k context after ten steps — real work on a monorepo sits at 50–70k within minutes | `ctxCap` is a **continuation gate** only (never resume past it); `ctxKill` (≈2×) is the hard mid-run ceiling |
| The lead's review task failed on budget and the ladder escalated *it*, creating `T006.review-2.review-2` | A review never spawns a review: one fresh retry, then it blocks — and blocks its parent, so the director sees where the ladder stopped |
| `minimax-m3` passed the one-word probe, answered `ask` in 17 s, then 404'd on a real run | Probes are necessary, not sufficient: an API error before the first step **demotes the model at run time** and re-routes as a new run |
| Stalls from v1 were recorded under the model label `(default)`, so the stall counter never matched | Legacy `(default)` counts against the tier's default model |
| T008: a drone wrote REPORT.md after run #2; run #3 stalled but was classified "finished" because *a* report existed on disk | A previous run's REPORT.md is archived (`REPORT.run-N.md`) when a new work run starts; only a report written in this run counts |
| T008: the ladder's second step worked — the lead (25k tokens on mimo) diagnosed "stalled in research, never wrote code; ticket is correct; start writing immediately" | The review brief is the cheapest, highest-value token spend in the system; keep it capped and keep it going to the premium tier |

## 2. Architecture

```
                 ┌──────────────────────────── foreman (engine) ─────────────────────────────┐
  you / Claude   │  registry  router  budgeter  scheduler  gates  escalation  briefs  events  │   dashboard
  (director) ───▶│  .foreman/agents/*.md   .foreman/tasks/*.md   .foreman/events.jsonl        │◀── foreman ui
                 └───────┬──────────────────────────────┬───────────────────────────┬─────────┘
                         │ opencode run --agent <name> --model <tier model> --format json      │ ask <agent>
                 ┌───────▼──────────┐   ┌───────────────▼───────────┐   ┌───────────────────▼────┐
                 │ lead (premium)   │   │ coder / tester (standard) │   │ drone / librarian (eco)│
                 │ plan · review    │   │ implement · fix · test    │   │ summarise · report ·   │
                 │ write gates      │   │ under a brief + budget    │   │ chores · retrieval     │
                 └──────────────────┘   └───────────────────────────┘   └────────────────────────┘
                          .opencode/agent/<name>.md  ← generated: model, temperature, permissions, persona
```

### 2.1 Substrate: opencode facts we rely on (verified 2026-08-26, v1.18.15)
- Custom agents are markdown files with frontmatter `description`, `mode`, `model`,
  `temperature`, `permission: {edit, bash, webfetch, websearch}` and a system-prompt body;
  `opencode run --agent <name>` selects one; `--model provider/model` overrides the model.
- `--format json` streams `step_start | text | tool_use | step_finish{tokens,cost} | error`
  with a `sessionID`; `--session <id>` continues; `--dir` scopes the project.
- Models present here: free opencode tier (`muse-spark-1.2`, `nemotron-3-ultra-free`,
  `nemotron-3.5-lightning-free`, `mimo-v2.5-free`, `hy3-free`) and NVIDIA NIM
  (`deepseek-v4-flash`, `llama-3.3-70b`, `llama-3.1-8b`, `gemma-3-4b`, `phi-4-mini`,
  `minimax-m3`, …). Paid providers (Anthropic/OpenAI) plug in through opencode's config.

### 2.2 Hierarchy and roles

| Level | Role | Tier (default) | Does | Never does |
|---|---|---|---|---|
| L0 | **director** | human / Claude session | sets goals, writes or approves tickets, commits | reads raw logs |
| L1 | **lead** | premium | decomposes a ticket into tasks with `kind`, writes acceptance criteria **and gates**, reviews failures from a brief, writes feedback | implements |
| L2 | **coder** | standard | implements one task under a brief and budget | edits gates, widens scope |
| L2 | **tester** | standard | writes tests from criteria; runs gates; reports failures precisely | changes source under test to make tests pass |
| L3 | **drone** | economy | summaries, REPORT.md from logs, renames, formatting, changelog, boilerplate, test scaffolds | design decisions |
| L3 | **librarian** | economy | maintains `knowledge/` facts; answers "where is X" by grep; produces context briefs for others | edits code |

Every agent has a `supervisor`. Escalation goes up one level; delegation goes down. The
director's `supervisor` is nobody: when a lead escalates, the daemon stops and the NOW
panel says so.

### 2.3 Tiers and pricing (`.foreman/foreman.json`)

```json
"tiers": {
  "premium":  { "model": "nvidia/deepseek-ai/deepseek-v4-flash", "inputPerM": 0, "outputPerM": 0, "ctxCap": 90000,  "maxOutPerRun": 12000 },
  "standard": { "model": "opencode/muse-spark-1.2-contributor-free", "inputPerM": 0, "outputPerM": 0, "ctxCap": 55000,  "maxOutPerRun": 30000 },
  "economy":  { "model": "nvidia/meta/llama-3.1-8b-instruct", "inputPerM": 0, "outputPerM": 0, "ctxCap": 24000, "maxOutPerRun": 8000 }
},
"routing": { "plan": "lead", "review": "lead", "implement": "coder", "fix": "coder", "test": "tester",
             "chore": "drone", "summarise": "drone", "report": "drone", "research": "librarian" }
```
Prices are per million tokens in USD; `ctxCap` is the context size beyond which foreman
refuses to continue a session and starts a fresh one from a checkpoint brief; `maxOutPerRun`
is a hard budget the run loop enforces. Pricing defaults to zero (free tiers) and the
dashboard says *estimated* when a model reports no cost.

### 2.4 Task model (a superset of v1 tickets — files stay markdown)

```
---
id: T006.2                # dotted ids are subtasks; parent = T006
title: Write server.test.ts from the acceptance criteria
kind: test                # plan | review | implement | fix | test | chore | summarise | report | research
assignee: tester          # optional; else routing[kind]
parent: T006
depends_on: T006.1
budget: { steps: 60, outTokens: 20000, usd: 0.50, minutes: 40 }
verify:
  - node --test "apps/api/src/**/*.test.ts" 2>&1 | grep -E '^# pass ([9]|[1-9][0-9]+)$'
---
```
State per task lives in `.foreman/runs/<id>/state.json` (runs, sessions, attempts, spend,
gate results, commit boundary). `state.json` at the root shrinks to an index.

### 2.5 Agent model (`.foreman/agents/<name>.md`)
Frontmatter is opencode's plus foreman's:
```
---
description: Implements one task under a brief and a budget.
mode: primary
temperature: 0.2
permission: { edit: allow, bash: allow, webfetch: deny }
role: coder            # foreman
tier: standard         # foreman → model, ctxCap, prices
supervisor: lead       # foreman
kinds: [implement, fix]
concurrency: 1
---
<persona + role protocol>
```
`foreman agents sync` writes `.opencode/agent/<name>.md` (model resolved from the tier) so
opencode enforces model and permissions even if someone runs it by hand.

### 2.6 Sessions, checkpoints and briefs — the context discipline
- Each agent has **persistent sessions** (`.foreman/agents/<name>/sessions.json`: id,
  ctxTokens, spend, lastActive, task). `foreman ask` and task runs reuse a session only
  while `ctxTokens < tier.ctxCap`.
- Past the cap (or after a stall), the engine builds a **checkpoint brief** —
  deterministically, no LLM: task text · last REPORT.md · gate tail (≤ 40 lines) ·
  `git diff --stat` · list of files the run touched · the manager's last feedback. Size-capped
  (default 6k chars). A fresh session starts from that. Optionally a drone compresses it
  further (`summarise` kind) when the brief exceeds the cap.
- **Upward hand-offs are briefs.** A lead reviewing a failure receives the brief, never the
  log. The director receives the digest line the daemon prints.
- **Stable prefix.** Protocol first, then persona, then task — identical bytes across runs
  of the same agent, so provider prompt caches hit.

### 2.7 Router
`route(task)`: `assignee` if set → else `routing[kind]` → agent → `tier.model`
(agent `model` overrides tier). Overrides: `--agent`, `--model`, `--tier`. A task may
declare `tierMin: standard` (never route a design task to economy). The router also
computes the budget: task budget ∩ tier `maxOutPerRun`.

### 2.8 Budgeter (enforced in the run loop, from the event stream)
Per run: `steps`, `outTokens` (sum of `step_finish.tokens.output`), `ctxTokens` (max
`tokens.total`), `usd` (reported cost or price × tokens), `minutes`. Crossing any limit
terminates the worker (SIGTERM, then SIGKILL), records `over-budget`, and enters the
escalation ladder. Spend is written to the task state, the agent state and the event log.

### 2.9 Scheduler (`foreman work`)
```
loop:
  tasks ← load index; ready ← queued ∧ deps verified ∧ parent not blocked ∧ not paused
  for each agent with free concurrency (global cap too):
     pick highest-priority ready task the agent can take (kind ∈ agent.kinds)
     route → run (async child) → on exit: gate → record → ladder
  if nothing ready and nothing running: exit "drained" (or --watch: idle-wait on fs events)
ladder(task):
  attempt 1 failure → same agent, fresh session, brief includes gate tail  (cheap)
  attempt 2 failure → create review subtask for supervisor (kind: review) whose output is FEEDBACK.md;
                      then attempt 3 = same agent, fresh session, brief + FEEDBACK.md
  attempt 3 failure → task.blocked; daemon stops touching it; NOW panel shows the reason
stall/over-budget count as failures. verified ⇒ record commit boundary (files touched) for the director.
```
Parallelism: default global 2, per agent 1; tasks that share paths (from ticket scope
lists) never run concurrently; the daemon holds a lock file so two daemons cannot run.

### 2.10 Events and scale
`.foreman/events.jsonl` is append-only (`at, actor, task, type, data`). The UI tails the
last N lines; `foreman cost` folds it. Rotation at 5 MB (`events.1.jsonl` …). Per-run JSONL
and digests already stream to disk line by line — the daemon's memory is O(running tasks).
Nothing is loaded whole except a task's own state file.

### 2.11 Prompting any agent
`foreman ask <agent> "…" [--fresh] [--file f]` — appends the prompt to the agent's inbox,
runs it in the agent's persistent session (subject to the ctx cap), streams the reply to
`.foreman/agents/<name>/replies/<n>.md` and the events log. The AGENT view in the UI does
the same with a prompt line; the reply streams into the panel. `ask` is how the director
talks to a lead, and how you inspect any drone's reasoning.

### 2.12 Dashboard views (`foreman ui`)
`1` ORG — the hierarchy as a tree: each agent's role, tier, model, phase (live), current
task, session ctx vs cap, spend, concurrency; `2` TASKS — the task tree (tickets → subtasks)
with status, assignee, attempts, budget used; `3` AGENT — the selected agent: what it is
doing (stream), its inbox/replies, prompt line (`p`); `4` COST — spend by tier / agent /
task, budget bars, tokens/min; `5` STREAM — v1's stream/activity/report. The NOW strip
stays on top of every view.

### 2.13 Knowledge without bloat (phase 5)
`knowledge/*.md` (facts, decisions, gotchas) maintained by the librarian; agents get only the
slice returned by a deterministic keyword/grep retrieval over those files and the ticket's
named paths. No agent re-reads the repo to "understand it" when a brief exists.

## 3. Token-economy rules (binding)
1. **Deterministic before generative.** Digests, diffs, test parsing, gates, briefs, cost:
   code. LLM only where judgement is needed.
2. **Expensive tier = judgement only.** Leads plan/review/decide from briefs (≤ 6k chars);
   they do not implement, read logs, or write reports.
3. **Volume goes down-tier.** Implementation to standard; reports, summaries, chores,
   scaffolds to economy.
4. **Every run has a budget** and the engine enforces it; there is no unbudgeted run.
5. **Context caps per tier**; beyond the cap the engine restarts from a brief. No `--continue`
   past the cap, ever.
6. **Retry cheap first**: fresh session → gate tail → lead review → block. Never three blind
   retries.
7. **No LLM polls or waits.** The engine waits; agents run only when there is a ready task.
8. **Stable prompt prefix** for cache hits; the task-specific part comes last.
9. **Spend is visible** per run, task, agent, tier — and alerts at 80 % of a budget.

## 4. Phases

| Phase | Delivers | Proof |
|---|---|---|
| P1 registry + tiers + routing + `ask` | agents on disk, opencode sync, `foreman agents`, `foreman ask lead "…"`, `run` routes by kind/tier with budgets and ctx cap | unit tests for routing/budget/frontmatter; `ask` round-trip against two different models |
| P2 scheduler + ladder | `foreman work` with concurrency, budgets, escalation, lock, commit boundaries | a failing task escalates to the lead and comes back with FEEDBACK.md |
| P3 UI views | ORG / TASKS / AGENT (prompt) / COST | `foreman ui --once --view org` snapshot |
| P4 briefs + checkpoints | deterministic checkpoint brief; drone compression when over cap; reports by drone | a stalled task resumes fresh from a brief and verifies |
| P5 knowledge | librarian + retrieval | a task brief cites only the slices it needs |
| P6 metrics | tokens/min, $/verified task, stall rate per model; `foreman cost --by model` | dashboard COST view shows per-model stall rate |

P1–P3 are implemented in this pass; P4 partially (checkpoint briefs, drone reports);
P5–P6 are follow-ups.

## 5. Acceptance tests for the engine itself (node:test, no network)
- frontmatter parses opencode + foreman fields, nested `permission`/`budget` objects.
- `route()` picks assignee > routing[kind] > default, honours `tierMin` and overrides.
- budget accounting from a fixture JSONL: steps/out/ctx/usd computed; over-budget detected
  at the right event.
- checkpoint brief is capped and contains task, gate tail, diff stat.
- scheduler picks ready tasks by deps/parent/concurrency; ladder transitions attempts 1→2→3
  and creates the review subtask with the right assignee.
- events log rotates at the size limit.
