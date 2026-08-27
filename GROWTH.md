# Growth checklist — making foreman famous

Follow the trending mechanic: **80+ stars in 24h beats 300 over a month**. Compress launches into one day.

## 0. Ship the page people land on

- [x] README: one-line value prop above fold, badges, 15s quickstart, demo placeholder
- [x] `foreman --version`, `foreman doctor`, `foreman init --sample`
- [x] npm package `@mastaan/foreman` publish-ready, CI green, LICENSE, topics
- [ ] Replace placeholder with real `docs/demo.gif` via VHS (`vhs docs/demo.tape`)
- [ ] `npm publish --access public` (requires `npm login`)
- [ ] Verify `npx @mastaan/foreman --version` works from fresh machine

## 1. Distribution (next 48h)

- [ ] `npm publish --access public` → badge should resolve
- [ ] `gh release create v0.3.0 --generate-notes` (creates release, enables star-history)
- [ ] Add to awesome lists (PRs, one per list):
  - `sindresorhus/awesome` (if eligible) · `awesome-cli` · `awesome-nodejs`
  - `vinta/awesome-python` not relevant · `awesomes/awesome-agent-cli` (via `https://github.com/Ariestar/awesome-agent-cli`)
  - `awesome-mcp-servers` if you add an MCP wrapper (`foreman mcp`)
- [ ] Homebrew: `brew tap mastaan66/foreman` is 10 lines — `goreleaser` or `npm` tap

## 2. Launch day — compress into Tuesday-Thursday 8-10am ET

Coordinate all channels to fire the same day so GitHub Trending counts a burst.

| Channel | Post | Timing |
|---|---|---|
| Hacker News | `Show HN: Foreman — multi-model orchestration for AI coding agents` + demo.gif + one-paragraph why tickets > prompts | 08:30 ET Tue-Thu |
| Reddit | `r/programming`, `r/commandline`, `r/node`, `r/artificial`, `r/selfhosted` — read self-promo rules, post as "I built" | same morning, 1h after HN |
| X / LinkedIn | 30s clip from demo.gif + thread: "director writes ticket → lead plans → coder implements → gates" | same morning |
| Dev.to / Hashnode | `How we cut token spend 3× by never letting cheap models plan` — deep dive into WORKFORCE_PLAN.md §3 | publish day before, link on launch day |
| Product Hunt | If you want non-dev reach | launch day 00:01 PT |

Use `star-history.com/#mastaan66/foreman` and `Insights → Traffic → Referring sites` to see what sent stars.

## 3. Content that keeps working (weekly cadence)

- Benchmark: `Foreman vs queue-vs-work vs bare opencode — time to verified ticket, tokens, stall rate`
- Template gallery: `foreman init` + 3 sample tickets (API scaffold, test, chore) that verify in <5m on free tier
- Integration: GitHub Action `mastaan66/foreman-action` (one-line: `foreman run T001 --verify`)
- Case study: take a real repo (e.g., `spashta`), show ticket DAG before/after

## 4. Community compounding

- `CONTRIBUTING.md` + `good first issue` label → contributors become promoters
- Respond to every issue/PR in <24h
- Discord: hang in `opencode`, `charmbracelet`, `Vercel AI SDK` servers — help before pitching

## 5. Measure

- `gh api repos/mastaan66/foreman --jq .stargazers_count`
- `npm view @mastaan/foreman downloads --json` (after publish)
- `star-history.com` curve — spikes should map 1:1 to launch events
- Ask: "stars per hour of effort" — double down on winners

## One-liner publish

```bash
npm login
npm publish --access public
gh release create v0.3.0 --generate-notes --title "v0.3.0 — doctor + init wizard + budget seam"
vhs docs/demo.tape  # then git add docs/demo.gif && git commit -m "docs: demo gif" && git push
```
