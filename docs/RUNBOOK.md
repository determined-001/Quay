# Runbook

Operational procedures for the Quay API (deploy target: Render, see
`render.yaml`; database: Turso/libSQL, external). Written for issue 8.6.

## Honest RPO/RTO

- **RPO (Recovery Point Objective): up to 24 hours.** Backups run on a
  nightly schedule (`.github/workflows/db-backup.yml`, 03:17 UTC). This is
  **not** continuous protection - a failure right before the next scheduled
  backup loses up to a full day of payment records, off-ramp job state, and
  (once issue 3.4 ships) KYC data. If that window is unacceptable for a given
  deployment, increase the backup frequency (the cron schedule and
  `pnpm db:backup` support running more often) rather than assume this
  document promises something it doesn't.
- **RTO (Recovery Time Objective): not independently measured against
  production data volumes.** The restore procedure below was exercised
  end-to-end against a scratch database with a handful of rows per table
  (see "Restore drill log") - the wall-clock time for that was well under a
  second, but that number does **not** extrapolate to a production-sized
  Turso database. Time the real restore path (`pnpm db:restore`) against a
  representative data volume before quoting an RTO to anyone relying on it.

## Required environment variables

`.env.example` documents every variable this service reads. This table is the
narrower question an operator actually asks at deploy time: **which ones will
break production if they are missing?** Everything not listed here has a safe
default.

| Variable | Required when | What breaks without it |
|---|---|---|
| `DATABASE_URL` · `DATABASE_AUTH_TOKEN` | always (prod) | No persistence; falls back to a local SQLite file inside the container, which is destroyed on every deploy |
| `KYC_ENCRYPTION_KEY` | `OFFRAMP=testanchor` | **Process will not boot.** `env.ts` resolves it with `req()` at module load and throws `Missing required env var: KYC_ENCRYPTION_KEY` |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | `NODE_ENV=production` | **Process will not boot** (`createContainer()` calls `assertKeyConfigured()`). Before that check existed, it fell back to a hardcoded public dev key and 500'd on the first webhook registration |
| `JWT_SECRET` | `STELLAR_NETWORK=public`; strongly advised on testnet | **Process will not boot on public network** (`resolveJwtSecret()` in `apps/api/src/services/container.ts:512` throws). On testnet: auto-generated per boot, so every restart and deploy logs every seller out |
| `SERVER_SIGNING_SECRET` | `STELLAR_NETWORK=public`; strongly advised on testnet | **Process will not boot on public network** (`resolveServerSigningKeypair()` in `apps/api/src/services/container.ts:489` throws). On testnet: auto-generated per boot, so the `SIGNING_KEY` published in `stellar.toml` changes on every restart and any wallet that cached it breaks |
| `DEFAULT_SELLER_WALLET` | never — optional everywhere | Multi-tenant: sellers supply their own wallet at SEP-10 login and links pay that address. Set it only to give `/health` a wallet to report a USDC trustline for; unset, that field reads `not_configured`. On testnet, unset auto-generates a throwaway seller so `pnpm dev` needs no config |
| `HOME_DOMAIN` | any real deployment | Falls back to `localhost:8787`. SEP-10 challenges are issued for localhost and `stellar.toml` advertises `WEB_AUTH_ENDPOINT="https://localhost:8787/auth"` — **wallet login cannot work at all** |
| `CORS_ORIGINS` | always | The browser refuses the dashboard's cross-origin calls |
| `DEFAULT_SELLER_SECRET` | never on a server — only `pnpm demo:seed`/`demo:reset` read it | Nothing. Sellers sign the anchor's SEP-10 challenge and their withdrawals with their own wallets |
| `METRICS_TOKEN` | optional | Auto-generated per boot and printed once, so `/metrics` scraping breaks on each restart |
| `REDIS_URL` | more than one instance | See the scaling note below |
| `SINGLE_INSTANCE` | public network with no `REDIS_URL` | `true` asserts this deploy runs one instance. Boot fails without either. |

Generate each 32-byte hex key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`render.yaml` declares all of these; the `sync: false` entries must be filled in
from the Render dashboard on first deploy. Adding a new `req()` call to
`apps/api/src/env.ts` without adding the matching `render.yaml` entry is what
caused the 2026-07-31 outage — see `docs/FIXLOG.md` `BUG-4.11`. The same
mistake is possible in `apps/api/src/services/container.ts`, where
`SERVER_SIGNING_SECRET` (line 489) and
`JWT_SECRET` (line 512) are also enforced at boot on public network.

### Scaling past one instance

Three structures are per-process today, and each silently loses its guarantee
if a second instance is started. The Render blueprint runs exactly one
instance, which is what makes the current setup correct — treat this as a hard
prerequisite, not a preference.

**This is now enforced at boot.** On the public network with no `REDIS_URL`,
`createContainer()` throws unless `SINGLE_INSTANCE=true` is set. Setting that
variable is a statement about your deployment, not a way to quiet a warning: if
you later scale the service up, set `REDIS_URL` in the same change. The two
failures it prevents — N× every rate limit, and one signed SEP-10 challenge
redeemable once per instance — are both invisible from outside the process,
which is why the guard is loud instead of a log line.

- **Rate limiting** — `MemoryStore` unless `REDIS_URL` is set. Already has a
  `RedisStore`; just configure it.
- **SEP-10 challenge nonces** — `ChallengeService` holds used challenge hashes
  in an in-process `Map`, so a restart or a second instance makes an
  already-redeemed challenge redeemable again inside its 15-minute window.
- **Idempotency in-flight guard** — `idempotency()` tracks concurrent requests
  in a per-process `Map`. The persisted replay table still works; only the
  concurrent-duplicate guard is lost, and it guards a money endpoint.

## Promotion: dev to main

Two services, two branches, one direction of travel.

