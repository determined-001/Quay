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
in the domain. Keep that boundary intact.

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
pnpm typecheck   # all packages
pnpm test        # unit tests
pnpm build       # builds the web app
```

All three must pass. If you change domain logic in `packages/core`, add or update
the corresponding unit tests (`packages/core/test/`). New behaviour in the API,
worker, or adapters should come with tests where practical.

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
