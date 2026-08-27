---
id: {{id}}
title: {{title}}
created: {{date}}
status: queued
depends_on:
verify:
  - npm test
  # A gate must be able to FAIL on every acceptance criterion below. `npm test` alone
  # passes when the worker adds nothing. Add criterion-specific checks, e.g.:
  #   - test -f src/new-thing.ts
  #   - node --test "src/new-thing/**/*.test.ts" 2>&1 | grep -E '^# pass ([9]|[1-9][0-9]+)$'
  #   - "! grep -rn 'forbiddenCall' src --include=*.ts --exclude=*.test.ts"
timeout: 60
---

# {{title}}

## Goal
One paragraph: what exists when this ticket is done, and why it matters.

## Context
What the worker must read first. Paths, prior decisions, constraints.

## Requirements
1. Numbered, testable statements.

## Acceptance criteria
- [ ] Each one is verifiable by a command or by opening a file.

## Out of scope
- Things the worker must not touch.

## Notes
Hints, gotchas, preferred approach.