| | Branch | Service | Network | Database |
|---|---|---|---|---|
| **Staging** | `dev` | `quay-api` | testnet | the original Turso database |
| **Production** | `main` | `quay-api-mainnet` | public | a separate Turso database |

Both are declared in the blueprints (`branch:` on each service), so this is not
a convention someone has to remember — it is what Render reads.

**The flow.** Work lands on `dev`, which auto-deploys to the testnet service.
Exercise it there against play money. When it holds up, open a PR from `dev` to
`main`; CI runs, and the merge deploys to mainnet.

**Why this direction and not the reverse.** `main` is branch-protected (PR
required, linear history), so it can only ever contain code that passed CI and
a review gate. Pointing mainnet at `main` therefore means the public network
runs nothing that has not already been merged deliberately — and, because `dev`
deploys first, nothing that has not already run somewhere real.

**What this costs.** A mainnet fix is never a one-line push. It is a commit on
`dev`, a deploy, a check, a PR, a merge. That is the intended friction: the
alternative is a service that moves real money accepting changes nobody looked
at twice. For a genuine emergency, `main` still allows an admin bypass — use it
knowing you have skipped the testnet run, and open the `dev` PR afterwards so
the branches do not diverge.

**Keeping them in step.** After a hotfix or an out-of-band merge to `main`,
merge `main` back into `dev` before doing anything else. Divergence between the
two is how a change that was tested on testnet gets deployed to mainnet without
the fix that was applied directly to production.

## Mainnet: a second, separate service

Everything below this point was originally written against the single testnet
Render service (`quay-api`). After the mainnet cutover (`docs/MAINNET.md`)
there are **two independent services with two independent sets of secrets**:

| | Testnet (default below) | Mainnet |
|---|---|---|
| Render service name | `quay-api` | `quay-api-mainnet` |
| Blueprint | `render.yaml` | `render.mainnet.yaml` |
| `STELLAR_NETWORK` | `testnet` | `public` |
| API URL | `https://quay-api.onrender.com` | the host Render assigns `quay-api-mainnet`, or your custom domain if `HOME_DOMAIN` is set — check the Render dashboard, do not assume it |
| Database | testnet Turso DB | a **separate** Turso DB — never point both services at the same one |
| Off-ramp | `testanchor` (SDF sandbox) | `anchor` (a real production anchor) or `none` |

Rotating, redeploying, or restoring one has **no effect** on the other. A
`DATABASE_URL` accidentally pointed at the wrong service's database is not a
typo that fails loudly — it is real payment data landing in (or being
overwritten by) the wrong environment.

### What's shared vs. what's per-environment

- **Shared** (same code path, same repo, just pointed at a different target):
  the push-to-`main` deploy trigger, the `/ready`-gates-traffic contract, the
  `pnpm db:restore` / `pnpm db:backup` scripts and backup file format, and the
  incident template at the bottom of this document.
- **Per-environment** (must be done once for *each* service, independently):
  which secrets are set (`render.mainnet.yaml`'s own header comment lists
  mainnet's full secret set — it includes `ANCHOR_URL` / `ANCHOR_HOME_DOMAIN` /
  `METRICS_TOKEN`, which testnet's `render.yaml` does not declare), which
  Render service's logs/deploys you are watching, and which backup file you
  restore from (see Restore below — testnet and mainnet backups are not
  interchangeable).

### Deploy — mainnet

Same push-to-`main` mechanism as the Deploy section below; Render rebuilds
both services from the same commit. What differs:

- Watch **`quay-api-mainnet`**'s own deploy logs for `/ready` — it is a
  separate Render service from `quay-api` with a separate log stream.
- The public-network guardrails in `apps/api/src/env.ts` throw at boot on a
  bad mainnet config (wrong off-ramp mode, a missing secret, a plain-HTTP
  anchor URL, and more — the full table is in `docs/MAINNET.md`). A mainnet
  deploy that fails to go `/ready` is very often a guardrail doing exactly its
  job, not a code regression — read the boot error before assuming otherwise.
- Run `docs/MAINNET.md` Phase 4's verification checklist after **every**
  mainnet deploy, not just the first — it is cheap, and it catches a wrong
  `SIGNING_KEY` or a rejected wallet signature before a real customer does.

### Rollback — mainnet

The Rollback section below (redeploy the previous successful build) applies
identically — just pick `quay-api-mainnet` in the Render dashboard instead of
`quay-api`.

To abandon a mainnet cutover entirely rather than roll back one bad deploy
(e.g. cutover happened before the service was actually ready for traffic),
follow `docs/MAINNET.md`'s own Rollback section instead: stop routing traffic
to `quay-api-mainnet` and point the web app's `NEXT_PUBLIC_API_URL` (and
`NEXT_PUBLIC_STELLAR_NETWORK`) back at testnet. Either way, payments already
settled on the public ledger cannot be rolled back — only the service in front
of them can be.

### Restore — mainnet

Same `pnpm db:restore` script and procedure as the Restore section below, with
two things that must never be crossed:

- **Restore only from a backup taken of `quay-api-mainnet`'s own database.**
  Restoring a testnet backup into the mainnet database replaces real
  payment/off-ramp/KYC rows with fake ones; restoring a mainnet backup into
  testnet leaks real seller PII into a lower-trust environment.
