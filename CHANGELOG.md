# Changelog

All notable changes to Quay that affect operators, integrators or merchants are
recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and releases will follow [Semantic Versioning](https://semver.org/) once the
first one is cut.

Quay has not cut a release yet: the repo has no git tags and the packages are at
`0.1.0`. Everything below is therefore under **Unreleased**, grouped from the
merged history of `dev`. The first release moves this section under a dated
version heading (see "Changelog and releases" in [`CONTRIBUTING.md`](./CONTRIBUTING.md)).

Bug fixes are also tracked, with their root cause and regression test, in
[`docs/FIXLOG.md`](./docs/FIXLOG.md). Only the ones that change behaviour an
operator or integrator can observe are repeated here.

## [Unreleased]

### Breaking changes

- **Every seller is now their own customer at the anchor** (`fbd262f`). With
  `OFFRAMP=testanchor|anchor`, Quay no longer logs in to the anchor with one
  platform keypair. Previously every seller shared one Stellar account at the
  anchor, so one seller's SEP-12 KYC could overwrite another's and withdrawals
  ran as the platform.
  - Each seller must press **Connect to anchor** in the dashboard before KYC or
    cash-out. Their wallet signs the anchor's SEP-10 challenge in the browser;
    the resulting JWT is stored per seller (encrypted, table `anchor_sessions`)
    and never returned by the API.
  - `KycPort` and `OffRampPort` take an `AnchorCustomer { sellerId, account }`
    instead of using a shared account. KYC records and off-ramp jobs record the
    account they belong to, and are keyed by (seller, anchor). Legacy
    shared-account rows are never reused.
  - `DEFAULT_SELLER_SECRET` is no longer used to authenticate to the anchor.
  - Cash-out and KYC calls from a seller with no live anchor session fail with
    `403 anchor_auth_required` (the circuit breaker does not count it).
  - **Upgrade:** existing sellers reconnect once from the dashboard. Rows from
    the old shared account are reported and can be cleaned up with the legacy
    shared-account procedure in [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).
- **The on-chain leg of a withdrawal is now signed by the seller**
  (`OffRampInitiation` kind `"transfer"`). `POST /links/:id/cash-out` can return
  a `transfer` object (`destination`, `amount`, `asset`, `memo`, `memoType`)
  instead of `interactiveUrl`; the dashboard builds the payment and the seller's
  wallet signs and submits it. Integrators that only handled `interactiveUrl`
  must handle `transfer` too. See [`docs/API.md`](./docs/API.md).
- **`OFFRAMP=none` now answers `501 offramp_disabled`** on the cash-out routes,
  and the unmounted, incorrect `GET /offramp/info` route was removed.

### New or changed environment variables

- `KYC_ENCRYPTION_KEY` is **required** whenever `OFFRAMP` is `testanchor` or
  `anchor` (the API refuses to boot without it). `KYC_ENCRYPTION_KEY_PREVIOUS`
  is optional, for key rotation.
- `OFFRAMP_TYPE` (optional): fallback SEP-6 withdrawal type, for example
  `bank_account`. testanchor lists more than one USDC withdrawal type and the
  adapter refuses to guess, so set it for testanchor.
- `ANCHOR_CLIENT_DOMAIN` (default `false`): ask the anchor for a SEP-10
  `client_domain` challenge and co-sign it so the anchor can attribute sellers
  to this deployment.
- `OFFRAMP_RATE_SOURCE`, `OFFRAMP_RATE`, `OFFRAMP_RATE_EXPIRES_AT`,
  `OFFRAMP_RATE_CURRENCY`, `OFFRAMP_RATE_SOURCE_ASSET`, `OFFRAMP_RATE_URL`,
  `OFFRAMP_RATE_JSON_PATH` (all optional): quote an anchor that has no SEP-38
  from a configured rate.
- `OFFRAMP_PROTOCOL` (`auto` default, `sep6`, `sep24`): which anchor protocol
  carries a withdrawal. `auto` uses SEP-6 when the anchor declares it, else
  SEP-24. Together with `ANCHOR_URL`, `ANCHOR_HOME_DOMAIN`, `OFFRAMP_TYPE` and
  `OFFRAMP_RATE_SOURCE` it only seeds the new `anchors` table on first boot.
- `ANCHOR_KYC_TYPE` and `ANCHOR_KYC_TYPE_ORGANIZATION` (optional): the SEP-12
  customer `type` sent to anchors that key their KYC requirements on it.
- `TELEMETRY_TOKEN` now also gates `GET /telemetry/pii-audit`.
- `OFFRAMP_INTERACTIVE_TIMEOUT_MS` (default 1 hour): how long a SEP-24 job may
  sit at `incomplete` before it is failed as abandoned.
- `KYC_RETENTION_DAYS` (default 730) for the KYC and profile data retention
  purge; `SHUTDOWN_TIMEOUT_MS` (default 5000) now bounds graceful shutdown.
- `pnpm secrets:mainnet` no longer generates `DEFAULT_SELLER_*` keys.
- `STELLAR_NETWORK` is no longer read by the web app; the explorer follows
  `NEXT_PUBLIC_STELLAR_NETWORK`.

The authoritative list is [`.env.example`](./.env.example); `pnpm
docs:check-env-docs` keeps it in step with the code.

### Added

- Seller anchor session routes under `/seller/anchor-auth`, and SEP-10
  `client_domain` co-signing (`b1fa907`).
- Seller-signed cash-out transfer step in the dashboard, a SEP-7 pay URI and QR
  for it, resuming an unsent transfer after the modal closes, and SEP-24
  `pending_user_transfer_start` returned as non-custodial transfer instructions.
- Cash-out split into quote, confirm and initiate steps in the dashboard; SEP-38
  quotes now return target-per-source rates, and SEP-24 `/info` fees and limits
  appear in the quote.
- SEP-12: binary fields (multipart), callback URL for status push updates
  (`POST /anchor-callbacks/sep12/:anchorDomain/:token`), cached short-TTL
  `GET /seller/kyc`, and per-anchor KYC disclosure view.
- Reusable seller profile (`seller_profile`, encrypted per field), data-subject
  export `GET /seller/profile/export` and erasure `DELETE /seller/profile`, and
  a KYC and profile retention policy for inactive sellers.
- Reconciliation report for withdrawals, transfers and anchor payouts; sellers
  can report the on-chain transfer hash with
  `POST /links/:id/cash-out/transfer-sent`.
- Per-field validation hints from SEP-9 types in the dashboard; cash-out polling
  of interactive jobs with abandonment detection; `last poll error` surfaced on
  the link detail and timeline.
- Circuit breaker and health tracked per anchor.
- **Anchors live in a table** (`anchors`), managed with `node scripts/anchors.mjs
  list|add|enable|disable` without a redeploy. `SelectingOffRamp` picks SEP-6 or
  SEP-24 per anchor, a cash-out is routed to the anchor serving its payout
  currency (`422 corridor_unavailable` when none does), `/seller/anchor-auth`
  takes `?anchor=`, and `GET /health` lists every anchor's breaker under
  `anchors`. See [`docs/RUNBOOK.md`](./docs/RUNBOOK.md#switching-anchors).
- SEP-24 withdrawals end to end: interactive URL in the cash-out response, form
  prefill limited to fields the seller consented to share with that anchor
  (`GET`/`PUT /seller/kyc/prefill-consent`), and abandonment detection.
- **PII access audit log** (`pii_audit`): every read or write of a seller's
  identity data records the actor, action and field names (never values),
  readable with `GET /telemetry/pii-audit` and kept for two years.
- Metrics: `anchor_auth_required_total`, `offramp_jobs_by_external_status`,
  `offramp_jobs_awaiting_anchor_auth`, `pii_audit_write_failures_total`,
  `rate_limit_store_errors_total`, and `offramp_circuit_breaker_state` per
  anchor.
- Nightly anchor probe now also runs a full seller-signed cash-out against
  testanchor (auth, KYC, quote, withdraw, transfer, settlement).
- Playwright payment-loop end-to-end tests and the `pnpm sweep` pre-entry ritual.
- Widget API and `postMessage` contract docs; `apps/web` README.

### Changed

- **Database schema is now managed by Drizzle migrations** instead of boot-time
  DDL. Existing databases are stamped with a baseline on first boot. New
  scripts: `pnpm db:generate`, `db:migrate`, `db:status`, `db:check`.
- A failed cash-out can be retried from `offramp_failed`.
- `PUT /seller/kyc` bounds its input (at most 50 fields, names matching
  `^[a-z0-9_.]{1,64}$`, values up to 1,000 characters; violations are `400
  invalid_body`), and `GET`/`PUT /seller/kyc` return `providedFields: {}` to API
  keys: only a signed-in session sees the stored values.
- Anchor limit, withdraw-type and other 400/403/422 rejections now return `422`
  and no longer trip the circuit breaker; anchor 502 bodies are sanitised and
  unhandled errors return JSON.
- Anchor calls (SEP-10, SEP-12, SEP-24, quote and withdraw) time out instead of
  hanging; SEP-6 withdraw sends only declared, non-reserved fields; SEP-6
  withdraw responses and amounts are validated.
- Seller anchor sessions are revoked on logout and wallet change, expired
  sessions are swept hourly, and cash-out polling skips sellers whose session
  lapsed.

### Fixed

- Cash-out is claimed atomically so concurrent requests cannot start two
  withdrawals, and overlapping poll ticks no longer fire duplicate webhooks.
- Link amounts of zero or out of range are rejected; trustline limits are
  compared in stroops.
- Webhook delivery: SSRF guard rejects CGNAT and reserved IPv4 ranges, replays
  reset the attempts budget, and deliveries for deleted webhooks or undecryptable
  secrets are dead-lettered.
- The rate limiter falls back to an in-memory store if Redis fails.
- Preflight failures (for example a missing trustline) are no longer cached, so
  a seller can retry after fixing them.
- Embedded checkout now posts `quay:paid`, `quay:error` and `quay:closed`.

### Security

- Removed dormant server-key signing paths; CI runs `pnpm check:no-server-signing`.
- Anchor JWT claims are validated before a seller session is stored.
- Cleared HIGH advisories in `next`, `sharp`, `source-map-js`, `follow-redirects`
  and `zod`.

[Unreleased]: https://github.com/determined-001/Quay/commits/dev
