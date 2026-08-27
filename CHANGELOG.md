# Changelog

All notable changes to foreman.

## [Unreleased]

### Added
- `GROWTH.md` launch checklist, `docs/demo.tape` VHS script

## [0.3.0] - 2026-08-27

### Added
- `foreman --version` / `-v` / `version` (reads package.json)
- `foreman doctor` — checks Node ≥22, opencode, workspace, models, git
- `foreman init` wizard: shows tiers, next steps, 15s quick start, `--sample` flag
- Scoped npm package `@mastaan/foreman` with `files`, `keywords`, `publishConfig`, `prepublishOnly`
- CI matrix Node 22/24, `LICENSE`, `CONTRIBUTING.md`, GitHub topics
- README overhaul: badges, demo placeholder, 15s quickstart, tiers table, command reference
- `docs/demo.tape` for VHS

### Changed
- `lib.mjs`: new deep seam `checkBudget(run,budget,tierSpec) → {over,warn,usd}` — single budget interface
- `foreman.mjs`: `executeRun` delegates to `checkBudget`; locality improved
- Tests: 10 → 12 (budget seam)

### Fixed
- `.gitignore` now ignores `.foreman/`, `.opencode/`, `dist/`, `*.log`

## [0.2.0] - 2026-08-26

- Workforce hierarchy: director → lead → coder/tester → drone/librarian
- Tiers, budgets, context caps, escalation ladder
- Dashboard `foreman ui` with STREAM / ORG / TASKS / COST views
- `foreman models --probe`, `ask`, `work` daemon

## [0.1.0] - 2026-08-24

- Initial single-worker engine: tickets, gates, JSONL streaming, dashboard
