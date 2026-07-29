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
pnpm test                         # unit tests
pnpm build                        # builds the web app
pnpm e2e                          # Playwright: full payment loop against a local stack, no network access
pnpm docs:check-status-diagram    # docs/generated/status-diagram.mmd matches status.ts
pnpm docs:check-domain-boundary   # packages/core imports no chain SDK
```

All six must pass. If you change domain logic in `packages/core`, add or update
the corresponding unit tests (`packages/core/test/`). New behaviour in the API,
worker, or adapters should come with tests where practical. If you change
`LINK_STATUSES`/`TRANSITIONS` in `packages/core/src/domain/status.ts`, run
`pnpm docs:status-diagram` and update the pasted copy in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to match.

## End-to-end tests (issue 5.7)

`pnpm e2e` (`apps/web/e2e/local/`) runs a Playwright suite against a
locally-composed stack (API + web + a throwaway local DB) that CI also runs
on every PR with no network access to Stellar/anchor infra - it settles
payments through a test-only API route
(`apps/api/src/routes/test-only.ts`, only mounted under `E2E_TEST_MODE=1`,
refused under `NODE_ENV=production`) instead of a real on-chain payment.

`pnpm sweep` additionally runs `apps/web/e2e/live/` against the real deployed
demo (`pnpm --filter @checkout/web e2e:live`) - the pre-entry ritual from
`MAINTAINER.md`'s standing rule, as one command. This mutates the live
deployment (creates a small throwaway link, same trade-off as
`scripts/uptime-check.mjs`'s synthetic check) and is not part of the PR
checklist above - it also runs nightly and on demand
(`.github/workflows/e2e-live.yml`).

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
