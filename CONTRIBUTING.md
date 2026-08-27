# Contributing to Foreman

## Quick start

```bash
git clone https://github.com/mastaan66/foreman
cd foreman
npm test
npm run check
foreman --help
foreman doctor
```

Requires Node >=22 and [opencode](https://opencode.ai) on PATH.

## Development

- Zero dependencies. Pure Node ESM.
- Tests: `node --test test/*.test.mjs`
- Lint: `node --check lib.mjs foreman.mjs ui.mjs`
- The engine never trusts a worker's word — gates are run by foreman itself (`foreman verify`).

## Pull requests

1. Add a ticket in `.foreman/tickets/` if the change is non-trivial.
2. Keep the CLI surface small: one interface, deep implementation.
3. Update `CHANGELOG.md` under `Unreleased`.

## Releasing

`npm version patch|minor|major && npm publish && git push --follow-tags`
