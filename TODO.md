# TODO

Outstanding work, ordered by what blocks what. `MAINTAINER.md` is the older
Drips-wave plan and is kept separate — this file tracks the mainnet cutover and
the maintenance items that came out of it.

Last updated: 2026-08-21.

---

## Done (2026-08-21)

- [x] **Stopped the automated PRs.** They came from Dependabot
      (`.github/dependabot.yml`), not from a workflow. Now monthly,
      security-updates only, with `ignore` rules suppressing routine version
      bumps. CVE PRs still arrive, because CI has a hard `pnpm audit` gate.
- [x] **Fixed CI.** The `pnpm audit --audit-level=high` step failed on
      `GHSA-2v37-7h3g-55p8` (`nanoid <3.3.18`, pulled in transitively via
      `postcss` ← `next`/`vite`). Fixed with a `pnpm.overrides` pin to
      `^3.3.18` — deliberately range-pinned to the 3.x line, because a bare
      `>=3.3.18` resolves to nanoid 6 under postcss.
- [x] `OFFRAMP=anchor` mode — the SEP-6 adapter pointed at an operator-supplied
      production anchor via `ANCHOR_URL` / `ANCHOR_HOME_DOMAIN` / `OFFRAMP_TYPE`.
- [x] Public-network boot guards in `apps/api/src/env.ts`, with tests in
      `apps/api/test/env-mainnet-guards.test.ts`.
- [x] `.env.public.example`, `render.mainnet.yaml`, `docs/MAINNET.md`,
      `pnpm secrets:mainnet`.

---

## 1. Blocking — mainnet cannot proceed without these

None of these are code. See `docs/MAINNET.md` for the full runbook.

- [ ] ~~**Choose a production anchor**~~ — **deferred.** No longer blocking:
      `OFFRAMP=none` ships payments without it (see §2). Still required before
      cash-out to fiat exists. This gates
      everything else in the off-ramp path. Production anchors do not serve
      anonymous traffic. Confirm it quotes USDC against your target currency
      over SEP-38 and settles to the rail your sellers actually use.
- [ ] **Get compliance advice** for the jurisdictions you operate in. Much
      reduced under `OFFRAMP=none` — no fiat conversion, no identity data, and
      funds never touch an account this service controls — but "reduced" is not
      "none", and this file is not advice.
- [ ] **Verify Circle's pubnet USDC issuer** against Circle's own published
      address before taking a single real payment. Minting an asset with the
      code `USDC` from a different issuer is trivial and it is worth nothing.
- [ ] **Generate and fund real keys.** `pnpm secrets:mainnet`, then fund the
      seller wallet with XLM *and* add a USDC trustline — until the trustline
      exists the account cannot receive USDC at all. Under `OFFRAMP=none` skip
      `DEFAULT_SELLER_SECRET` and `KYC_ENCRYPTION_KEY` entirely.
- [ ] **Provision a real database.** `file:./local.db` is lost on every
      redeploy, taking the payment ledger with it.
- [ ] **Set `NEXT_PUBLIC_STELLAR_NETWORK=public` on the web deployment.** Easy
      to miss and it fails opaquely — the browser signs with the passphrase this
      selects, so leaving it unset means every wallet signature is built for
      testnet and rejected, with no error naming the cause.

---

## 2. Payments-only mainnet — implemented, decision made

**Decided 2026-08-21: ship payments-only first.** `OFFRAMP=none` is implemented
and tested. Buyers pay the seller's wallet directly; the seller moves their own
funds. See `docs/MAINNET.md` Phase 0.

- [x] `DisabledOffRamp` (`packages/offramp/src/disabled.ts`) — throws a typed
      `OffRampDisabledError` on every method rather than deleting the working,
      tested off-ramp code.
- [x] `OFFRAMP=none` allowed on public in `env.ts`; `KYC_ENCRYPTION_KEY` and
      the `ANCHOR_*` variables no longer required in that mode.
- [x] Cash-out routes answer **501**, not 500 — and deliberately not 502, which
      is what an anchor *outage* returns and which clients retry.
- [x] Dashboard hides the cash-out button, KYC panel and cash-out modal.
- [x] Cash-out poller and anchor probe never start.
- [x] `offramp_*` statuses left in the machine, unreachable — re-enabling
      cash-out later is a config change, not a migration.

Remaining for this path:

- [ ] Set `OFFRAMP=none` and `NEXT_PUBLIC_OFFRAMP_MODE=none` in the mainnet
      deployment, and leave `DEFAULT_SELLER_SECRET` unset.
- [ ] Add an `OFFRAMP=none` variant to `render.mainnet.yaml`, or note in the
      dashboard which variables to omit.
- [ ] Decide how the dashboard should explain that sellers cash out themselves —
      right now the button simply is not there, with no copy replacing it.

## 3. Known gaps — not blockers, each has a real production cost

- [ ] **`REDIS_URL` unset.** Rate-limit counters live in an in-process `Map`, so
      N instances allow N times the configured limit. Set before scaling past
      one instance.
- [ ] **`.github/workflows/anchor-probe.yml` probes `testanchor.stellar.org`**
      and auto-files a GitHub issue when that sandbox is down. On a mainnet
      project it watches the wrong host — repoint it at your anchor or disable
      it. (It is also a second source of automated repo noise, alongside the
      Dependabot PRs.)
- [ ] **`AnchorOffRamp` (SEP-24, `packages/offramp/src/anchor.ts`) must stay
      unexported** until its quotes and jobs are persisted through
      `OffRampStateRepository`. It keeps them in in-process `Map`s, so a restart
      mid-withdrawal loses `sendTxHash` — money-adjacent state that does not
      survive a redeploy has no business on pubnet. Four money bugs in it were
      fixed on 2026-08-21 (wrong network passphrase, network inferred from a
      substring that pubnet does not contain, send leg hardcoded to XLM
      regardless of the asset withdrawn, and a fabricated placeholder job that
      could re-send a payment); the state-durability blocker remains.
- [ ] **`scripts/demo-seed.ts` / `demo-reset.ts` are testnet-only** — they
      hardcode `Networks.TESTNET` and friendbot. They also cannot currently
      resolve `@stellar/stellar-sdk` from the repo root under pnpm's strict
      `node_modules`, so `pnpm demo:seed` fails. Either move them under
      `apps/api/scripts/` (as `gen-mainnet-secrets.mjs` was) or add the SDK to
      the root manifest.
- [ ] **`db-backup.yml` points at the testnet database.** Repoint before relying
      on it for mainnet.
- [ ] **Dependabot PR #148** is still open — a version-bump group PR that the
      new config would no longer create. Close it or merge it.

---

## 4. Verification before announcing

The full list is in `docs/MAINNET.md` (Phase 5). The two that matter most:

- [ ] A **small real payment** moves a link to `paid`.
- [ ] If the off-ramp is enabled: a **small real cash-out** reaches `settled`
      and the money actually arrives — before anyone else uses the service.
