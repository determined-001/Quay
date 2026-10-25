# Security Policy

Stellar Checkout handles payment flows, so we take security reports seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, report privately using one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (the **Security** tab → **Report a vulnerability**), or
- email the maintainer at **adenijiayomideay@gmail.com**.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected component(s) and version/commit,
- any suggested remediation.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- We will keep you updated on progress and let you know when a fix is released.
- We ask that you give us a reasonable window to remediate before any public
  disclosure.

## Scope notes

Stellar Checkout is live on Stellar mainnet (payments only; cash-out is
`OFFRAMP=none` there - see the [README](./README.md)). Anything that can affect
real funds or seller data is in scope. In particular:

- **Wallet authentication and sessions** - the SEP-10 login (`GET`/`POST /auth`),
  session JWTs and their revocation, and per-seller scoping of `/links`,
  `/webhooks`, `/seller/*` and the other authenticated routes. Reading or
  changing another seller's data is a valid finding.
- **API keys and scopes** - key minting, scope enforcement and the
  no-privilege-escalation rule ([docs/API.md](./docs/API.md#authentication)).
- **Payment matching and money math** - bypassing the payment-matching or
  idempotency guards, double-crediting, or incorrect amounts.
- **Webhooks** - forging a webhook signature, and the SSRF guard on
  seller-registered webhook URLs (`apps/api/src/services/ssrf-guard.ts`).
- **KYC and payout data** - handling of SEP-12 identity fields, saved payout
  fields and the anchor bearer tokens stored in `anchor_sessions`
  ([encryption inventory](#at-rest-encryption-inventory),
  [docs/PRIVACY.md](./docs/PRIVACY.md)).
- **The non-custodial signing boundary** - Quay must never hold or use a
  seller's spending key; the seller's own wallet signs the anchor login and the
  withdrawal transfer. Anything that makes the server sign for a seller is a
  finding ([docs/THREAT-MODEL.md](./docs/THREAT-MODEL.md),
  [docs/ANCHOR-DUE-DILIGENCE.md](./docs/ANCHOR-DUE-DILIGENCE.md)).

Known, documented limitations are listed in the "Remaining exposure" column of
[docs/THREAT-MODEL.md](./docs/THREAT-MODEL.md). Reports about those are
appreciated but may be closed as already tracked. Two environments are not
production and are out of scope for findings that need them:

- **`OFFRAMP=mock`** moves no money and is refused at boot on the public network.
  **`OFFRAMP=testanchor`** talks to the SDF testnet sandbox and is likewise
  refused on the public network.
- **The USDC issuers in `.env.example`** are the issuers we use, but verify them
  per network before relying on them.

## Dependency and secret scanning (issue 8.5)

- **`pnpm audit --audit-level=high`** runs in CI on every push/PR, checked
  against an explicit allowlist (`.github/audit-allowlist.txt`) - only
  advisories listed there (each with a reasoning comment) are permitted to
  pass; anything else fails the build.
- **Dependabot** (`.github/dependabot.yml`) runs monthly. For the npm
  workspace it is security-only: version-bump PRs are suppressed and it opens
  a PR only when an advisory is involved. The GitHub Actions ecosystem is not
  security-only; its updates are grouped into one monthly PR.
- **gitleaks** runs in CI (`.gitleaks.toml`, extending gitleaks' default
  rule set with a rule specifically matching a Stellar secret seed -
  `S` followed by 55 base32 characters) and is available as a local
  pre-commit hook: `git config core.hooksPath .githooks` (requires
  [gitleaks](https://github.com/gitleaks/gitleaks#installing) installed
  locally; the hook skips itself with a warning if it isn't, so it never
  silently blocks a commit for missing tooling - CI still catches a leaked
  secret on push either way).
- **GitHub's built-in secret scanning and push protection** should be
  enabled on this repository - these are repository **Settings** toggles
  (Settings → Code security and analysis), not something a pull request can
  turn on. Maintainers: enable both "Secret scanning" and "Push protection"
  there if not already on.

### Secret inventory and rotation

One row per secret. "Old data survives" says whether what was protected under
the old value is still readable after the new one is deployed. Rotating any of
these means changing the value where it is set (Render's dashboard, or the CI
secrets store) and redeploying; nothing here is read from a file this repo
ships.

| Secret | Protects | Set in | If lost or replaced | Rotation procedure | Old data survives? |
|---|---|---|---|---|---|
| `SERVER_SIGNING_SECRET` | The platform's own stable SEP-10 identity: the `SIGNING_KEY` published in `stellar.toml` (`S...` secret) | Render env var (required on `public`) | A new key changes the `SIGNING_KEY` on `/.well-known/stellar.toml`; wallets that cached the old one fail to verify challenges until they refetch it. Unset on testnet it regenerates on every boot | Generate a new Stellar keypair, set it, redeploy. Do it in a quiet period | n/a (no data is encrypted with it) |
| `JWT_SECRET` | Signs the session JWTs minted after a SEP-10 wallet login (`POST /auth`) | Render env var (required on `public`) | Every outstanding session is invalid at once and all sellers sign in again. On testnet an unset value is generated per boot, so a restart silently rotates it | Set a new random value, redeploy. There is no mixed-validity window. Revoked-token rows keyed by `jti` become inert and are swept on their own expiry | Sessions: no. Nothing else is derived from it |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | AES-256-GCM key for **two** things: webhook signing secrets (`webhooks.secret_encrypted`) **and** every seller's anchor bearer token (`anchor_sessions.token_encrypted`) | Render env var (required in production) | The process will not boot in production without it. Replacing it makes both sets of ciphertext unreadable (authentication fails); there is no previous-key slot | Set the new 64-hex key and redeploy. Then: webhook secrets must be re-issued, each seller rotates via `POST /webhooks/:id/rotate-secret` (it never decrypts the old value, so it works; the unreadable old value is simply not honoured during the overlap). Anchor sessions are dropped on first read and sellers sign in to the anchor again | No. Webhook secrets and anchor sessions both have to be re-created |
| `KYC_ENCRYPTION_KEY` | AES-256-GCM encryption of seller PII at rest: `seller_kyc.fields_encrypted`, `seller_profile.value_encrypted` and `sellers.payout_fields_encrypted` | Render env var (required for `OFFRAMP=testanchor\|anchor`) | The process will not boot without it when an anchor is configured. Records written under a lost key cannot be read; payout fields fall back to `null` (re-entered on the next cash-out) and sellers resubmit KYC | Zero-downtime: set the new key as `KYC_ENCRYPTION_KEY` and the old one in `KYC_ENCRYPTION_KEY_PREVIOUS`, redeploy, run `pnpm kyc:rotate-key`, wait for `kyc_non_primary_key_rows` to reach 0, then drop the previous key (see docs/RUNBOOK.md "Key rotation") | Yes, while the old key is kept in `KYC_ENCRYPTION_KEY_PREVIOUS` |
| `BACKUP_ENCRYPTION_KEY` | Encryption of database backups produced by `scripts/db-backup.ts` | The backup job's environment | A backup encrypted under a lost key cannot be restored | Generate a new key but keep the old one in your secret store until every backup under it is past retention. Old backups are not re-encrypted in place; restoring one needs the key it was written with | Yes, for as long as you keep the old key |
| `DATABASE_AUTH_TOKEN` | Access to the Turso database | Render env var | The API cannot reach its database | Create a new token (`turso db tokens create <db>` or the dashboard), update the env var, redeploy, confirm the new deploy is healthy, then revoke the old token | Yes (the data is in the database, not the token) |
| `METRICS_TOKEN` | Bearer token gating `GET /metrics` | Render env var | `/metrics` is unreachable to the scraper (or open, where the gate is off) | Set a new random value on the API and in the scraper's config together, redeploy | n/a |
| `TELEMETRY_TOKEN` | Bearer token for the operator telemetry routes. Unset disables them | Render env var | The operator telemetry page cannot authenticate | Set a new random value, redeploy, and use it on the ops page (it is held only in that page's memory) | n/a |
| `REDIS_URL` credentials | The shared rate-limit store | Render env var | The limiter degrades to a per-instance in-memory store (it does not fail open), so limits stop being shared between instances; the shared SEP-10 single-use challenge claim also needs Redis | Rotate the password at the Redis provider, update `REDIS_URL`, redeploy | Yes (rate-limit counters are ephemeral) |
| `TEST_ANCHOR_SELLER_SECRET` | The funded testnet keypair the nightly anchor probe signs with. **CI only**, never a production secret | GitHub Actions secret | The nightly probe cannot sign in to testanchor and fails | Fund a new testnet keypair (Friendbot plus a USDC trustline) and replace the Actions secret | n/a |
| `DEFAULT_SELLER_SECRET` | Nothing on the server. The API never signs with it; each seller signs their own anchor login and withdrawals. Only the local demo scripts read it | Local `.env` for demos | n/a | Unset it on any deployment that still has it | n/a |

### At-rest encryption inventory

| Data | Table & Column | Key | Algorithm | Handling |
|---|---|---|---|---|
| Seller KYC PII | `seller_kyc.fields_encrypted` | `KYC_ENCRYPTION_KEY` | AES-256-GCM | Encrypted before insert, decrypted only in-process for anchor SEP-12 submission. |
| Reusable SEP-9 profile | `seller_profile.value_encrypted` | `KYC_ENCRYPTION_KEY` | AES-256-GCM | One encrypted value per SEP-9 field; binary document fields are never stored. |
| Seller Payout Fields | `sellers.payout_fields_encrypted` | `KYC_ENCRYPTION_KEY` | AES-256-GCM | Encrypted on cash-out (`savePayoutFields`), decrypted in-process for payout reuse. Plaintext `payout_fields_json` is backfilled to NULL on startup. Corrupted blobs log a warning and return NULL without breaking logins. Masked in all API responses. |
| Anchor Session JWTs | `anchor_sessions.token_encrypted` | `WEBHOOK_SECRET_ENCRYPTION_KEY` | AES-256-GCM | Bearer credentials encrypted at rest. |
| Webhook Signing Secrets | `webhooks.secret_encrypted` | `WEBHOOK_SECRET_ENCRYPTION_KEY` | AES-256-GCM | Reversible encryption for signing deliveries; plaintext never logged or emitted. |

Rotating any of the above requires updating the value in Render's dashboard
(or wherever it's actually deployed) and redeploying - none of these are
read from a file this repo ships, so there's nothing to "rotate" inside the
repo itself beyond this table staying accurate.
