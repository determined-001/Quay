# Contributing to Stellar Checkout

Thanks for your interest in contributing. This project is a non-custodial
stablecoin checkout on Stellar with a swappable off-ramp seam. Please read this
guide before opening a pull request.

## Code of conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Project layout

```
packages/
  core/      Domain brain — entities, status machine, money math, SEP-7 builder,
             the pure payment matcher, port interfaces, zod schemas.
  stellar/   Stellar adapter — SEP-7 rail + Horizon polling watcher.
  offramp/   Off-ramp adapter — MockAnchorOffRamp (seller_initiated). *** mock ***
apps/
  api/       Hono API + Drizzle (libSQL) + the ledger-watching worker.
  web/       Next.js seller dashboard + buyer checkout page.
```

The domain (`packages/core`) never imports a chain SDK. New chain or anchor
behaviour belongs behind a port (`RailPort`, `WatcherPort`, `OffRampPort`), not
in the domain. Keep that boundary intact — CI enforces it (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)), so a violation fails the build.

## Prerequisites

- Node 20+
- pnpm 9 (`packageManager` is pinned in `package.json`)

## Setup

```bash
pnpm install
cp .env.example .env
```

## Local development

```bash
# API + ledger watcher  →  http://localhost:8787
pnpm --filter @checkout/api dev

# Web dashboard + checkout  →  http://localhost:3000
pnpm --filter @checkout/web dev
```

## Before you open a PR

Run the full check suite from the repo root — this is exactly what CI runs:

```bash
pnpm typecheck                    # all packages
pnpm test                         # unit tests (with coverage — see below)
pnpm build                        # builds the web app
pnpm docs:check-status-diagram    # docs/generated/status-diagram.mmd matches status.ts
pnpm docs:check-domain-boundary   # packages/core imports no chain SDK
```

All five must pass. If you change domain logic in `packages/core`, add or update
the corresponding unit tests (`packages/core/test/`). New behaviour in the API,
worker, or adapters should come with tests where practical. If you change
`LINK_STATUSES`/`TRANSITIONS` in `packages/core/src/domain/status.ts`, run
`pnpm docs:status-diagram` and update the pasted copy in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to match.

## Coverage (issue 8.1)

`pnpm test` runs every package's tests with coverage (`@vitest/coverage-v8`)
and fails if a package drops below its own threshold in
[`coverage-thresholds.json`](./coverage-thresholds.json):
`packages/core` ≥90%, `packages/stellar`/`packages/offramp` ≥70%. `apps/api`
has no enforced threshold yet — gated on issue 4.10 (an integration test
suite for the API) landing first, though its coverage is still measured and
reported.

- **Ratchet-only**: thresholds in `coverage-thresholds.json` may only go up,
  never down — `pnpm coverage:check-ratchet` (run in CI on every PR) diffs
  the file against the base branch and fails if any number decreased,
  including a threshold flipping to `null` (enforcement removed). If your
  change genuinely needs a lower number (rare — usually means new code that
  isn't tested yet), that's a maintainer call, not something to fix by
  editing the number back down yourself.
- **Raising a threshold**: once a package's coverage has genuinely improved
  and stayed there for a while, bump its number(s) in
  `coverage-thresholds.json` in the same PR (or a follow-up) that earned it -
  don't let real coverage silently drift above an outdated floor.
- CI uploads the full per-package HTML/JSON coverage report as a workflow
  artifact and posts a workspace-wide summary as a sticky PR comment
  (`pnpm coverage:aggregate` generates both).
- Excluded from every package's coverage: test files, config files, and
  explicitly-listed type-only/generated modules (pure re-export barrels,
  interface-only files, Drizzle table definitions) - see each package's
  `vitest.config.ts` for the exact list.

## Pull request guidelines

- Branch from `main`; keep PRs focused on a single concern.
- Write a clear description of **what** changed and **why**. Link any related issue.
- Match the surrounding code style — comments explain intent, money is compared in
  integer stroops (never floats), and illegal status transitions must stay rejected.
- Do not flip the off-ramp from `seller_initiated` to `inline`. That mode has legal
  (money-transmission / custody) implications and is out of scope for a PR.

## Commit messages

Use short, conventional-style prefixes where they fit (`feat:`, `fix:`, `docs:`,
`chore:`, `test:`). Keep the subject line under ~72 characters.

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for responsible disclosure.