- Confirm whatever nightly backup job you set up for mainnet
  (`docs/MAINNET.md`'s Database note) is actually pointed at the mainnet
  `DATABASE_URL` *before* an incident, not while triaging one.

The quarterly scratch-drill procedure and the restore-drill log below are
shared — a drill exercises the backup/restore code path itself, which is
identical for both environments.

### Key rotation — mainnet

Same procedures as the Key rotation section below, run against
`quay-api-mainnet`'s own secret values — rotating a key on `quay-api`
(testnet) never touches mainnet's copy of that key, and vice versa. Two
mainnet-only notes:

- **`ANCHOR_URL` / `ANCHOR_HOME_DOMAIN`** only exist on mainnet
  (`OFFRAMP=anchor`). Changing anchors is not a rotation — treat it as picking
  a new anchor (`docs/MAINNET.md` Phase 1) and re-verify its SEP-10/SEP-38/
  SEP-6 support before pointing production traffic at it.
- **`METRICS_TOKEN`** is `sync: false` on mainnet the same as testnet — rotate
  it the same way, but remember any external scraper reading the mainnet
  `/metrics` endpoint needs the new token too.

## Uptime monitoring

`scripts/uptime-check.mjs` (`.github/workflows/uptime.yml`) checks every
configured environment on one schedule, each with its own history series and
its own section in `docs/STATUS.md` — a healthy testnet can never stand in
for an unmonitored mainnet (issue 8.8).

**Testnet is always checked**, with the same defaults and unprefixed target
ids (`api` / `web` / `synthetic`) this script has always used —
`https://quay-api.onrender.com` / `https://quay-web.vercel.app`, overridable
via `UPTIME_API_URL` / `UPTIME_WEB_URL`.

**Mainnet is checked only once you configure it — there is no default of any
kind.** Set these as repository **Variables** (Settings → Secrets and
variables → Actions → Variables — they're plain hostnames, not secrets):

| Variable | Required | What it does |
|---|---|---|
| `UPTIME_MAINNET_API_URL` | **set this once `quay-api-mainnet` exists** | e.g. `https://quay-api-mainnet.onrender.com` (`render.mainnet.yaml`'s `quay-api-mainnet`). Unset means mainnet is skipped entirely, not silently checked against the testnet URL. |
| `UPTIME_MAINNET_WEB_URL` | optional | Only set this if a dedicated mainnet web deployment exists. `render.mainnet.yaml` declares no web service today, so leave unset until one does. |
| `UPTIME_MAINNET_SYNTHETIC_CHECK` | optional, default off | Set to `1` to also POST a throwaway `/links` synthetic check against mainnet, same as testnet already does. Left off by default: it would write a real row into the production database on every successful run, and unlike testnet, `POST /links` there has no scoped-credential story yet — see issue #163 (least-privilege API key for this check) before turning it on. |

Both environments are watched at once, on the same schedule, with separate
history series — a green testnet can never stand in for an unmonitored mainnet.
Testnet keeps the unprefixed target ids (`api` / `web` / `synthetic`); mainnet's
are prefixed (`mainnet-api` / `mainnet-web` / `mainnet-synthetic`).

Once `UPTIME_MAINNET_API_URL` is set, the next run adds a `## Mainnet`
section to `docs/STATUS.md` and starts filing incidents titled
`🔴 Uptime: Mainnet — API is down` (the environment name is always in the
title and body — see `renderStatusMd`/`buildTargets` in the script) instead of
the ambiguous `🔴 Uptime: API is down` a pre-8.8 reader might mistake for
testnet.

**Cadence, honestly.** The cron asks for `*/5`. GitHub does not deliver that:
scheduled workflows on a free public repo are best-effort and coalesced under
load, and the measured gaps were ~30-42 minutes at best (2026-08-18) and ~3
hours (2026-09-06). Treat this as "checked periodically", not "checked every 5
minutes" — and specifically do NOT rely on it to keep a free Render instance
awake, because every observed gap exceeds the 15-minute idle timeout.

**Where the output lives.** The scheduled run is on, but it does not commit to
`main`. It writes `docs/uptime-state.json`, `docs/STATUS.md` and the
badge JSON to a dedicated **`status` branch**, and the README badges read from
there. The pinger was originally disabled in `a0f06d1` because a commit every
five minutes buried the repo's real history — 470 commits are that bot — and a
bot push cannot satisfy main's branch protection anyway. The copy of
`docs/STATUS.md` on `main` is a snapshot and will lag; the live one is on
`status`.

A spun-down Render instance is not running the settlement watcher, and this
workflow does not prevent that — see the cadence note above. What limits the
damage is that the watcher resumes from its persisted cursor: a payment is
marked paid late, not lost. Buying `starter` is what actually removes the
problem.

**Turning the anchor probe off.** `.github/workflows/anchor-probe.yml` runs a
nightly SEP-1 → SEP-10 → SEP-38 → SEP-6 flow against `testanchor.stellar.org`
and files an issue when it fails. That is the testnet deploy's sandbox; a
payments-only mainnet has no anchor, so the probe would file nightly issues
about a dependency the product no longer has. Set the repository variable
`ANCHOR_PROBE_DISABLED=1` to skip it.

## Deploy

Render deploys `apps/api` as a single always-on Docker web service (starter
plan - the free tier spins down after 15 min idle, which would stop the
watcher loop and cash-out poller). Pushing to `main` triggers Render's
auto-deploy (configured in the Render dashboard, not in this repo). The web
app deploys separately to Vercel.

1. Confirm `pnpm typecheck && pnpm test && pnpm build` is green on `main`
   (CI - `.github/workflows/ci.yml` - already gates this on every push/PR).
2. Render picks up the new commit and rebuilds `apps/api/Dockerfile`.
3. Watch the Render deploy logs for the health check (`/ready`) to go green —
   **not** `/health`. `render.yaml`/`render.mainnet.yaml`'s `healthCheckPath`
   and the Dockerfile's own `HEALTHCHECK` both gate traffic on `/ready`, which
   checks the database is actually reachable; `/health` is liveness-only and
   returns `ok: true` unconditionally, so watching it go green tells you the
   process started, not that it can serve a request.
4. Confirm the watcher loop resumed: check for `payment ... ->` log lines, or
   query `watcher_cursors` for a recent `updated_at` on a watched account.

## Rollback

1. In the Render dashboard, redeploy the previous successful deploy (Render
   keeps prior build artifacts - this is faster and safer than reverting the
   commit and waiting for a fresh build).
2. If the bad deploy included a schema change (`pnpm db:push`), assess
   whether the previous code version is compatible with the *new* schema
   before rolling back the code alone - `db:push` is additive-by-default
   (`CREATE TABLE IF NOT EXISTS`; see `apps/api/src/db/client.ts`), so an old
   binary talking to a newer schema is the common case and usually safe, but
   a column removal or rename would not be.
3. If rollback doesn't resolve the incident, fall back to the restore
   procedure below against the most recent backup.

## Restore

`pnpm db:restore <backup-file> <target-database-url> [target-auth-token]`

- `target-database-url` is a **required, explicit argument** - this command
  never reads `DATABASE_URL` from the environment, specifically so a stray
  invocation can't silently overwrite whatever database the current shell
  happens to be pointed at.
- The backup file must be decryptable with the `BACKUP_ENCRYPTION_KEY`
  currently in the environment (same key used to create it).
- The script recreates the schema in the target (via `bootstrap()`) before
  inserting rows, then verifies every table's restored row count against the
  backup's own manifest and exits non-zero on any mismatch.

**Restoring into production** (real incident, not a drill):

1. Get the intended target's connection details (a *new* Turso database, not
   the broken one in place - restoring over a live, possibly-still-being-
   written-to database compounds the problem).
2. Run `pnpm db:restore <backup-file> <new-turso-url> <new-turso-token>`.
3. Confirm the printed row counts look right for the backup's age (compare
   against the last known-good row counts in monitoring/logs, if available).
4. Point `DATABASE_URL`/`DATABASE_AUTH_TOKEN` (Render env vars) at the new
   database and redeploy.
5. Update this runbook's restore-drill log below with the real incident
   details - a real restore is itself a rehearsal for the next one.

**Quarterly scratch-database drill** (per issue 8.6's own requirement - this
is a rehearsal, done against a throwaway database, not production):

1. Take (or reuse the most recent nightly) backup.
2. `pnpm db:restore <backup-file> file:./scratch-drill.db` (a local scratch
   file is sufficient - the goal is exercising the procedure, not testing
   against Turso specifically).
3. Spot-check a handful of restored rows against what you expect.
4. Delete the scratch file. Record the drill below.

### Restore drill log

| Date | Performed by | Result | Notes |
|---|---|---|---|
| 2026-07-28 | automated (this change) | **Passed** - see transcript below | Performed via a Python mirror of the backup/restore procedure, not the actual `scripts/db-backup.ts`/`scripts/db-restore.ts` - **no Node.js runtime was available in the environment this change was authored in**, so the real TypeScript scripts could not be executed directly. The mirror used the exact same bootstrap DDL (copied from `apps/api/src/db/client.ts`), the same JSON dump shape (`dumpDatabase`'s table-name → row-object-array structure), and the same AES-256-GCM wire format (`[iv(12)][authTag(16)][ciphertext]`, matching `scripts/lib/backupCrypto.ts`) that the real scripts implement - so the *procedure* (schema recreation, encrypt, decrypt, row-for-row restore, count + content verification, and tamper-detection via the GCM auth tag) was genuinely exercised end to end, even though the real `.ts` files themselves weren't run. **A maintainer with a working Node install should run the actual `pnpm db:backup` / `pnpm db:restore` once to confirm parity with this drill before relying on it.** |

```
[backup]  wrote backup.db.json.enc (1043 bytes, encrypted)
[backup]  row counts: {'sellers': 1, 'links': 1, 'webhooks': 0, 'webhook_deliveries': 1, 'watcher_cursors': 1, 'processed_tx': 1}
[restore] manifest row counts:  {'sellers': 1, 'links': 1, 'webhooks': 0, 'webhook_deliveries': 1, 'watcher_cursors': 1, 'processed_tx': 1}
[restore] restored row counts:  {'sellers': 1, 'links': 1, 'webhooks': 0, 'webhook_deliveries': 1, 'watcher_cursors': 1, 'processed_tx': 1}
[restore] verified: True
[restore] spot-check links row: ('ref-001', '25.00', 'paid')
[restore] DRILL PASSED
```

A separate check confirmed the encryption is genuinely tamper-evident, not
just obfuscation: flipping a single bit in an encrypted blob's ciphertext
causes decryption to raise `InvalidTag` rather than silently returning
corrupted data.

## Key rotation

- **`KYC_ENCRYPTION_KEY`**: encrypts seller SEP-12 KYC field values at rest using AES-256-GCM.
  Blob format is `v1:<keyId>:<base64(iv||authTag||ciphertext)>`, where `keyId` is the first 8 hex characters of the key's SHA-256 digest.
  Zero-downtime rotation procedure:
  1. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  2. Update environment variables in your deployment dashboard:
     - `KYC_ENCRYPTION_KEY`: `<new_key>` (primary for all new writes)
     - `KYC_ENCRYPTION_KEY_PREVIOUS`: `<old_key>` (or comma-separated list of previous keys for decrypting older records)
  3. Redeploy the API. The service will immediately encrypt all new submissions under the new key while continuing to read older records seamlessly.
  4. Run dry-run scan to verify: `pnpm kyc:rotate-key --dry-run`
  5. Run the background re-encryption: `pnpm kyc:rotate-key`
  6. Verify the Prometheus metric `kyc_non_primary_key_rows` drops to `0`.
  7. Remove `KYC_ENCRYPTION_KEY_PREVIOUS` from the deployment environment.
- **`BACKUP_ENCRYPTION_KEY`**: generate a new key, but **keep the old key
  available** (e.g. as `BACKUP_ENCRYPTION_KEY_PREVIOUS` in your secret store)
  until every backup encrypted under it has passed its retention window -
  old backups are not re-encrypted in place. Set the new key as
  `BACKUP_ENCRYPTION_KEY` going forward; new backups use it immediately.
  Restoring an old backup requires temporarily using the key it was actually
  encrypted with.
- **`DATABASE_AUTH_TOKEN` (Turso)**: create a new token
  (`turso db tokens create <db>` or the Turso dashboard), update the Render
  env var, redeploy, then revoke the old token once the new deploy is
  confirmed healthy.
- **`DEFAULT_SELLER_SECRET`**: not a server secret any more. The API never
  signs with it; each seller signs their own anchor login and withdrawals. If
  a deployment still has it set, unset it. Only the local demo scripts use it.
- **Anchor sessions** (`anchor_sessions`): each seller's anchor JWT, encrypted
  with `WEBHOOK_SECRET_ENCRYPTION_KEY`. Rotating that key makes the stored
  tokens unreadable; sellers simply sign in to the anchor again. A seller who
  changes wallet also has to sign in again — a session is only honoured for
  the account it was issued to.

## Anchor outage

`OFFRAMP=testanchor` drives real SEP-10/SEP-38/SEP-6 calls against an
external anchor. When the anchor is down or erroring:

- `triggerCashOut` (`apps/api/src/services/link-service.ts`) wraps the
  quote/initiate calls. Thrown failures normally become HTTP 502; an open
  health breaker returns HTTP 503 `anchor_unavailable`. Hung upstream
  requests can still delay the response.
- `pollCashOuts` (used by `startCashOutPoller` in
  `apps/api/src/worker/watcher-loop.ts`) catches each per-job status error,
  stores the message against that link id in the in-memory
  `lastPollErrorByLinkId` map, and logs
  `[offramp] poll failed for link <id>: <message>`. Each failing link backs
  off independently from 2 seconds to a 60-second cap, so one sick anchor
  does not crash the loop or block healthy jobs. A successful poll clears
  that link's stored error and backoff. The map is process-local, is not
  persisted or exposed over HTTP, and is cleared by an API restart.
- Links stuck in `offramp_pending` during an outage resume polling
  automatically after their per-link backoff expires and the anchor recovers
  - no manual intervention is needed unless the outage is prolonged (see
  "Stuck `offramp_pending` job" below for the manual path if you don't want
  to wait).
- Do not switch an environment to `OFFRAMP=mock` during a live-anchor
  incident. Production uses `OFFRAMP=anchor`; public-network guards reject
  `mock`, and changing adapters while jobs exist can make real jobs settle
  against the wrong state store. Keep the current adapter and let its
  per-link retries resume; escalate a prolonged outage instead of replacing
  the adapter.

For failures that affect one seller or begin after an anchor configuration
change, use the matching procedure under "Anchor incidents" below rather than
the whole-anchor outage procedure.

## Anchor incidents

Use these procedures when the anchor is reachable but rejects one seller,
refuses or fails a withdrawal, publishes a replacement SEP-1 key, or no
longer recognises a seller's wallet identity. Do not repair any of these by
editing seller or off-ramp state directly.

### KYC rejected

**Symptom:** `GET /seller/kyc` returns HTTP 200 with `status: "REJECTED"` and
the anchor's `message`. A cash-out attempt is refused with HTTP 403
`{"error":"kyc_required"}`. The route log contains
`cashout.request.error`; there is no KYC-specific log event and no
`cashout.error`, because the cash-out never reaches quote or initiate. The
status and message come from `getSep12Customer` in
`packages/offramp/src/sep12.ts`, are persisted by `TestAnchorKyc` in
`packages/offramp/src/kyc.ts`, and trigger `assertKycAccepted` in
`apps/api/src/services/link-service.ts`.

**What Quay does automatically:** Before each quote or cash-out, Quay
re-fetches SEP-12 state, saves the anchor's status and message, and refuses
anything other than `ACCEPTED`. A corrected submission through
`PUT /seller/kyc` is immediately re-synchronised with the anchor.

**What the operator does:** Relay the anchor's message exactly. Ask the seller
to correct the identity data and resubmit through `PUT /seller/kyc` as the
anchor directs. Confirm `GET /seller/kyc` returns `ACCEPTED` before the seller
retries the cash-out.

**What the operator must not do:** Never change `seller_kyc.status`,
`seller_kyc.customer_id`, or encrypted KYC fields by hand. Do not tell the
seller to falsify identity data or bypass the KYC gate.

**Who to contact:** The seller owns the submitted identity data; the
configured anchor's compliance or support team owns the rejection and the
required correction.

### Customer frozen or withdrawal refused

**Symptom:** The link becomes `offramp_failed`. If the seller has an active
webhook registration, their endpoint receives `offramp.failed` with the
anchor's `reason`; otherwise check the authenticated link detail. Logs contain
`anchor.sep6.status.ok` with `status` equal to `error`, `refunded`, or
`expired`, followed by `link.transition` from `offramp_pending` to
`offramp_failed`. `mapSep6Status` and `TestAnchorOffRamp.status` in
`packages/offramp/src/testanchor.ts` perform the mapping;
`pollCashOuts` in `apps/api/src/services/link-service.ts` persists the
transition and webhook.

**What Quay does automatically:** Quay records the raw anchor status in
`offramp_jobs.external_status`, stores the anchor message in
`offramp_jobs.last_error` (or a generated withdrawal-failed message), and
moves the link to `offramp_failed`. Quay never takes custody. If the cash-out
returned transfer instructions and the seller confirms submission, the asset
payment went directly from the seller's wallet to the anchor. Quay does not
persist the seller's anchor-transfer hash, and it neither refunds nor
reverses the payment. Any refund is the anchor's process.

**What the operator does:**

1. Find the job and preserve the anchor's evidence:
   ```sql
   SELECT job_id, link_id, seller_id, account, external_status,
          last_error, created_at, updated_at
   FROM offramp_jobs
   WHERE job_id = '<anchor job id>' OR link_id = '<link id>';
   ```
   If there is no job row, stop. Preserve `cashout.error` and
   `cashout.request.error`, determine whether quote/initiate was refused or
   job state was lost, and contact anchor support. Do not create a job row.
2. Ask the seller for the Stellar transaction hash of their payment to the
   anchor. If they do not have it, search `offramp_jobs.account` on the
   configured `HORIZON_URL` or a block explorer around `created_at`, and
   verify the destination, asset, amount, memo, and successful status against
   the cash-out instructions or the anchor's transaction record. Quay does not
   store this hash; `links.tx_hash` is the buyer's payment, not the seller's
   transfer to the anchor. If no transfer instructions were returned or the
   seller cannot confirm submission, do not assume funds moved; reconcile the
   account and ask the anchor.
3. Give the seller, transaction hash, `job_id`, `external_status`,
   `last_error`, and timestamps to anchor support. Ask the anchor to confirm
   why the customer or withdrawal failed and whether it has refunded,
   reversed, or still holds the funds. Do not ask the seller to send the
   assets again until the anchor confirms that is safe.

**What the operator must not do:** Do not edit `offramp_jobs`, `links`, or
`seller_kyc` to retry or force settlement, and do not send a refund from a
Quay-operated account. Do not treat a null `last_error` as proof that no
failure occurred; preserve the raw `external_status` and ask the anchor.

**Who to contact:** The seller for the transfer hash and payment history;
the configured anchor's support or operations team for the customer hold,
transaction disposition, and any refund.

### SEP-1 `SIGNING_KEY` rotated

**Symptom:** A seller requesting a new anchor session receives HTTP 502
`{"error":"challenge_rejected","message":"Anchor SEP-10 challenge rejected:
..."}` from `POST /seller/anchor-auth/challenge`, or HTTP 400
`challenge_rejected` from `POST /seller/anchor-auth`. A successful new login
would log `anchor.sep10.seller_auth.ok`; a rejected challenge does not emit
that event or a separate rejection log. `SellerAnchorAuth.verify` in
`packages/offramp/src/anchor-session.ts` rejects a challenge signed by any key
other than the cached SEP-1 `SIGNING_KEY`, and the routes map that rejection
in `apps/api/src/routes/anchor-auth.ts`.

**What Quay does automatically:** Quay refuses to show or relay an
unverified challenge, so the seller is never asked to sign a transaction that
does not match the published key. Existing anchor sessions remain usable
until their JWTs expire. `AnchorDiscovery` currently caches the successful
SEP-1 response for the life of the process, so it does not learn a new key
without an API restart.

**What the operator does:**

1. Fetch the current file and compare `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`, and
   `NETWORK_PASSPHRASE` with the last trusted values:
   ```sh
   curl --fail --silent --show-error \
     "https://<anchor-home-domain>/.well-known/stellar.toml"
   ```
2. **Before restarting the API, confirm the rotation out of band with the
   anchor using previously verified contact details.** A changed key is also
   what a compromised domain or TOML looks like; the fetched file alone is not
   proof. Do not use contact details that appear only in the new TOML.
3. Only after the anchor confirms the change, restart every API instance so
   `AnchorDiscovery` reloads the SEP-1 file. Confirm the service is healthy
   and have affected sellers reconnect. Issue 3.23 will remove this restart
   requirement when live discovery refresh lands; until then, restart is part
   of the verified procedure.

**What the operator must not do:** Do not restart merely because the TOML
changed, disable challenge verification, accept an unverified SEP-10
transaction, or manually copy a new key into application state. Do not delete
valid seller sessions as a substitute for discovery reload.

**Who to contact:** The configured anchor's operations or security team for
out-of-band key-rotation confirmation; the Quay incident lead if the key is
genuine but verification or service recovery still fails.

### Seller changed wallet

**Symptom:** The new wallet is a different `sellers` row because
`sellers.wallet` is unique. Until the new seller reconnects, SEP-12 calls
return HTTP 403 `{"error":"anchor_auth_required"}`. A successful reconnect
logs `anchor.sep10.seller_auth.ok`. `SellerAnchorAuth.live` in
`packages/offramp/src/anchor-session.ts` ignores a session issued to the old
account, and `reusableCustomerId` in `packages/offramp/src/kyc.ts` re-queries
the anchor by the new account instead of reusing the old customer id.

**What Quay does automatically:** Quay does not migrate the old session,
customer id, or KYC profile to the new wallet. The anchor sees a new customer
after the new wallet authenticates. Existing in-flight off-ramp jobs retain
their stored seller id and account and continue to be polled under that
identity while the old wallet's anchor session remains valid.

**What the operator does:** Confirm the wallet change was intentional. Ask
the seller to reconnect with the new wallet and submit KYC there; there is no
operator database action for an ordinary wallet change.

**What the operator must not do:** Do not overwrite the old seller's wallet,
move `anchor_sessions`, `seller_kyc`, or anchor customer ids between sellers,
or alter in-flight jobs. A new anchor customer is intentional, not evidence
of data loss.

**Who to contact:** The seller for confirmation and reconnection. Contact
the anchor only if it does not treat the new wallet as a new customer or
reports a customer-id conflict.

## Watcher stuck

Symptom: payments are landing on-chain but links aren't transitioning to
`paid`.

1. Check server logs for `watcher account ... error` (per-account errors are
   caught and logged, not fatal - see `WatcherLoop.runOnce` in
   `apps/api/src/worker/watcher-loop.ts`) or `watcher tick error` (a
   loop-level failure).
2. Compare the stored cursor for the affected account against reality:
   ```sql
   SELECT * FROM watcher_cursors WHERE account = '<destination address>';
   ```
   A cursor that hasn't advanced (`updated_at` stale) despite on-chain
   activity on that account points at a stuck poll - check Horizon/RPC
   reachability from the Render instance.
3. The watcher only starts watching an account from "now" the first time it
   sees it (no history replay - see the `cursor === null` branch). If a link
   was created for an account the watcher hadn't seen before, and a payment
   landed in the same tick the cursor was first seeded, that specific payment
   is intentionally skipped by design, not a bug - it will need to be
   reconciled manually (check the transaction on Horizon, verify the memo
   against the link's `reference`, and update the link's status directly if
   confirmed).
4. If the whole loop appears dead (no watcher log lines at all across every
   account), the process itself may have crashed or Render may have spun the
   free-tier instance down (see the `render.yaml` comment - starter plan is
   mandatory for this reason) - check the Render service's process status
   directly.

## Telemetry rate-unit repair (one-off, issue 5.21)

`offramp_telemetry.quoted_rate` written before the 5.21 fix stored the raw
SEP-38 `price` (sell per buy) for real anchors, while every other rate in the
dataset is target-per-source — which made the summary's spread meaningless
for those rows. The adapters now write target-per-source; existing rows are
repaired once with:

```bash
# Against the deployment's DATABASE_URL / DATABASE_AUTH_TOKEN:
node apps/api/scripts/fix-telemetry-rate-units.mjs           # dry run (default)
node apps/api/scripts/fix-telemetry-rate-units.mjs --apply   # write
```

Dry-run first, always: the script prints every row it would invert. Mock rows
are never touched (they were already in the right unit). **Run `--apply` at
most once per database** — the column carries no unit tag, so a second apply
would invert the values back to wrong. Historical `fee_amount` on pre-fix
non-mock rows was computed across the mixed units and stays unreliable; the
script deliberately does not rewrite it.

## Legacy shared-account rows (issue 4.18)

Before withdrawals ran per seller, every seller authenticated to the anchor as
one platform account. The fix added nullable columns and left old rows NULL:
`offramp_jobs.seller_id` / `account` and `seller_kyc.account`. The runtime is
safe with them (a legacy job cannot be polled, so its link is failed as
`job_state_lost`; a legacy KYC row's `customer_id` is never reused), but nothing
told an operator what that left behind. This report does.

**When to run it:** once after upgrading a database that predates per-seller
anchor identity, when a seller asks why a cash-out failed as `job_state_lost`,
and before deleting or archiving old `offramp_jobs` rows.

```bash
# Take a backup first, then a dry run (the default; writes nothing):
pnpm db:backup
pnpm --filter @checkout/api exec tsx scripts/report-legacy-anchor-rows.ts
pnpm --filter @checkout/api exec tsx scripts/report-legacy-anchor-rows.ts --json   # machine-readable
```

It reads `DATABASE_URL` / `DATABASE_AUTH_TOKEN` like the other scripts. It never
decrypts or prints `seller_kyc.fields_encrypted`, and for KYC rows it only says
whether a `customer_id` is still stored, not what it is.

**Reading the output**

- *offramp_jobs*: one entry per job with `seller_id` or `account` NULL, with its
  link's current status and seller, the job status, `external_status` and
  timestamps. Flags:
  - `auto-failed as job_state_lost`: the link is still `offramp_pending`, so the
    poller fails it on its next tick (the anchor lookup throws
    `OffRampJobNotFoundError`).
  - `FUNDS MAY HAVE BEEN SENT`: transfer instructions were surfaced
    (`transfer_notified_at` set) or the anchor reported a post-transfer status
    (`pending_anchor`, `pending_external`, `completed`, ...). This is a
    heuristic from local data; the anchor is the source of truth.
  - `settled: needs reconciliation`: a legacy job that finished. The payout went
    out under the platform account, so check the records line up.
- *seller_kyc*: rows with `account` NULL. `customer_id set` means the row may
  still carry the shared platform customer's id, which another seller's identity
  could have overwritten. The row's encrypted profile is fine to keep.

**Cleaning up** (`--apply` alone is refused; it needs `--confirm` too):

```bash
pnpm --filter @checkout/api exec tsx scripts/report-legacy-anchor-rows.ts --apply --confirm
```

- Legacy `seller_kyc` rows: `customer_id` is cleared and `status` returns to
  `unsubmitted`, so the next sync starts from the seller's own account. The
  encrypted reusable profile is kept.
- Legacy `offramp_jobs` rows: `last_error` is set to `legacy_shared_account`
  where it was empty. Nothing else on the row changes; the rows are the audit
  trail.
- Only legacy rows are touched, and a second `--apply --confirm` changes nothing.
  It prints what it changed.

**A legacy job that had funds sent:** do not retry it from Quay; the job's state
is gone. Contact the anchor with the job id (`job_id` is the anchor's
transaction id) and the platform account. The platform account, not the seller,
is the anchor customer for that transfer, so the anchor must refund or credit
against that customer.

## Stuck `offramp_pending` job

Symptom: a link has been `offramp_pending` far longer than the anchor's
typical settlement time.

1. Find the job: `SELECT * FROM links WHERE status = 'offramp_pending' AND
   offramp_job_id = '<job id or link id>';` (or query by `id` if known).
2. Check the job's status directly against the configured off-ramp adapter
   (the same call `pollCashOuts` makes) rather than only trusting the stored
   `offramp_status`, which only updates on a successful poll.
3. If the adapter reports `settled`/`failed` but the link's `status` column
   didn't update, the poller likely hit a `save()` failure after a
   successful status check - re-run `pollCashOuts` once (e.g. via the API
   process, or a one-off script) rather than editing the row by hand first,
   so the normal state-transition path (and its webhook fire) still runs.
4. If the adapter itself has no record of the job (lost between initiate and
   first poll - rare, but possible across a deploy or crash mid-request),
   this needs manual resolution: verify via the anchor's own dashboard/support
   channel whether the off-ramp actually executed, and manually transition
   the link's status (`offramp_settled` or `offramp_failed`, per
   `packages/core/src/domain/status.ts`'s allowed transitions) to match
   reality. A link in `offramp_failed` does not need a database edit to retry:
   the seller can use "Retry cash-out" on the dashboard (or `POST
   /links/:id/cash-out`), provided the previous job is terminal (see
   `previous_withdrawal_active` in `docs/API.md`).

## KYC and Identity Data Retention Policy (NDPA Compliance)

The Nigeria Data Protection Act 2023 (NDPA) requires that personal identity data is not kept longer than necessary for its purpose. To minimize exposure in the event of credential compromise, Quay implements an automated data retention policy for inactive sellers.

### Retention Inactivity Tracking & Purge Schedule
- **Activity tracking**: A seller's `last_active_at` is updated on wallet login (`POST /auth`), link creation (`POST /links`), and KYC submissions (`PUT /seller/kyc`). Database writes are throttled to at most once per hour per seller.
- **Retention period**: Controlled via `KYC_RETENTION_DAYS` (default `730` days / 2 years). Setting `KYC_RETENTION_DAYS=0` disables the sweep entirely.
- **In-flight protection**: Sellers with links currently in `offramp_pending` status are excluded from purging to avoid disrupting live cash-outs.
- **Purged data**:
  - `seller_kyc` rows (AES-256-GCM encrypted SEP-12 PII fields and customer IDs).
  - `anchor_sessions` rows (encrypted anchor auth tokens).
  - `sellers.payout_fields_json` (last-used payout bank/account details are cleared to `NULL`).
  - Anchor contact is not attempted (recorded as `anchor_not_contacted`).
- **Telemetry & Metrics**:
  - Metrics counter: `quay_kyc_retention_purged_total` tracks total purged sellers.
  - Logs structured event: `{"event": "privacy.retention.purged", "count": N}` with strictly zero PII.

### Operator CLI Usage
Operators can manually trigger or preview the retention sweep using the retention CLI script:

```bash
# Dry run: preview counts of eligible inactive sellers without modifying the database
pnpm --filter @checkout/api exec tsx scripts/kyc-retention.ts --dry-run

# Live run: execute retention purge against configured DATABASE_URL
pnpm --filter @checkout/api exec tsx scripts/kyc-retention.ts
```

## Incident template

Copy this into a new incident doc/issue when something goes wrong:

```markdown
## Incident: <short title>

- **Detected at:** <timestamp, timezone>
- **Detected by:** <person/alert/report>
- **Severity:** <sev1/sev2/sev3 - sev1 = payments/off-ramp fully down or data at risk>
- **Affected:** <API / web / watcher / off-ramp / database>

### Timeline
- <HH:MM> <what happened / was observed / was done>

### Root cause
<once known>

### Resolution
<what fixed it>

### Data impact
- Was any payment record, off-ramp job, or (post-3.4) KYC data lost or
  corrupted? If a restore was performed, link to the restore-drill log entry
  above with the real incident's row counts.

### Follow-ups
- [ ] <concrete action item>
```

## PII Breach (NDPA 72-Hour Notification)

If personal data (KYC fields, payout fields, session tokens, seller identity) is exposed, accessed without authorization, or lost:

### 1. Detect & Contain (immediate)

- **Rotate `KYC_ENCRYPTION_KEY`** (see issue 4.31):
  1. Generate new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  2. Add to `render.yaml` / Render dashboard as new `KYC_ENCRYPTION_KEY`
  3. Re-encrypt all `seller_kyc.fields_encrypted` and `sellers.payout_fields_encrypted` with new key (one-off script)
  4. Deploy with new key; old key invalidates all existing encrypted rows

- **Revoke all anchor sessions** (issue 4.26):
  - `DELETE FROM anchor_sessions;` (or call revocation endpoint per seller)
  - Forces re-authentication; invalidates any stolen SEP-10 JWTs

- **Assess scope**:
  - Which tables/rows affected? (`seller_kyc`, `sellers`, `anchor_sessions`, `kyc_consents`, `link_payments`, `webhookQueue`)
  - How many sellers?
  - What data categories? (KYC fields = high risk; wallet addresses = medium; logs = low)

### 2. Assess Risk (within 24 hours)

- Likelihood of harm to data subjects (identity theft, financial fraud, privacy violation)
- Types of data involved:
  - **High risk**: KYC fields (name, address, ID numbers, financial), payout fields (bank details)
  - **Medium risk**: Wallet addresses, payment history, API key metadata
  - **Low risk**: Logs (already redacted per `docs/pr-27-logging.md`), analytics

### 3. Notify (within 72 hours of awareness)

Per NDPA Section 38, notify:

1. **NDPC (Nigeria Data Protection Commission)**:
   - Via breach portal: <https://ndpc.gov.ng>
   - Include: nature of breach, categories of data, approximate number of subjects, likely consequences, measures taken, contact for more info

2. **Affected Sellers** (if high risk):
   - Email with: description of breach, likely consequences, measures taken/advise to mitigate, contact for more info
   - Template: "We detected unauthorized access to your [data categories] on [date]. We have [actions taken]. You should [recommended steps]. Contact [email] for questions."

3. **Anchor(s)** (if their data was involved):
   - Notify anchor's security/contact per their DPA/agreement

4. **Hosting/DB Providers** (Render, Turso):
   - Per DPA obligations; they may have their own notification duties

### 4. Document

- Record in incident log (date, scope, root cause, actions, notifications sent)
- Link to `docs/PRIVACY.md` breach handling section
- Update `docs/PRIVACY.md` if material changes to data map or notice

### 5. Rotate Related Secrets (as needed)

- `WEBHOOK_SECRET_ENCRYPTION_KEY` (if webhook payloads exposed)
- `JWT_SECRET` (if session tokens exposed)
- `SERVER_SIGNING_SECRET` (if signing key exposed)
- `WEBHOOK_SECRET_ENCRYPTION_KEY` rotation (issue 4.31) — 24h overlap window

### 6. Follow-up

- [ ] Root cause analysis
- [ ] Implement mitigations (code, config, process)
- [ ] Update `docs/PRIVACY.md` if data map changed
- [ ] Conduct post-incident review within 14 days
- [ ] Report to board/management per internal policy
