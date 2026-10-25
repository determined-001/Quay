# Contributing to Stellar Checkout

Thanks for your interest in contributing! Stellar Checkout is an open-source, non-custodial merchant checkout for the Stellar anchor network — the inbound counterpart to the Stellar Disbursement Platform. Please read this guide before opening a pull request.

---

## Code of Conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## First PR Walkthrough

Welcome! If you are looking for your first contribution:

1. **Find a starter issue**: browse the open issues labelled [`good-first-issue` or `good first issue`](https://github.com/determined-001/Quay/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22%2Cgood-first-issue) (both spellings exist; see [`.github/labels.yml`](.github/labels.yml)). The label query is the source of truth: the list changes as issues are closed, so this guide does not name individual issues.
2. **Comment on the Issue**: Express interest so maintainers can assign it to you.
3. **Fork & Branch**: Fork the repo and create a descriptive branch from `dev`, the default branch:
   ```bash
   git checkout dev && git pull
   git checkout -b feature/issue-8.7-qr-copy-toast
   ```
4. **Make Granular Commits**: Write clean code and make regular, logical commits using conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`). **Do not squash your commits** into a single blob — commit history and velocity are legible and valuable to reviewers (see "Stop squashing" under "5. Distribution + SCF packaging" in [`MAINTAINER.md`](./MAINTAINER.md)).
5. **Verify Locally**: Run the local check suite (see below).
6. **Submit PR**: Open your Pull Request referencing the GitHub issue number (e.g. `Closes #123`; backlog ids such as `8.7` are not GitHub references and will not link or close anything). Assigned maintainers will review within our **48-hour Review SLA**.

---

## Issue Label Taxonomy & Triage SLA

All issues carry labels from three required categories:
- **`area:*`**: `area:core`, `area:stellar`, `area:offramp`, `area:api`, `area:web`, `area:auth`, `area:distribution`, `area:ops`
- **`type:*`**: `type:bug`, `type:feature`, `type:docs`, `type:test`, `type:refactor`, `type:perf`, `type:security`, `type:dx`, `type:ops`
- **`complexity:*`**: `complexity:trivial` (100 points), `complexity:medium` (150), `complexity:high` (200)

The full set lives in [`.github/labels.yml`](.github/labels.yml), which is the
authoritative source. Labels are applied from it; keep it in step when adding a
new area, type or complexity.

### SLAs & Codeowners
- **Triage Cadence**: Every new issue is triaged and labeled within **48 hours** (see [TRIAGE.md](docs/TRIAGE.md)).
- **Review SLA**: Assigned [.github/CODEOWNERS](.github/CODEOWNERS) provide initial PR feedback within **48 hours** (business days).
- **Stale Policy**: Maintainers comment on issues inactive for 14 days and close them after 30 days of inactivity. This is a manual practice; no bot enforces it (see [TRIAGE.md](docs/TRIAGE.md#stale-issue-policy)).

---

## Project Layout

```
packages/
  core/      Domain brain — entities, status machine, money math, SEP-7 builder,
             the pure payment matcher, port interfaces, zod schemas.
  stellar/   Stellar adapter — SEP-7 rail + Horizon polling watcher.
  offramp/   Off-ramp adapter — MockAnchorOffRamp & TestAnchorOffRamp (seller_initiated).
apps/
  api/       Hono API + Drizzle (libSQL) + the ledger-watching worker.
  web/       Next.js seller dashboard + buyer checkout page + widget.js.
```

The domain (`packages/core`) never imports a chain SDK. New chain or anchor
behaviour belongs behind a port (`RailPort`, `WatcherPort`, `OffRampPort`), not
in the domain. Keep that boundary intact — CI enforces it (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)), so a violation fails the build.

## Prerequisites

- Node 22 (what CI and the API's Docker image run)
- pnpm 9 (`packageManager` is pinned in `package.json`)

---

## Setup

```bash
pnpm install
cp .env.example .env
```

Optionally, enable the local secret-scanning pre-commit hook (mirrors CI's
gitleaks step, run against staged changes only - see [SECURITY.md](./SECURITY.md#dependency-and-secret-scanning-issue-85)):

```bash
git config core.hooksPath .githooks
```

## Local development

```bash
# API + ledger watcher  →  http://localhost:8787
pnpm --filter @checkout/api dev

# Web dashboard + checkout  →  http://localhost:3000
pnpm --filter @checkout/web dev
```

---

## Testing cash-out against testanchor

`OFFRAMP=mock` (the default in `.env.example`) is enough for most work, but it
is a simulation. Use the real sandbox, `testanchor.stellar.org`, whenever you
touch the off-ramp, KYC or anything the dashboard does between "Cash out" and
"settled".

| | `OFFRAMP=mock` | `OFFRAMP=testanchor` |
|---|---|---|
| Anchor login (SEP-10) and "Connect to anchor" | none (no anchor, nothing to sign in to) | the seller's wallet signs the anchor's challenge |
| Identity verification (SEP-12) | not required | required; the cash-out button waits for `ACCEPTED` |
| Quote | built-in illustrative rates (NGN, KES, GHS) | SEP-38 quote from the anchor (USD or CAD only) |
| Payout | the job settles itself after about 8 seconds and pays nothing | a real SEP-6 withdrawal; the anchor names a deposit account and your wallet sends USDC to it |
| Transfer step ("Send with my wallet") | never shown | shown once the anchor names its deposit account |
| Anchor limits, withdraw types, errors, slow or flaky anchor | not exercised | exercised |

Mock settles in a few seconds without the anchor, so it hides everything that
only the real anchor does: the seller-signed login, KYC lifecycle, the transfer
the seller must send, withdraw-type selection and limits. Most anchor bugs so
far showed up only against the sandbox.

### 1. Environment

Start from `cp .env.example .env`, then set the values below (the names are the
ones in [`.env.example`](.env.example) and `apps/api/src/env.ts`). The API reads
the repo-root `.env`. The Next.js web app does not: put the `NEXT_PUBLIC_*`
lines in `apps/web/.env.local` (or export them in the shell that runs the web
dev server).

```bash
# API (repo-root .env)
OFFRAMP=testanchor
OFFRAMP_TYPE=bank_account          # testanchor lists two USDC withdrawal types ("cash" and
                                   # "bank_account"); the adapter will not guess between them
KYC_ENCRYPTION_KEY=<64 hex chars>  # required for testanchor; see the comment above it in
                                   # .env.example for the generator command
COOKIE_SECURE=false                # plain-http local dev: a Secure cookie is otherwise never sent

# Web (apps/web/.env.local)
NEXT_PUBLIC_OFFRAMP_MODE=testanchor
NEXT_PUBLIC_OFFRAMP_CURRENCY=USD   # testanchor only quotes USDC against USD and CAD
NEXT_PUBLIC_ENABLE_WALLET_PAY=true # optional: adds a "pay with wallet" button on the checkout page
```

Leave `STELLAR_NETWORK=testnet` and `NEXT_PUBLIC_STELLAR_NETWORK=testnet`
(they must match). `HOME_DOMAIN` can stay unset locally; it falls back to
`localhost:8787`. `DEFAULT_SELLER_SECRET` is not used: you sign in with your own
wallet, and the server never signs for you. Restart both dev servers after
changing env files; `NEXT_PUBLIC_*` values are inlined when Next compiles, so a
running web server will not pick them up.

### 2. Wallet setup

You need two testnet accounts: the **seller** (signs in to the dashboard and
cashes out) and a **buyer** (pays the link). Two accounts in one Freighter
wallet is fine.

1. Install [Freighter](https://www.freighter.app/) and create or import two accounts.
2. In Freighter, switch the network to **Testnet** (Freighter's network picker).
3. Fund each account with Friendbot, which gives it test XLM:
   `https://friendbot.stellar.org/?addr=G...` (your address after `addr=`).
4. Add a USDC trustline to each account for the testnet issuer in
   `USDC_ISSUER_TESTNET`, `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`:
   in Freighter use **Manage assets** and add `USDC` with that issuer, or build a
   Change Trust operation in [Stellar Laboratory](https://lab.stellar.org). The
   seller needs it too: creating a link fails the trustline check without it.
5. Get testnet USDC into the **buyer** account (the seller only needs the
   trustline, since the buyer's payment is what funds it). There is no faucet
   this repo can promise. Try Circle's faucet at
   [faucet.circle.com](https://faucet.circle.com) if it lists Stellar testnet, and
   confirm the USDC issuer it uses matches the one above (a different issuer is a
   different asset and will not work here). If it does not, testanchor itself lists USDC for deposit on SEP-6 (SEPA or SWIFT,
   1 to 10 USDC, authentication required), so an anchor-side deposit to the
   buyer account from a SEP-6 client such as the
   [Stellar Demo Wallet](https://demo-wallet.stellar.org) is the fallback. Quay
   itself has no deposit screen.

testanchor limits each withdrawal to **1 to 10 USDC** (its `/sep6/info`), so keep
the test link in that range.

### 3. Walkthrough

1. `pnpm install`, `pnpm --filter @checkout/api dev` and `pnpm --filter @checkout/web dev`.
2. Open http://localhost:3000, choose **Connect wallet** and sign in with the
   **seller** account (the signature proves you own the address; it is never
   submitted).
3. Create a link for **5 USDC**.
4. Open the checkout page of that link and pay it from the **buyer** account with
   the memo shown (or use the wallet button if you set `NEXT_PUBLIC_ENABLE_WALLET_PAY=true`).
   The watcher confirms it and the link becomes `paid`.
5. In the dashboard's identity panel choose **Connect to** the anchor and approve
   the signature in Freighter. This is a SEP-10 login for the seller account.
6. **Start verification** (SEP-12), fill the fields the anchor asks for, and wait
   for `ACCEPTED`. The cash-out button only appears after that.
7. On the paid link choose **Cash out**, review the quote, and fill the payout
   fields the anchor asks for.
8. When the anchor names its deposit account, the modal shows **Send with my
   wallet** with the amount, destination and memo. Approve the payment in
   Freighter. The link moves `offramp_pending` then `offramp_settled`.

If a step fails, `docs/RUNBOOK.md` ("Anchor incidents", "Stuck `offramp_pending`
job") explains what each state means.

### 4. The live test suite

The offramp package has tests that call the real sandbox. They are skipped
unless you opt in, because testanchor is a shared external service:

```bash
RUN_LIVE_ANCHOR_TESTS=1 OFFRAMP_TYPE=bank_account pnpm --filter @checkout/offramp test
```

`OFFRAMP_TYPE` defaults to `bank_account` in the suite. `SELLER_SECRET_KEY` is
optional: set it to a testnet secret (`S...`) to reuse one account, otherwise a
random keypair is used. Never use a mainnet key. The nightly
[`anchor-probe.yml`](.github/workflows/anchor-probe.yml) workflow runs this same
command with `OFFRAMP_TYPE=bank_account`.

---

## Before You Open a PR

Run these from the repo root. They are the checks in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) that you can run without
a browser or Docker; CI runs a few more (the Playwright `pnpm e2e` job, a
dependency audit, a client-bundle check and a Docker build), so treat this as
"at least these" and read the workflow if a PR fails there. The required checks
on `dev` and `main` are `build`, `docker` and `secret-scan`:

```bash
pnpm typecheck                    # all packages
pnpm test                         # unit tests
pnpm test:coverage                # unit tests with coverage thresholds
pnpm test:scripts                 # tests for the repo's own scripts (db-backup/db-restore)
pnpm build                        # builds the web app
pnpm docs:check-status-diagram    # docs/generated/status-diagram.mmd matches status.ts
pnpm docs:check-domain-boundary   # packages/core imports no chain SDK
pnpm check:no-server-signing      # no server-held key signs a payment or anchor challenge
pnpm docs:check-env-docs          # every env var apps/api reads is in .env.example
pnpm db:check                     # schema and migrations have not drifted
```

All of them must pass. If you change domain logic in `packages/core`, add or update
the corresponding unit tests (`packages/core/test/`). New behaviour in the API,
worker, or adapters should come with tests where practical. If you change
`LINK_STATUSES`/`TRANSITIONS` in `packages/core/src/domain/status.ts`, run
`pnpm docs:status-diagram` and update the pasted copy in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to match.

---

## Pull Request Guidelines

- Branch from `dev` and open the PR against `dev`; keep PRs focused on a single concern.
  `main` is what mainnet deploys from and only moves when a maintainer promotes `dev`
  (see `docs/RUNBOOK.md` "Promotion: dev to main").
- Write a clear description of **what** changed and **why**. Link any related issue.
- **Do not squash commits**: `dev` and `main` require linear history, so a PR is merged by **rebase**, which keeps your granular commits. Maintainers do not squash-merge, and merge commits are blocked by the linear-history rule. Commit velocity and history demonstrate development progression.
- Match the surrounding code style — comments explain intent, money is compared in integer stroops (never floats), and illegal status transitions must stay rejected.
- Do not flip the off-ramp from `seller_initiated` to `inline`. That mode has legal (money-transmission / custody) implications and is out of scope for a PR.

---

## Changelog and releases

[`CHANGELOG.md`](./CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
It is the one place an operator upgrading a self-hosted deploy, or an integrator
on the API, looks to see what changed, what broke and what to do about it.

**Every PR that changes behaviour an operator, integrator or merchant can see
adds a line under `## [Unreleased]`**, in the matching group (`Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). That covers API
routes, request or response fields, error codes, env vars, migrations, webhook
events and dashboard flows. Pure refactors, tests and internal docs do not need
one. Rules of thumb:

- A breaking change goes under `Breaking changes` at the top of `Unreleased`,
  says what to do about it, and uses `!` in the commit type (`fix(offramp)!: ...`).
- A new, renamed or newly required env var goes under `New or changed
  environment variables`, with its default, and in `.env.example`.
- Write for the reader, not the diff: say what changed for them, not which file.

**Cutting a release** (a maintainer, when promoting `dev` to `main`; see
`docs/RUNBOOK.md` "Promotion: dev to main"):

1. In the `dev` to `main` PR, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`
   (today's date), add a fresh empty `## [Unreleased]` above it, and update the
   link references at the bottom. Choose the version with
   [Semver](https://semver.org/): breaking change is major (while below 1.0, minor),
   new feature is minor, fixes only is patch. Bump `version` in `package.json` to match.
2. Merge the PR, then tag the merge commit on `main`: `git tag -a vX.Y.Z -m "vX.Y.Z"`
   and `git push origin vX.Y.Z`.
3. Create a GitHub release for the tag (`gh release create vX.Y.Z`) with that
   version's section from `CHANGELOG.md` as the notes.

---

## Commit Messages

Use short, conventional-style prefixes where they fit (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). Keep the subject line under ~72 characters.

---

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for responsible disclosure.
