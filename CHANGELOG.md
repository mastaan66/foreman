# Changelog

All notable changes to foreman.

## [Unreleased]

### Added
- `foreman --version` / `-v`
- `foreman doctor` — checks Node, opencode, models, workspace
- LICENSE, CONTRIBUTING, CI

## [0.2.0] - 2026-08-26

- Workforce hierarchy: director → lead → coder/tester → drone/librarian
- Tiers, budgets, context caps, escalation ladder
- Dashboard `foreman ui` with STREAM / ORG / TASKS / COST views
- `foreman models --probe`, `ask`, `work` daemon

## [0.1.0] - 2026-08-24

- Initial single-worker engine: tickets, gates, JSONL streaming, dashboard
