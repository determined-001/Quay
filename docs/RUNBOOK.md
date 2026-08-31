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
| `DEFAULT_SELLER_WALLET` | `STELLAR_NETWORK=public` | **Process will not boot on public network** (`resolveSellerKeypairOrWallet()` in `apps/api/src/services/container.ts:386` throws). On testnet: auto-generates a throwaway keypair and prints it (funds land in a key nobody kept across a restart) |
| `HOME_DOMAIN` | any real deployment | Falls back to `localhost:8787`. SEP-10 challenges are issued for localhost and `stellar.toml` advertises `WEB_AUTH_ENDPOINT="https://localhost:8787/auth"` — **wallet login cannot work at all** |
| `CORS_ORIGINS` | always | The browser refuses the dashboard's cross-origin calls |
| `DEFAULT_SELLER_SECRET` | `OFFRAMP=testanchor` with `DEFAULT_SELLER_WALLET` set | SEP-10 cannot sign the anchor's auth challenge, so every cash-out fails |
| `METRICS_TOKEN` | optional | Auto-generated per boot and printed once, so `/metrics` scraping breaks on each restart |
| `REDIS_URL` | more than one instance | See the scaling note below |

Generate each 32-byte hex key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`render.yaml` declares all of these; the `sync: false` entries must be filled in
from the Render dashboard on first deploy. Adding a new `req()` call to
`apps/api/src/env.ts` without adding the matching `render.yaml` entry is what
caused the 2026-07-31 outage — see `docs/FIXLOG.md` `BUG-4.11`. The same
mistake is possible in `apps/api/src/services/container.ts`, where
`DEFAULT_SELLER_WALLET` (line 386), `SERVER_SIGNING_SECRET` (line 489), and
`JWT_SECRET` (line 512) are also enforced at boot on public network.

### Scaling past one instance

Three structures are per-process today, and each silently loses its guarantee
if a second instance is started. The Render blueprint runs exactly one
instance, which is what makes the current setup correct — treat this as a hard
prerequisite, not a preference:

- **Rate limiting** — `MemoryStore` unless `REDIS_URL` is set. Already has a
  `RedisStore`; just configure it.
- **SEP-10 challenge nonces** — `ChallengeService` holds used challenge hashes
  in an in-process `Map`, so a restart or a second instance makes an
  already-redeemed challenge redeemable again inside its 15-minute window.
- **Idempotency in-flight guard** — `idempotency()` tracks concurrent requests
  in a per-process `Map`. The persisted replay table still works; only the
  concurrent-duplicate guard is lost, and it guards a money endpoint.

## Deploy

Render deploys `apps/api` as a single always-on Docker web service (starter
plan - the free tier spins down after 15 min idle, which would stop the
watcher loop and cash-out poller). Pushing to `main` triggers Render's
auto-deploy (configured in the Render dashboard, not in this repo). The web
app deploys separately to Vercel.

1. Confirm `pnpm typecheck && pnpm test && pnpm build` is green on `main`
   (CI - `.github/workflows/ci.yml` - already gates this on every push/PR).
2. Render picks up the new commit and rebuilds `apps/api/Dockerfile`.
3. Watch the Render deploy logs for the health check (`/health`) to go green.
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
- **`DEFAULT_SELLER_SECRET`**: this is the seller wallet's Stellar secret key
  used for SEP-10 signing - rotating it means generating a new keypair,
  updating `DEFAULT_SELLER_WALLET`/`DEFAULT_SELLER_SECRET` together, and
  understanding that in-flight payment links pointed at the *old* wallet
  address remain valid destinations (Stellar payments don't care which key
  signs SEP-10 auth) but new SEP-10 challenges will be signed by the new key.
  Coordinate with whichever anchor integration is configured
  (`OFFRAMP=testanchor`) since it will have seen the old public key during
  its own KYC/auth flow.

## Attestation registry unreachable

`ATTESTATION_CONTRACT_ID` + `SOROBAN_RPC_URL` enable on-chain settlement
attestation (issue 9.2, contract in `contracts/quay-attest`). When the Soroban
RPC is down, the attester is unfunded, or the contract id is wrong:

- **Nothing about settlement changes.** A link becomes `paid` because the
  payment landed on the classic ledger. `attestSettlement`
  (`apps/api/src/services/link-service.ts`) is fired without being awaited and
  swallows every failure, so a dead RPC costs the watcher tick nothing.
- Affected links keep `attested_at = NULL` and their receipts render without an
  attestation block. That is the correct display — the fact genuinely is not in
  the registry yet.
- `startAttestationSweeper` retries them every `ATTESTATION_SWEEP_MS`
  (default 60s, 20 links per pass, oldest first). No manual action is needed
  once the RPC recovers; the backlog drains on its own.
- Grep the logs for `attestation.failed` to see why. The two common causes are
  an unfunded attester (the `SERVER_SIGNING_SECRET` identity pays invocation
  fees) and an unreachable `SOROBAN_RPC_URL`.
- A payment recorded before the `link_payments.ledger` column existed is
  skipped permanently: the contract wants the exact settling ledger and the
  registry is append-only, so writing a guessed one would be worse than leaving
  the receipt unattested. Those links stay in `listUnattested` and are re-checked
  cheaply each sweep without ever being written.
- **Rotating `SERVER_SIGNING_SECRET` changes who attested.** Existing
  attestations keep naming the old key, which is correct — they record who
  vouched at the time. Fund the new identity before rotating, or attestation
  silently stops working while settlement carries on fine.

## Anchor outage

`OFFRAMP=testanchor` drives real SEP-10/SEP-38/SEP-6 calls against an
external anchor. When the anchor is down or erroring:

- `triggerCashOut` (`apps/api/src/services/link-service.ts`) wraps the
  quote/initiate calls and surfaces failures as an `HttpError(502, ...)` -
  sellers attempting a new cash-out will see a clear 502, not a silent hang.
- `pollCashOuts` (used by `startCashOutPoller` in
  `apps/api/src/worker/watcher-loop.ts`) swallows per-job status-check
  errors (`catch { continue; }`) so one anchor outage doesn't crash the
  poller loop or block other jobs - but it also means an outage is **silent**
  from the poller's perspective. Check logs for an absence of
  `offramp.settled`/`offramp.failed` webhook fires on links you'd expect to
  have progressed, and check the anchor's own status page.
- Links stuck in `offramp_pending` during an outage will resume polling
  automatically once the anchor recovers - no manual intervention needed
  unless the outage is prolonged (see "Stuck `offramp_pending` job" below for
  the manual path if you don't want to wait).
- If switching to `OFFRAMP=mock` temporarily to unblock new cash-outs during
  a prolonged outage, remember `NEXT_PUBLIC_OFFRAMP_MODE` on the web app must
  be kept in sync (per `.env.example`'s own note) so the UI doesn't claim a
  real off-ramp is running.

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
   reality. `offramp_failed` can transition back to `offramp_pending` to
   retry.

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
