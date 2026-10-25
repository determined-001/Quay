# HTTP API

The API is served by `@checkout/api` (Hono) on `http://localhost:8787` by default
(`API_PORT`). All request and response bodies are JSON.

> **Auth:** `POST /auth` issues a session JWT after a wallet-signed SEP-10
> challenge; a seller row is created for the wallet on first login. **`/links`
> and `/webhooks` now require it** — every route under those two prefixes needs
> `Authorization: Bearer <token>` (or the httpOnly `session` cookie set by
> `POST /auth`) and returns `401` without one. The web UI provides wallet login via
> `SessionGate` (`apps/web/app/components/SessionGate.tsx`), which connects the seller's
> wallet, fetches the challenge from `GET /auth`, signs it, and submits it to `POST /auth`
> (via `apps/web/lib/api.ts`'s `getAuthChallenge` / `submitAuthChallenge`) to establish the session.

CORS is restricted to the origins in `CORS_ORIGINS` (comma-separated), with
`credentials: true` (required for the browser to send/receive the session cookie
cross-origin — so `CORS_ORIGINS` can't be `*` while auth is in use).

## Authentication

Every route marked **Requires auth** below needs `Authorization: Bearer <token>`
(from `POST /auth`), an API key (`Authorization: Bearer ak_...`), or the httpOnly
`session` cookie set by `POST /auth`.

- **401 `unauthorized` / `invalid_api_key`** — you are not authenticated: no token, or one
  that is missing, malformed, tampered, expired, or revoked (`POST /auth/logout`
  put its `jti` on the revocation list; an API key was deleted or invalid).
  The response body has `{ "error": "unauthorized", "message": "<why>" }` or
  `{ "error": "invalid_api_key" }`.
- **403 `forbidden` / `missing_scope`** — you *are* authenticated, but the credential is not authorized for this operation:
  - When an API key lacks the required scope, the response is `{ "error": "missing_scope", "required": "<scope>" }` (e.g. `links:write`).
  - `{ "error": "forbidden", "message": "<why>" }` is returned when a cookie-authenticated state change lacks an allowed `Origin` header (`apps/api/src/middleware/auth.ts`), when an API key attempts a session-only route (such as `/seller/kyc/files` or `/seller/profile`), or on key-minting scope escalation (`apps/api/src/routes/api-keys.ts`).
- **404 `not_found`** — the object does not exist **or does not belong to you**.
  These are deliberately the same answer: a 403 on someone else's link would
  confirm that the id is real, which is a leak in itself. Do not read a 404 as
  proof that an id is unused.

These are deliberately different failure modes: 401 means "prove who you are
again"; 403 means "you did, and this credential still is not allowed to do
that"; 404 means "nothing here that is yours."

### Scopes

API keys carry granular permission scopes (`ALL_SCOPES`). Session tokens from `POST /auth`
represent the logged-in seller and implicitly hold all scopes.
When minting an API key via `POST /api-keys`, omitting `scopes` assigns `DEFAULT_SCOPES`
(`links:read`, `links:write`, `webhooks:manage`).
Sensitive capabilities (`offramp:initiate`, `api-keys:manage`) are opt-in and must be explicitly requested.
Privilege escalation is prevented: an API key can only mint keys whose scopes are a subset of its own.

| Scope | What it allows | Required by routes | Default? |
| --- | --- | --- | --- |
| `links:read` | Read payment links, details, quotes, and export CSVs | `GET /links/export/csv`<br>`GET /links/:id/detail`<br>`GET /links/:id/offramp-preview`<br>`GET /links/:id/offramp-requirements`<br>`GET /links/:id/cash-out/quote` | Yes |
| `links:write` | Mutate and cancel payment links | `POST /links/:id/cancel` | Yes |
| `webhooks:manage` | Register, list, delete, and test webhooks | `POST /webhooks`<br>`GET /webhooks`<br>`DELETE /webhooks/:id`<br>`POST /webhooks/:id/test` | Yes |
| `api-keys:manage` | Create, list, and revoke API keys | `POST /api-keys`<br>`GET /api-keys`<br>`DELETE /api-keys/:id` | No (opt-in) |
| `offramp:initiate` | Initiate off-ramp cash-out, submit transfers, manage KYC, and anchor sessions | `POST /links/:id/cash-out`<br>`GET /links/:id/cash-out/transfer`<br>`POST /links/:id/cash-out/transfer-sent`<br>`GET /seller/kyc`<br>`PUT /seller/kyc`<br>`PUT /seller/kyc/files`<br>`GET /seller/anchor-auth`<br>`POST /seller/anchor-auth/challenge`<br>`POST /seller/anchor-auth`<br>`DELETE /seller/anchor-auth` | No (opt-in) |

## Conventions

- Money amounts are decimal strings (e.g. `"10.50"`), validated to at most 7
  decimals. Internally compared in integer stroops, never floats.
- Errors return `{ "error": "<code>", ... }` with an appropriate HTTP status.
  Validation failures return `400` with `{ "error": "invalid_body", "issues": [...] }`.
- `error` is a machine-readable code; a human-readable `message` may accompany it.
  Two codes cover failures we do not control the wording of:
  - `anchor_error` (**502**) — the anchor answered a SEP call with an error, was
    unreachable, or sent something unusable. `message` is fixed text such as
    `"The anchor returned an error (SEP-6 withdraw, HTTP 400)."`. The anchor's
    own response body is never returned: it is third-party content that can echo
    the seller's KYC or bank fields, so it is written, truncated to about 2 KB, to
    the server log (`event: "anchor.error"`) only. Returned by the cash-out,
    cash-out quote, `offramp-preview`, `offramp-requirements`, `/seller/kyc`,
    and `/seller/anchor-auth` routes.
  - `internal_error` (**500**) — an unhandled server error. The body is exactly
    `{ "error": "internal_error" }`: no message, no stack. Details are in the log.

## Idempotency

`POST /links` and `POST /links/:id/cash-out` support the `Idempotency-Key` header.

```
Idempotency-Key: <unique-string-per-logical-request>
```

- **Same key + same body** — the original response is replayed byte-for-byte with an
  `Idempotent-Replayed: true` header. No second link is created; no second anchor job is started.
- **Same key + different body** — `409 idempotency_key_reuse`.
- **Key still in-flight** — `409 request_in_progress`.
- Keys expire after **24 hours**.

Use a UUID or any sufficiently random string. Retry safely on network timeouts by
resending the same key and body.

## Rate limits

The API protects against abuse using fixed-window rate limiting (`apps/api/src/middleware/rate-limit.ts`).
Rate limit buckets are keyed by client IP (respecting `trustProxyHops`), or by the API key prefix
(`api-key:<prefix>`) for requests authenticated with an API key.

- **Standard limiter**: `RATE_LIMIT_MAX` requests per window (default 120 req / 60s).
- **Strict limiter**: `RATE_LIMIT_STRICT_MAX` requests per window (default 10 req / 60s), applied to sensitive routes:
  `POST /links`, `POST /links/:id/cash-out`, `POST /auth`, and `/api-keys/*`.
- **Receipt limiter**: `Math.floor(RATE_LIMIT_MAX / 2)` (default 60 req / 60s) for `/r/*`.
- **Privacy export limiter**: 5 requests per seller per hour for `/seller/profile/export`.

Every rate-limited route attaches standard headers on every response:
- `x-ratelimit-limit` — maximum number of allowed requests in the current window.
- `x-ratelimit-remaining` — remaining requests allowed in the current window.
- `x-ratelimit-reset` — Unix epoch timestamp (in integer seconds) when the window resets.

When rate limits are exceeded, the API responds with **429 Too Many Requests**, attaching a `retry-after` header
indicating the number of seconds until requests are accepted again.

**429 Response**
```json
{
  "error": "rate_limited"
}
```

---

## `GET /health`

Liveness + basic config echo, plus the watcher's Horizon health, a re-check of
the seller's own USDC trustline (cached up to 60s — see the account/trustline
preflight note below) so a revoked trustline shows up in ops without anyone
touching logs, and the anchor health probe + circuit breaker snapshot.

**200**
```json
{
  "ok": true,
  "network": "testnet",
  "sellerWallet": "G...",
  "usdcTrustline": { "ok": true },
  "horizon": { "degraded": false, "usingFallback": false, "consecutiveFailures": 0 },
  "anchor": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastCheckedAt": 1750000000000,
    "lastSuccessAt": 1750000000000,
    "lastError": null,
    "url": "https://testanchor.stellar.org",
    "probes": { "toml": true, "sep10": true, "info": true }
  }
}
```
`ok` is pure liveness (the process is up) — check `horizon.degraded` for whether
the ledger watcher is actually keeping up. Every Horizon call (`packages/stellar`)
goes through a retry policy first — 3 attempts, exponential backoff with full
jitter, honoring `Retry-After` on `429` — so a single blip never surfaces here at
all. `horizon.degraded` only flips to `true` once retries have been exhausted
`HORIZON_DEGRADED_THRESHOLD` times in a row (default 3): a transient 429 that
recovers on retry #2 never trips this, but a sustained outage does, instead of
silently degrading to "nothing is ever marked paid." `usingFallback` is `true`
once it has switched to `HORIZON_URL_FALLBACK` (if configured); it switches back
to the primary automatically on the next successful call. `400`/`404` responses
(e.g. an account that doesn't exist yet) are treated as a normal, prompt answer —
never retried, never counted against `consecutiveFailures`.

The `anchor` field reports the anchor health probe + circuit breaker snapshot (`apps/api/src/services/link-service.ts:AnchorHealth`).
`state` reflects the circuit breaker status (`closed`, `half_open`, or `open`), allowing operators to distinguish
an anchor outage from API degradation. `probes` reports the latest health checks across the anchor's `stellar.toml`,
SEP-10 web auth, and SEP-6/24 `/info` endpoints.

When the seller's own wallet can't currently receive USDC:
```json
{
  "ok": true,
  "network": "testnet",
  "sellerWallet": "G...",
  "usdcTrustline": {
    "ok": false,
    "reason": "no_trustline",
    "message": "Account G... has no trustline for USDC (issuer G...) — add one before this link can be paid.",
    "trustlineUri": "web+stellar:tx?xdr=...&network_passphrase=..."
  },
  "horizon": { "degraded": false, "usingFallback": false, "consecutiveFailures": 0 },
  "anchor": {
    "state": "closed",
    "consecutiveFailures": 0,
    "lastCheckedAt": 1750000000000,
    "lastSuccessAt": 1750000000000,
    "lastError": null,
    "url": "https://testanchor.stellar.org",
    "probes": { "toml": true, "sep10": true, "info": true }
  }
}
```

---

## `GET /ready`

Readiness probe for orchestrators and container health checks (used as Render's `healthCheckPath`
and the Dockerfile `HEALTHCHECK`). Distinct from liveness (`GET /health`): `ok` indicates whether
the instance can actively serve database queries. Watcher circuit breaker status and metrics are
included for diagnostics, but watcher circuit breaker trips deliberately do not fail readiness so that
an instance can continue serving checkout pages and link creation during Horizon blips.

**Request**
```http
GET /ready HTTP/1.1
```

**200**
```json
{
  "ok": true,
  "circuitBreakers": {
    "horizon": false
  },
  "metrics": {
    "accountsWatched": 1,
    "tickDurationMs": 45,
    "circuitBreakersOpen": 0,
    "perAccountLag": {
      "G...": 0
    }
  }
}
```

| Status | Body | When |
| --- | --- | --- |
| `200` | `{ "ok": true, "circuitBreakers": ..., "metrics": ... }` | Database connection is healthy and ready to serve traffic |
| `503` | `{ "ok": false, "circuitBreakers": ..., "metrics": ... }` | Database readiness check failed (`container.ready()` returned false) |

---

## `GET /metrics`

Prometheus text-format metrics (`content-type: text/plain; version=0.0.4`).
Guarded by `METRICS_TOKEN` — pass `Authorization: Bearer <token>` or `?token=`.
If `METRICS_TOKEN` isn't set, the API generates an ephemeral one at boot and
prints it once (so the endpoint is never open by default, even locally).

**401** — wrong or missing token: `unauthorized`

**Counters**
| Metric | Labels |
| --- | --- |
| `payments_matched_total` | `outcome` (`paid`, `underpaid`, `asset_mismatch`, `no_memo`, `unknown_reference`) |
| `link_status_transitions_total` | `to` |
| `wallet_submissions_total` | `outcome` (`submitted`, `invalid_xdr`, `rejected`) |
| `webhook_attempts_total` | `result` (`ok`, `error`) — every retry counts separately |
| `anchor_calls_total` | `method` (`quote`~SEP-38, `initiate`/`status`~SEP-6), `status` (`ok`, `error`, `rejected`) |
| `anchor_auth_required_total` | `route` (`kyc_get`, `kyc_put`, `quote`, `cash_out`, `poll`) — seller had no live anchor session (403 `anchor_auth_required`); `poll` counts one per poll tick of a blocked job. Not counted by the circuit breaker, so invisible in `anchor_calls_total` |
| `quay_kyc_retention_purged_total` | — (total inactive sellers whose KYC and identity data was purged under retention policy) |

**Histograms**
| Metric | Labels |
| --- | --- |
| `watcher_tick_duration_seconds` | — |
| `payment_to_paid_latency_seconds` | — |
| `anchor_call_duration_seconds` | `method` |
| `quote_to_settlement_duration_seconds` | `outcome` (`settled`, `failed`) |

**Gauges**
| Metric | Meaning |
| --- | --- |
| `accounts_watched` | distinct destinations the watcher is currently polling |
| `pending_cash_outs` | links in `offramp_pending` |
| `offramp_jobs_by_external_status` | `external_status` — `offramp_pending` links by the anchor's raw transaction status, set at scrape time. Known SEP-6/SEP-24 statuses (e.g. `pending_user_transfer_start` = waiting on the seller's transfer, `pending_anchor`, `incomplete`) are always present (0 when empty); any other value, or a job not yet polled, is counted under `other`. Sums to `pending_cash_outs` |
| `webhook_deliveries_in_flight` | webhook deliveries currently being attempted, including retries |
| `offramp_circuit_breaker_state` | `0`=closed, `1`=half_open, `2`=open — see below |
| `watcher_lag_seconds` | seconds since the watcher's last completed poll tick |
| `kyc_non_primary_key_rows` | number of seller KYC rows encrypted with legacy or non-primary encryption keys |

A ready-made dashboard for these is at [`docs/grafana-dashboard.json`](grafana-dashboard.json)
(import directly into Grafana, point it at your Prometheus data source).

**Off-ramp circuit breaker:** every off-ramp adapter call (mock or
`testanchor`) is routed through `CircuitBreakerOffRamp`
(`apps/api/src/services/circuit-breaker.ts`), which opens after 3 consecutive
failures and stays open for 30s before allowing a half-open trial call — so a
down anchor can't be hammered by every cash-out poll. This is also the single
seam `anchor_calls_total` / `anchor_call_duration_seconds` are recorded from.

---

## `GET /auth?account=G...`

Step 1 of [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
wallet login: builds a challenge transaction for the given account to sign.

**200**
```json
{ "transaction": "AAAAAgAAAAA...", "network_passphrase": "Test SDF Network ; September 2015" }
```
**400** — `{ "error": "missing_account" }` or `{ "error": "account must be a valid Stellar G-address" }`

---

## `POST /auth`

Step 2: submit the challenge transaction signed by the account's wallet(s).
Verifies the server's own signature, timebounds, domain fields, and that
signature weight from the account's actual signers (via Horizon, M-of-N aware)
meets its medium threshold — the account's master key if it isn't funded yet.
Each challenge can be redeemed exactly once.

On success, a seller row is created for the wallet if one doesn't exist yet
(the wallet address **is** the identity).

**Request**
```json
{ "transaction": "AAAAAgAAAAA..." }
```

**200** — also sets an httpOnly `session` cookie (`Secure` unless `COOKIE_SECURE=false`,
`SameSite=None` when secure, `SameSite=Lax` otherwise), for server-side/SSR requests that can't hold the token in JS memory.
```json
{ "token": "<session JWT>", "expiresAt": 1750003600 }
```
- `token` — an HS256 JWT (`sub`=wallet G-address, `sellerId`, `jti`, `exp` ≤ 24h from
  now). Keep it **in memory only** on the client — never `localStorage`/`sessionStorage`.
- There is no refresh token by design: renew by re-signing a fresh challenge
  (`GET /auth` → `POST /auth` again) before `expiresAt`.

**401** — `{ "error": "<reason>" }`, e.g. signature verification failed, challenge
already used, or the transaction doesn't match what we issued.

---

## `POST /auth/logout`

**Requires auth.** Revokes the current token's `jti` (rejected by every
protected route from then on, even though it hasn't expired yet) and clears
the `session` cookie.

**200**
```json
{ "ok": true }
```
**401** — same as any protected route: missing/invalid/expired/already-revoked token.

---

## `GET /.well-known/stellar.toml`

[SEP-1](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)
descriptor advertising `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`, and `NETWORK_PASSPHRASE`
so wallets can discover this service's SEP-10 endpoint — the server-side mirror of
how `SellerAnchorAuth` (`packages/offramp/src/anchor-session.ts`) discovers an anchor
and verifies its challenge before the seller's wallet signs it.

---

## `POST /links`

**Requires auth.** Creates the link under the authenticated seller (the
one the token's `sellerId` resolves to).

**Request**
```json
{
  "title": "T-shirt",
  "amount": "10.50",
  "assetCode": "USDC",
  "expiresInMinutes": 60
}
```
- `title` — required, 1–120 chars.
- `amount` — required, positive, ≤ 7 decimals.
- `assetCode` — `"USDC"` (default) or `"XLM"`. The USDC issuer is resolved
  server-side from config.
- `expiresInMinutes` — optional positive integer (≤ 43200). Omit for no expiry.

**201**
```json
{
  "link": {
    "id": "lnk_...",
    "reference": "...",
    "status": "active",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "destination": "G...",
    "expiresAt": 1750000000000
  },
  "request": {
    "uri": "web+stellar:pay?destination=...&amount=...&memo=...",
    "memo": "...",
    "memoType": "text"
  }
}
```
The `request.uri` is a spec-correct SEP-7 payment URI for the buyer's wallet/QR.
The buyer **must** pay with the given `memo` — that is how the watcher correlates
the on-chain payment back to this link.

**422** — the destination (the seller's wallet) can't currently receive this
asset: not yet created/funded on-chain, no trustline for an issued asset, the
trustline is unauthorized (frozen by the issuer), or it's already at its limit.
Checked on every `POST /links` (an unfunded/trustline-less seller wallet used to
mean a checkout page that could never actually be paid — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for why this matters). Cached 60s per
(account, asset) so this stays cheap.
```json
{
  "error": "destination_cannot_receive",
  "message": "Account G... has no trustline for USDC (issuer G...) — add one before this link can be paid.",
  "reason": "no_trustline",
  "asset": { "code": "USDC", "issuer": "G..." },
  "trustlineUri": "web+stellar:tx?xdr=...&network_passphrase=..."
}
```
- `reason` — `account_not_found` | `no_trustline` | `trustline_not_authorized` | `trustline_limit_exceeded`.
- `trustlineUri` — present for `no_trustline` (and any reason where a trustline
  exists to sign for): a SEP-7 `tx` deep link wrapping an unsigned `changeTrust`
  operation. The seller's wallet can sign it directly — nothing server-side ever
  touches their key. Absent for `account_not_found` (no account yet, so no
  sequence number to build a transaction from).

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | Body failed validation (`issues` lists why) | Fix the request |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `409` | `request_in_progress` / `idempotency_key_reuse` | An `Idempotency-Key` conflict, see [Idempotency](#idempotency) | Wait, or use a new key |
| `422` | `destination_cannot_receive` | The seller's wallet cannot receive the asset (above) | Fix the trustline or fund the account |
| `429` | `rate_limited` | The strict rate limit was exceeded | Wait for `retry-after` |

---

## `GET /links`

**Requires auth.** Lists the authenticated seller's own links only.

**200**
```json
{ "links": [ { "id": "lnk_...", "status": "paid", "...": "..." } ] }
```
**401** — `{ "error": "unauthorized", "message": "missing session token" }` (or `invalid_api_key`).

---

## `GET /links/export/csv`

**Requires auth.** Requires `links:read` scope. Exports reconciliation CSV of the authenticated seller's own links.

**Query parameters:**
- `from` (*optional*): ISO timestamp or `YYYY-MM-DD` date. Links created at or after this time (`createdAt >= from`) are included. If date-only, defaults to `00:00:00.000Z` of that day.
- `to` (*optional*): ISO timestamp or `YYYY-MM-DD` date. Links created at or before this time are included. When given as a date-only (`YYYY-MM-DD`), the filter is inclusive of the entire UTC day (through `23:59:59.999Z`). When given as a full ISO timestamp, exact comparison (`createdAt <= to`) is preserved.

If `from` or `to` cannot be parsed, returns **400** `{ "error": "invalid_query", "message": "unparsable <from|to> date" }`.

**200** `text/csv; charset=utf-8`
Content-Disposition: `attachment; filename="quay-links-export.csv"`
```csv
id,reference,title,amount,asset,status,payer,tx_hash,paid_amount,created_at,updated_at,offramp_status
lnk_y70hu7frwy,pl_8q5g02fczihq,"Order #1042",10.5,USDC,offramp_settled,GAQODF5S...,e2e1a17378c6cd...,10.5,2026-10-25T14:30:56.132Z,2026-10-25T14:31:07.875Z,settled
```

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_query` | `from` or `to` could not be parsed (`message`) | Use an ISO timestamp or `YYYY-MM-DD` |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:read` | Use a key with the scope |

---

## `GET /links/:id`

**Public — no auth.** Fetch one link plus its payment request (used by the
checkout page). The link id is the bearer capability; seller-only detail remains
behind `GET /links/:id/detail`.

**200** — same shape as the `POST /links` response.
**404** — `{ "error": "not_found" }`

---

## `GET /links/:id/detail`

**Requires auth.** Fetch full link details for the merchant/dashboard, including payment
request, webhook delivery history, and the current cash-out poll status. Scoped to the
authenticated seller (returns 404 for links belonging to other sellers).

**200**
```json
{
  "link": {
    "id": "lnk_...",
    "reference": "...",
    "status": "offramp_pending",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "destination": "G...",
    "expiresAt": 1750000000000
  },
  "request": {
    "uri": "web+stellar:pay?destination=...&amount=...&memo=...",
    "memo": "...",
    "memoType": "text"
  },
  "deliveries": [
    {
      "webhookId": "whk_...",
      "linkId": "lnk_...",
      "event": "link.paid",
      "statusCode": 200,
      "ok": true,
      "error": null,
      "createdAt": 1750000000000
    }
  ],
  "offrampExternalStatus": "pending_anchor",
  "offrampPoll": {
    "reason": "anchor_unreachable",
    "message": "The anchor service is temporarily unavailable or returned an error.",
    "at": 1750000005000
  }
}
```
- `offrampExternalStatus` — the anchor's own raw status for the cash-out job
  (for example SEP-24 `incomplete`, which `offrampStatus` collapses to
  `pending`), or `null` when the link has no job or the anchor reported none.
- `offrampPoll` — present when the link is in `offramp_pending` and the background cash-out
  poller encountered an error during its last poll attempt (e.g. `anchor_unreachable`,
  `circuit_open`, `anchor_auth_required`, `unknown`). It is `null` when no error occurred or once
  a subsequent poll succeeds. Never leaks raw anchor response bodies, tokens, or payout fields.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:read` | Use a key with the scope |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |

---

## `POST /links/:id/cancel`

**Requires auth** and the `links:write` scope. The seller voids a link they
created by mistake. No request body. Idempotent: cancelling a link that is
already `cancelled` is a successful no-op and sends no second webhook. A
cancelled link can no longer be paid; a payment that still arrives for it is
recorded as `payment.unmatched` so the seller can refund the buyer out of band.
Cancelling never reverses an on-chain payment.

**200** — the updated link (same fields as `link` in `POST /links`, shortened here)
```json
{
  "link": {
    "id": "lnk_ueeh4nl1m1",
    "reference": "pl_m2o9yvvllj7x",
    "title": "Mistake",
    "amount": "2",
    "asset": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    "status": "cancelled",
    "...": "..."
  }
}
```
Fires the `link.cancelled` webhook.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:write` | Use a key with the scope |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |
| `409` | `Link cannot be cancelled (is "<status>")` | The state machine does not allow `cancelled` from the link's current status (for example `paid` or `offramp_pending`) | Refund out of band instead |

---

## `POST /links/:id/submit`

**Public — no auth.** The buyer submits a transaction signed by their own wallet.
The API parses and validates the complete XDR before relaying it to Horizon. It
accepts exactly one payment operation and verifies the destination, asset, amount,
and required `MEMO_TEXT` against the link. It never marks the link paid directly;
the ledger watcher remains the source of truth.

**Request**
```json
{ "signedXdr": "AAAAAgAAAAA..." }
```

**200**
```json
{ "txHash": "b166269ace8a96efe..." }
```

**400** — malformed XDR, fee-bump envelope, or a transaction containing anything
other than exactly one payment operation.

**409** — the link is unavailable, or the transaction does not match the link.
A Horizon rejection returns `{ "error": "payment_rejected", "reason": "...", "detail": "..." }`,
where `reason` can distinguish `insufficient_balance`, `missing_trustline`, or a
generic `payment_rejected`.

---

## `GET /r/:reference`

**Public — no auth.** The buyer-facing receipt, keyed by the payment reference
(the same value carried in the Stellar memo). Deliberately narrow: it returns
only what is safe to hand a stranger holding the link. It never includes
`sellerId`, `isDemo`, or any of the off-ramp economics (`offrampRate`,
`offrampFeeAmount`, `offrampNetTargetAmount`) — a buyer must not learn the
seller's realized FX rate or anchor fees.

Only settled links resolve. An `active`, `expired` or `cancelled` link returns
`404`: an unpaid link is not a receipt.

**200**
```json
{
  "reference": "pl_0eipnodm7s2o",
  "title": "Order #1042",
  "amount": "3",
  "asset": { "code": "XLM", "issuer": null },
  "status": "paid",
  "txHash": "b166269ace8a96efe...",
  "payer": "G...",
  "paidAmount": "3",
  "createdAt": 1786094880000,
  "updatedAt": 1786094898582
}
```

### Verifying a receipt without trusting this API

Quay saying a link is `paid` is a claim about its own database. You do not have
to accept it: the payment itself is on the public ledger, and the receipt hands
you everything needed to check it.

- `txHash` is the classic Stellar transaction that delivered the payment. Look
  it up on any Horizon instance or block explorer — it carries the amount, the
  asset and its issuer, the destination, and the ledger it settled in. Nothing
  in that lookup goes through Quay.
- The transaction's **memo** is the link's `reference`. That is what binds the
  payment to this invoice, and it is part of the signed transaction, so it is
  not something this API can invent after the fact.
- `asset` names the issuer as well as the code. Check it: an asset coded `USDC`
  from an issuer that is not Circle's is a different token and worth nothing.

If those three agree with what this page told you, the receipt is real
regardless of who is running the API.

```bash
REF=pl_0eipnodm7s2o
REFHASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$REF').digest('hex'))")

stellar contract invoke \
  --id CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3 \
  --source <any-funded-account> --network testnet --send=no \
  -- verify --ref_hash $REFHASH
```

**404** — `{ "error": "not_found" }`: unknown reference, or the link is not
settled.

---

## Cash-out (off-ramp) flow

For the merchant's point of view (what the dashboard shows and what each wallet
signature does), see [`MERCHANT-CASH-OUT.md`](MERCHANT-CASH-OUT.md).

Cashing out a paid link to local currency is several calls, and with a real
anchor (`OFFRAMP=testanchor|anchor`) the seller's own wallet signs the parts
that matter. Which adapter runs is set by `OFFRAMP`: `mock` (the default for
local development, simulated, moves no money), `testanchor` (the Stellar testnet
reference anchor, which is what the public testnet deployment runs), `anchor`
(a production anchor) or `none` (payments only; every cash-out route answers
`501 offramp_disabled`).

All routes below need the `offramp:initiate` scope unless noted (a session
token holds every scope). The order is:

1. **Connect to the anchor** — `GET /seller/anchor-auth` to see whether a session
   exists, then `POST /seller/anchor-auth/challenge`, sign the returned
   transaction with the seller's wallet, and `POST /seller/anchor-auth`. See
   [`/seller/anchor-auth`](#selleranchor-auth). Skipped by `mock`, where
   `required` is `false`.
2. **Verify identity (SEP-12)** — `GET /seller/kyc`, `PUT /seller/kyc` (with
   consent) until `status` is `ACCEPTED`. Cash-out answers `403 kyc_required`
   before that. See [`GET /seller/kyc`](#get-sellerkyc). `mock` reports
   `ACCEPTED` straight away.
3. **Ask what the anchor needs** — [`GET /links/:id/offramp-requirements`](#get-linksidofframp-requirements)
   returns the withdrawal types and the payout fields to collect;
   [`GET /links/:id/offramp-preview`](#get-linksidofframp-preview) shows
   indicative rates without using a quote.
4. **Quote** — [`GET /links/:id/cash-out/quote`](#get-linksidcash-outquote)
   returns the gross amount, fee and net amount the seller would get, and a
   `quoteId`.
5. **Cash out** — [`POST /links/:id/cash-out`](#post-linksidcash-out) (optionally
   with that `quoteId`) starts the withdrawal and moves the link to
   `offramp_pending`. The response says how the seller finishes: a `transfer`
   to send, an `interactiveUrl` to open, or neither yet.
6. **Send the transfer** — when there is a `transfer`, the seller's wallet pays
   it to the anchor. Quay never sends it. Optionally report the hash with
   [`POST /links/:id/cash-out/transfer-sent`](#post-linksidcash-outtransfer-sent);
   if the instructions were lost, [`GET /links/:id/cash-out/transfer`](#get-linksidcash-outtransfer)
   returns them again.
7. **Poll the link** — `GET /links/:id/detail` (or `GET /links/:id`) until
   `status` is `offramp_settled` or `offramp_failed`, or subscribe to the
   `offramp.transfer_required`, `offramp.settled` and `offramp.failed`
   [webhooks](#webhook-delivery). A failed cash-out can be retried from
   `offramp_failed`.

The calls that start money-adjacent work (`POST /links/:id/cash-out`) honour
[`Idempotency-Key`](#idempotency) and use the strict rate limit.

---

## `GET /links/:id/offramp-requirements`

**Requires auth** and the `links:read` scope. The withdrawal types the anchor
offers for this link's asset, the payout fields each one needs, and the payout
fields the seller already saved (masked). Use it to build the cash-out form
instead of hard-coding bank fields. It works on a link in any state and does
not need the seller's anchor session (the anchor's `/info` is public).

**200** (the `mock` adapter; a real anchor lists its own types and fields)
```json
{
  "types": [
    {
      "name": "bank_account",
      "descriptors": [
        {
          "name": "type",
          "label": "Payout Method",
          "description": "How you want to receive the funds.",
          "optional": false,
          "choices": ["bank_account", "mobile_money"]
        },
        {
          "name": "dest",
          "label": "Bank Account / Mobile Number",
          "description": "Your bank account number or mobile money number.",
          "optional": false
        },
        {
          "name": "dest_extra",
          "label": "Bank Code / Routing Info",
          "description": "Sort code, SWIFT/BIC, or mobile money provider code (if required).",
          "optional": true
        }
      ]
    }
  ],
  "defaultType": "bank_account",
  "savedFields": null
}
```
- `types[].name` is the value to send as `withdrawType` to the quote and
  cash-out routes. `descriptors` are the keys for `payoutFields`.
- `defaultType` is the type to preselect: the operator's `OFFRAMP_TYPE` when the
  anchor offers it, or the only type when there is one. `null` means the seller
  must choose.
- `savedFields` is `null` until the seller has cashed out once. Afterwards it
  maps field name to a masked value (all but the last 4 characters replaced by
  `*`), e.g. `{ "dest": "******6789" }`. Saved values are reused automatically by
  `POST /links/:id/cash-out`, so the seller only re-enters what changed. They
  are stored encrypted with `KYC_ENCRYPTION_KEY`; a deployment without that key
  (for example local `OFFRAMP=mock`) does not keep them, so `savedFields` stays
  `null` there.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:read` | Use a key with the scope |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |
| `501` | `offramp_disabled` | `OFFRAMP=none`: this deployment has no cash-out | Do not retry; hide cash-out |
| `502` | `anchor_error` | The anchor was unreachable or answered with an error (see Conventions) | Retry later |

---

## `GET /links/:id/offramp-preview`

**Requires auth** and the `links:read` scope. Indicative FX prices for a **paid**
link (SEP-38 `GET /prices`). No firm quote is used, so it is safe to call every
time the dashboard loads. Optional query parameter `currency` (for example
`NGN`): when given, the indicative rate for that currency is saved on the link so
the spread against the later firm quote can be recorded.

**200**
```json
{
  "indicative": true,
  "prices": [
    { "targetCurrency": "NGN", "price": "1650", "deliveryMethods": ["BANK_TRANSFER"] },
    { "targetCurrency": "KES", "price": "129", "deliveryMethods": ["BANK_TRANSFER"] }
  ],
  "sourceAmount": "10.5"
}
```
`price` is units of `targetCurrency` per 1 unit of the link's asset. `prices` is
an empty array (and `sourceAmount` is `null`) when the adapter cannot give
indicative prices, for example with `OFFRAMP=none` or an anchor with no SEP-38
quote server, so a client should treat an empty list as "no preview", not as an
error. `sourceAmount` is what was actually paid.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:read` | Use a key with the scope |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |
| `409` | `Link must be paid to preview off-ramp (is "<status>")` | The link is not `paid` | Wait until it is paid |
| `502` | `anchor_error` | The anchor failed or was unreachable | Retry later |

---

## `GET /links/:id/cash-out/quote`

**Requires auth** and the `links:read` scope. A cash-out quote (gross, fee and
net) without starting anything: no job is created and the link is left as it
is. It applies the same checks as the cash-out itself (the link is `paid` or
`offramp_failed`, the anchor is healthy, the seller's anchor session is live and
their KYC is `ACCEPTED`), so what the seller sees here is what they get by
committing.

**Query parameters**
- `targetCurrency` — required, 3-letter ISO 4217 code in capitals (`NGN`, `USD`).
- `withdrawType` — optional SEP-6 withdrawal type from
  [`offramp-requirements`](#get-linksidofframp-requirements).

```
GET /links/lnk_y70hu7frwy/cash-out/quote?targetCurrency=NGN
```

**200** — an `OffRampQuote`
```json
{
  "quoteId": "quote_e6g30i3n8d",
  "sourceAsset": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  "sourceAmount": "10.5",
  "targetCurrency": "NGN",
  "targetAmount": "17325.00",
  "rate": "1650",
  "expiresAt": 1792938957657,
  "fee": { "amount": "173.25", "currency": "NGN", "source": "estimated" },
  "netTargetAmount": "17151.75",
  "quoteKind": "firm"
}
```
- `sourceAmount` is what the buyer paid (`paidAmount`, falling back to the link
  amount). `targetAmount` is the gross amount before the fee and
  `netTargetAmount` is what the seller receives.
- `rate` is units of `targetCurrency` per 1 unit of the source asset
  (`targetAmount = sourceAmount * rate`).
- `expiresAt` is epoch milliseconds; after it the quote is void.
- `fee.source` is `anchor` when the anchor stated the fee and `estimated` when it
  was computed.
- `quoteKind` is `firm` when the anchor quoted the number (SEP-38) and
  `indicative` when Quay computed it from a configured rate and the fees the
  anchor publishes. Show an `indicative` figure as an estimate. See
  [`POST /links/:id/cash-out`](#post-linksidcash-out).
- Pass `quoteId` to `POST /links/:id/cash-out` to initiate against exactly this
  quote.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_query` | `targetCurrency` is missing (`message`) or not a 3-letter code (`issues`) | Fix the query |
| `400` | `unknown_withdraw_type` | `withdrawType` is not offered by the anchor; body has `availableTypes` | Pick one of `availableTypes` |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `links:read` | Use a key with the scope |
| `403` | `anchor_auth_required` | The seller has no live anchor session (real anchor only) | Connect to the anchor, see [`/seller/anchor-auth`](#selleranchor-auth) |
| `403` | `kyc_required` | The seller's SEP-12 status is not `ACCEPTED` (real anchor only) | Finish verification, see [`GET /seller/kyc`](#get-sellerkyc) |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |
| `409` | `Link must be paid to cash out (is "<status>")` | The link is not `paid` or `offramp_failed` | Wait until it is paid |
| `422` | `offramp_rejected` | The anchor refused on its merits: amount outside its limits, unsupported pair, or a withdraw type is needed. Body has `message`, `limits` (`minAmount`, `maxAmount`) and `availableTypes`, and may carry `anchorType` and `fields` | The seller's to fix; do not retry unchanged. Does not count towards the circuit breaker |
| `501` | `offramp_disabled` | `OFFRAMP=none` | Do not retry; hide cash-out |
| `502` | `anchor_error` | The anchor failed or was unreachable | Retry later |
| `503` | `anchor_unavailable` | The anchor is marked unhealthy (circuit breaker open) and no call was made | Retry after a short delay |

---

## `POST /links/:id/cash-out`

**Requires auth** and the `offramp:initiate` scope (404 if the link belongs to a
different seller). Seller-initiated off-ramp of a **paid** link to local
currency. Runs `quote → initiate` against the off-ramp adapter and moves the
link to `offramp_pending`; a background poller advances it to `offramp_settled`
or `offramp_failed`. Honours the `Idempotency-Key` header: a retry with the same
key and body replays the first response and starts no second withdrawal (see
[Idempotency](#idempotency)). Uses the strict rate limit.

> Which adapter answers depends on `OFFRAMP`. The default for local development
> is `MockAnchorOffRamp`: it simulates a quote and a payout and **moves no
> money**. The public testnet deployment runs `OFFRAMP=testanchor`, a real
> SEP-10 → SEP-38 → SEP-6 flow against the Stellar testnet reference anchor
> (still no real money). Mainnet runs `OFFRAMP=none`.

**Request**
```json
{
  "targetCurrency": "NGN",
  "payoutFields": { "type": "bank_account", "dest": "0123456789", "dest_extra": "058" },
  "quoteId": "quote_e6g30i3n8d",
  "withdrawType": "bank_account"
}
```
- `targetCurrency` — 3-letter ISO 4217 code in capitals; defaults to `NGN`.
- `payoutFields` — string map handed to the anchor. Use the `descriptors` from
  [`offramp-requirements`](#get-linksidofframp-requirements) as the keys. Fields
  saved by an earlier cash-out (when the deployment keeps them, see
  `savedFields`) are merged in underneath, so you only send what changed. Never used as identity data; that comes from SEP-12.
- `quoteId` — *optional*. The `quoteId` from `GET /links/:id/cash-out/quote`.
  When given, the withdrawal starts against exactly that quote with no re-quote;
  the quote must belong to this link, match `targetCurrency` and the paid
  amount, and not have expired. If omitted, a fresh quote is fetched (and
  re-fetched once if it arrives already expired).
- `withdrawType` — *optional* SEP-6 withdrawal type (`bank_account`, `cash`, …)
  when the anchor offers several; the seller's choice, from `offramp-requirements`.
  Omitted, the adapter falls back to the operator's `OFFRAMP_TYPE`, or the
  anchor's only type.

**200** — the `mock` adapter (no `transfer`, no `interactiveUrl`)
```json
{
  "job": {
    "jobId": "ofr_5g7j614yce",
    "linkId": "lnk_y70hu7frwy",
    "status": "pending",
    "targetCurrency": "NGN",
    "targetAmount": "17325.00",
    "rate": "1650",
    "quoteExpiresAt": 1792938958071,
    "quoteExpiresInSeconds": 299,
    "quoteKind": "firm"
  }
}
```

**200** — a real SEP-6 anchor that has named its deposit account (`transfer`
present; the values are illustrative)
```json
{
  "job": {
    "jobId": "ofr_...",
    "linkId": "lnk_...",
    "status": "awaiting_transfer",
    "targetCurrency": "USD",
    "targetAmount": "5.00",
    "rate": "1",
    "quoteExpiresAt": 1750000300000,
    "quoteExpiresInSeconds": 298,
    "quoteKind": "firm"
  },
  "transfer": {
    "destination": "GANCHOR...",
    "amount": "5",
    "asset": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    "memo": "4242",
    "memoType": "id"
  }
}
```

**`job` fields**
- `jobId`, `linkId` — the cash-out job and its link.
- `status` — `"awaiting_transfer"` (the anchor is waiting for the seller's
  on-chain transfer), `"pending"` (processing), `"settled"` or `"failed"`.
  The link's `offrampStatus` mirrors it.
- `targetAmount` — gross amount in `targetCurrency` before the fee; `rate` is
  target units per 1 source unit.
- `quoteExpiresAt` (epoch ms) and `quoteExpiresInSeconds` (rounded down, never
  negative) — when the quote the withdrawal was started on stops being valid.
- `quoteKind` — `firm` when the anchor quoted the number itself (SEP-38),
  `indicative` when Quay computed it from a configured rate source plus the fees
  the anchor published in `/sep6/info` (issue 3.22). Real anchors mostly have no
  SEP-38, so expect `indicative` there; an indicative `targetAmount` is not the
  anchor's final say, so show it as an estimate before the seller commits (the
  dashboard does).

**How the seller finishes: `transfer`, `interactiveUrl`, or neither.** The
response carries at most one of the two top-level fields.

| Response has | Meaning | `job.status` | What the client does |
| --- | --- | --- | --- |
| `transfer` | A SEP-6 anchor has named its deposit account. The seller's own wallet must pay `amount` of `asset` to `destination` with exactly this memo; the anchor pays out only after it sees that payment. Quay cannot send it. | `awaiting_transfer` | Build, sign and submit the payment from the seller's wallet, then optionally call [`transfer-sent`](#post-linksidcash-outtransfer-sent) |
| `interactiveUrl` | A SEP-24 anchor needs the seller in a browser (always `https`; the dashboard refuses any other scheme). | `pending` | Open it and keep polling the link |
| neither | The anchor accepted the withdrawal but has not named a deposit account yet (a SEP-6 anchor still reviewing). The mock adapter also answers this way. | `pending` | Poll; the instructions arrive later through the `offramp.transfer_required` webhook and [`GET /links/:id/cash-out/transfer`](#get-linksidcash-outtransfer) |

The link is `offramp_pending` in all three cases, and the adapters shipped today
are SEP-6, so `interactiveUrl` is additive: a client that ignores it behaves as
before.

**`transfer.memoType` and the memo encoding.** `memo` is the anchor's value
passed through unchanged, so how to turn it into a Stellar memo depends on
`memoType`:
- `"text"` — use the string as `MEMO_TEXT` (at most 28 bytes).
- `"id"` — a decimal string, use as `MEMO_ID`.
- `"hash"` — SEP-6 anchors send a hash memo **base64-encoded** (44 characters
  for 32 bytes, e.g. `"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="`).
  The JavaScript Stellar SDK's `Memo.hash()` takes the **hex** form (64
  characters), so decode the base64 to 32 bytes and hex-encode it. The
  dashboard accepts either form (`apps/web/lib/wallet.ts`).
- `null` (both `memo` and `memoType`) — the anchor wants no memo.
Sending the wrong memo means the anchor cannot match the payment.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | Body failed validation (`issues` lists why) | Fix the request |
| `400` | `unknown_withdraw_type` | `withdrawType` is not offered; body has `availableTypes` | Pick one of `availableTypes` |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `anchor_auth_required` | The seller has no live anchor session (real anchor only) | Connect to the anchor, see [`/seller/anchor-auth`](#selleranchor-auth). Only their wallet can fix this |
| `403` | `kyc_required` | The seller's SEP-12 status is not `ACCEPTED` (real anchor only) | Finish verification. `payoutFields` is bank/routing info only and never used as identity |
| `404` | `not_found` | Unknown link, or another seller's link | Check the id |
| `409` | `Link must be paid to cash out (is "<status>")` | The link is not `paid` or `offramp_failed`. `offramp_settled` and every in-flight state are refused | Do not retry |
| `409` | `cashout_already_in_progress` | Another cash-out for this link is in flight or being started; concurrent requests are atomically rejected so two withdrawals cannot start | Wait, then read the link |
| `409` | `previous_withdrawal_active` | A retry from `offramp_failed` while the previous job is not stored as `failed` at the anchor | Wait for the previous job to finish failing |
| `409` | `quote_mismatch` | `quoteId` is unknown, belongs to another link, or does not match this link's currency and amount | Fetch a new quote |
| `409` | `quote_expired: Quote <id> has expired` | The quote's expiry has passed (the `error` string starts with `quote_expired`) | Fetch a new quote and retry |
| `409` | `request_in_progress` | An `Idempotency-Key` request with the same key is still running | Retry shortly with the same key |
| `409` | `idempotency_key_reuse` | The same `Idempotency-Key` was used with a different body | Use a new key |
| `422` | `offramp_rejected` | The anchor refused on its merits (amount outside its limits, asset not withdrawable, a type is needed, KYC needed first). Body has `message`, `limits` (`minAmount`, `maxAmount`) and `availableTypes`; for an anchor 400/403/422 on `/withdraw` or the quote it also has `anchorType` (for example `non_interactive_customer_info_needed`) and `fields`. The anchor's free text is never returned | The seller's to fix; not an outage and not counted by the circuit breaker |
| `501` | `offramp_disabled` | `OFFRAMP=none`: this deployment has no cash-out leg. Permanent | Do not retry |
| `502` | `anchor_error` | The anchor failed or was unreachable; `message` is fixed text such as `The anchor returned an error (SEP-6 withdraw, HTTP 500).` | Retry later |
| `503` | `anchor_unavailable` | The anchor is marked unhealthy (circuit breaker open); no call was made | Retry after a short delay |

**Retrying a failed cash-out.** A link in `offramp_failed` can be quoted
(`GET /links/:id/cash-out/quote`) and cashed out again with this same endpoint;
it moves back to `offramp_pending` with a new job id. The rate, fee and
net-amount fields of the failed attempt are cleared and replaced by the new
attempt's values. A job whose state is no longer stored (the `job_state_lost`
repair) has nothing left to be live and may be retried. The webhook payloads are
unchanged; the API log carries `event: "cashout.retry"` with `previousJobId`,
and `link.transition` carries `retry: true`. The dashboard shows "Retry
cash-out" on failed links.

---

## `GET /links/:id/cash-out/transfer`

**Requires auth** and the `offramp:initiate` scope (404 if the link belongs to a
different seller). Returns the non-custodial transfer instructions for an
`offramp_pending` link, so the seller can finish a withdrawal whose send step was
lost (modal closed, tab reloaded, wallet popup failed). Called when the seller
clicks "Send USDC to finish cash-out" on the dashboard or the link page, never
from the dashboard refresh loop. Quay only relays the instructions; the payment
is built and signed in the seller's browser.

The instructions are read from the anchor with the seller's own session. If the
anchor cannot be reached right now (offline, circuit breaker open), the copy
stored the last time it answered is returned instead.

**200**
```json
{
  "transfer": {
    "destination": "GANCHOR...",
    "amount": "5",
    "asset": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    "memo": "4242",
    "memoType": "id"
  }
}
```
The same shape and memo encoding as `transfer` in the cash-out response
(see above). `asset` is the asset the withdrawal was quoted for (stored on the
job), not something the anchor's transaction response names. `amount` is the
anchor's `amount_in` when it states one, otherwise the quoted sell amount.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `anchor_auth_required` | The seller has no live anchor session | Reconnect, see [`/seller/anchor-auth`](#selleranchor-auth) |
| `404` | `not_found` | Another seller's link, an unknown link, no cash-out job, or the anchor has not published instructions yet (a SEP-6 anchor still reviewing KYC). A `mock` cash-out never has any | Poll again later |
| `409` | `Link must be offramp_pending to fetch transfer instructions (is "<status>")` | The link is not `offramp_pending` | Nothing to send |

Sending twice is two payments: the anchor credits the withdrawal once and the
second transfer would need a manual refund. The web client therefore remembers
the hash of a completed send for the browser session and shows "Payment sent,
waiting for the anchor to see it" instead of the send button.

---

## `POST /links/:id/cash-out/transfer-sent`

**Requires auth** and the `offramp:initiate` scope (404 if the link belongs to a
different seller). The seller's browser calls it right after sending the
on-chain transfer to the anchor, with the transaction hash. Uses the strict rate
limit.

**Request**
```json
{ "hash": "<64 hex characters>" }
```

The hash is stored on the cash-out job (lowercased) as a **claim**: the server
does not treat it as proof. The reconciliation report checks it on Horizon
(`docs/RUNBOOK.md`, "Reconciliation report").

**200** — `{ "ok": true, "jobId": "ofr_...", "hash": "<the lowercased hash>" }`. Repeating the same hash is a no-op.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | Not a 64-character hex hash (`issues` lists why) | Send the Stellar transaction hash |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `404` | `not_found` | Unknown link or another seller's link | Check the id |
| `409` | `no_cashout_in_progress` | The link has no cash-out job | Cash out first |
| `409` | `transfer_already_recorded` | A different hash was already reported; the first claim is kept so a duplicate transfer stays visible | Contact the operator if two transfers were really sent |

---

## `/seller/anchor-auth`

**Requires auth** and the `offramp:initiate` scope (an API key without it gets
`403 missing_scope`). The seller's own SEP-10 session with the anchor. An anchor
knows its customer by the Stellar account that signed in, so each seller signs
the anchor's challenge with **their own wallet**: the anchor's customer is the
seller, never Quay. Quay fetches and verifies the challenge (issued by the
anchor's published `SIGNING_KEY`, for this seller's account, on our network),
relays the signed transaction, and keeps the anchor's JWT encrypted at rest so
the cash-out poller can follow withdrawals. The JWT can read/update the
seller's KYC and start a withdrawal; it cannot move funds. It is never returned
to the client.

The two `POST` routes use the strict per-seller rate limit
(`RATE_LIMIT_STRICT_WINDOW_MS` / `RATE_LIMIT_STRICT_MAX`, default 20 requests
per 60 seconds). The bucket is keyed by the authenticated seller ID, so one
seller cannot consume another seller's budget by changing IPs or API keys. When
`REDIS_URL` is configured, the counters are shared across API instances. `GET`
and `DELETE` remain on the global per-IP limit.

The flow is `GET /seller/anchor-auth` (is there a session?), then
`POST /seller/anchor-auth/challenge`, a wallet signature, and
`POST /seller/anchor-auth`. Every method below also returns `401 unauthorized`
without a credential and `403 missing_scope` for a key without
`offramp:initiate`.

### `GET /seller/anchor-auth`

Whether the seller has a live session with the anchor.

**200**
```json
{ "required": true, "connected": false, "anchor": "testanchor.stellar.org", "expiresAt": null }
```
```json
{ "required": true, "connected": true, "anchor": "testanchor.stellar.org", "expiresAt": 1750003600000 }
```
- `required: false` means the deployment has no real anchor (`mock` or `none`):
  there is nothing to connect to, and `connected` is `false`, `anchor` is
  `null`. Skip the rest of this section.
- `expiresAt` is epoch milliseconds, `null` when there is no live session. A
  lapsed session needs a fresh challenge; until then cash-out answers
  `403 anchor_auth_required`.

No route-specific errors.

### `POST /seller/anchor-auth/challenge`

Fetches the anchor's SEP-10 challenge for the seller's own account and verifies
it before returning it. No request body.

**200**
```json
{ "transaction": "AAAAAgAAAAA...", "networkPassphrase": "Test SDF Network ; September 2015" }
```
Have the seller's wallet sign `transaction` for `networkPassphrase`. **Never
submit it to the network**: it is a login proof, it has a sequence number of 0
and moves no funds. Then send the signed XDR to `POST /seller/anchor-auth`.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `404` | `no_anchor` | The deployment has no real anchor (`required: false`) | Nothing to connect to |
| `429` | `rate_limited` | The strict per-seller limit was exceeded | Wait for `retry-after` |
| `502` | `challenge_rejected` | The anchor's challenge failed verification. `message` is fixed text for one of: wrong network, wrong account, the anchor refused, the anchor could not be verified, or the challenge was invalid. The anchor's own wording is logged, not returned | Retry later; if it persists the anchor is misconfigured |
| `502` | `anchor_error` | The anchor failed or was unreachable while serving the challenge | Retry later |

### `POST /seller/anchor-auth`

Relays the wallet-signed challenge and stores the anchor's JWT. The signed
transaction is verified again first: it must still be the anchor's challenge, for
this seller's account.

**Request**
```json
{ "transaction": "<signed XDR>" }
```

**200**
```json
{ "connected": true, "anchor": "testanchor.stellar.org", "expiresAt": 1750003600000 }
```
`expiresAt` is epoch milliseconds. A cash-out poll that was waiting on this
seller's expired session resumes right away.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | `transaction` is missing or empty (`issues` lists why) | Send the signed XDR |
| `400` | `challenge_rejected` | The signed transaction is not the anchor's challenge for this seller's account. `message` is fixed text: wrong network, wrong account, the anchor refused the signed challenge, the anchor could not be verified, or invalid | Request a new challenge and sign again |
| `404` | `no_anchor` | The deployment has no real anchor | Nothing to connect to |
| `429` | `rate_limited` | The strict per-seller limit was exceeded | Wait for `retry-after` |
| `502` | `anchor_error` | The anchor failed or was unreachable when the signed challenge was posted | Retry later |

### `DELETE /seller/anchor-auth`

Forgets the seller's anchor session. Cash-out and KYC then answer
`403 anchor_auth_required` until the seller connects again. Also happens
automatically on logout and when the seller changes wallet. No request body.

**204** — no content (also when there was no session, and on a deployment with
no real anchor).

No route-specific errors.

---

## `GET /seller/kyc`

**Requires auth** and the `offramp:initiate` scope. Current SEP-12 requirements
and status for the seller (`OFFRAMP=mock` always reports `ACCEPTED` — there's no
real anchor to satisfy). The status is served from a short cache
(`KYC_STATUS_CACHE_MS`, default 60 seconds); add `?refresh=1` (or `refresh=true`)
to re-sync from the anchor now. Responses are `Cache-Control: no-store`. An API
key gets `providedFields: {}`: the values are only returned to a signed-in
session.

**200**
```json
{
  "status": "NEEDS_INFO",
  "requiredFields": [
    { "name": "first_name", "type": "string", "optional": false },
    { "name": "email_address", "type": "string", "optional": false }
  ],
  "providedFields": { "first_name": "Ada" },
  "message": null,
  "lastSyncedAt": 1750000000000
}
```
`status` is one of `unsubmitted | NEEDS_INFO | PROCESSING | ACCEPTED | REJECTED`.

`unsubmitted` means the anchor has no customer for the seller's account. If a stored customer id is no longer
known to the anchor (it returns 404 for it), Quay retries by account, keeps the id the anchor returns, and logs
`kyc.customer_id.stale` (no PII) rather than reporting the seller as new. A status the anchor sends that Quay does not
model is treated as `PROCESSING` and logged as `kyc.status.unknown` with the raw status string only.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `anchor_auth_required` | The seller has not signed in to the anchor, or the session lapsed | Connect, see [`/seller/anchor-auth`](#selleranchor-auth) |
| `502` | `anchor_error` | The anchor failed or was unreachable; `message` is fixed text, never the anchor's own | Retry later |

---

## `PUT /seller/kyc`

Submit or update identity fields. Values are sent to the anchor **exactly as
given** — no field is ever defaulted or fabricated. Call with `{}` to kick off
discovery before any fields are known.

On a seller's first submission (when the anchor has not yet revealed its requirements
and `requiredFields` is empty), no profile fields are transmitted to the anchor without
prior active consent. Calling with `{}` (or providing fields without prior consent)
performs discovery: no profile fields are sent, and the response returns the anchor's
discovered `requiredFields` so the seller can review and consent via `POST /seller/kyc/consent`
before submitting. If active consent already exists covering specific fields, only those
consented fields are transmitted.

**Requires auth** and the `offramp:initiate` scope. Uses the strict per-seller
rate limit.

**Request** — a flat map of SEP-9 field names to string values. Names match
`^[a-z0-9_.]{1,64}$`, values are at most 1,000 characters, and at most 50 fields
are accepted.
```json
{ "first_name": "Ada", "email_address": "ada@example.org" }
```

**200** — same shape as `GET /seller/kyc`, reflecting the anchor's response
(which may reveal further required fields — SEP-12 discovery is progressive).

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | A field name or value is out of bounds, or there are more than 50 fields (`issues` lists why) | Fix the request |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `anchor_auth_required` | No live anchor session | Connect, see [`/seller/anchor-auth`](#selleranchor-auth) |
| `403` | `consent_required` | A field about to be sent is not covered by an active consent (`anchorDomain` and `fields` included); see below | `POST /seller/kyc/consent`, then retry |
| `422` | `kyc_required` | A field the anchor is known to require is missing; `missingFields` names exactly which, never a placeholder | Collect and send those fields |
| `429` | `rate_limited` | The strict per-seller limit was exceeded | Wait for `retry-after` |
| `502` | `anchor_error` | The anchor failed or was unreachable | Retry later |

```json
{ "error": "kyc_required", "missingFields": ["email_address"] }
```

---

## `GET /seller/kyc/disclosures`

List the authenticated seller's recorded SEP-12 disclosures by anchor. Requires a
seller session and `offramp:initiate` scope; API keys are rejected. Each entry
contains `anchorDomain`, `status`, `consent` (`grantedAt` and `revokedAt`, or
`null` if the seller never consented), and `fields` with only `name`, `sentAt`
(epoch milliseconds), and `anchorStatus`. The response never contains field
values or anchor error text. Send times are recorded for successful submissions
made after this endpoint is deployed; older sends cannot be dated reliably and
are omitted. The body is a bare array, empty when nothing was ever sent.

**200**
```json
[
  {
    "anchorDomain": "testanchor.stellar.org",
    "status": "ACCEPTED",
    "fields": [
      { "name": "email_address", "sentAt": 1750000000000, "anchorStatus": "ACCEPTED" },
      { "name": "first_name", "sentAt": 1750000000000, "anchorStatus": "ACCEPTED" }
    ],
    "consent": { "grantedAt": 1749999990000, "revokedAt": null }
  }
]
```
`anchorStatus` is one of `ACCEPTED`, `REJECTED`, `PROCESSING`, `NEEDS_INFO`,
`VERIFICATION_REQUIRED` or `UNKNOWN`. `status` is `unsubmitted` if no KYC record
is left for that anchor.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `forbidden` | An API key was used | Use a seller session |

## `DELETE /seller/kyc/disclosures/:anchorDomain`

Revoke consent, request [SEP-12 customer deletion](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md#customer-delete)
at the configured anchor using the seller's own SEP-10 session, then erase the
local KYC record and disclosure metadata for that anchor. Requires a seller
session and `offramp:initiate` scope; API keys are rejected. The path must equal
the configured anchor domain; arbitrary anchor URLs are never accepted. A
successful response contains `anchorResult` (`deleted` or `not_found`) and
`localDataErased: true`. If anchor authentication or deletion fails, local
erasure is not reported as complete. This does not erase the seller's separate
reusable profile or data held by another anchor.

**200**
```json
{ "anchorDomain": "testanchor.stellar.org", "anchorResult": "deleted", "localDataErased": true }
```

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `forbidden` | An API key was used | Use a seller session |
| `403` | `anchor_auth_required` | No live anchor session, so the anchor cannot be asked to delete | Connect, then retry. The consent was already revoked; local KYC data is kept |
| `404` | `anchor_unavailable` | `anchorDomain` is not the configured anchor, or the deployment has no real anchor | Use the anchor domain from `GET /seller/anchor-auth` |
| `500` | `internal_error` | The anchor call failed unexpectedly; local erasure is not reported as complete | Retry |

## `GET /seller/kyc/consent`

List all consent records (active and revoked) for the authenticated seller.

**Requires auth.** Session authentication only — API keys are rejected.

**200**
```json
{
  "consents": [
    {
      "id": "cnc_1",
      "anchorDomain": "testanchor.stellar.org",
      "fields": ["first_name", "last_name", "email_address"],
      "grantedAt": 1750000000000,
      "revokedAt": null,
      "grantedVia": "session",
      "noticeVersion": "1.0"
    }
  ]
}
```
`revokedAt` is `null` for active consents, an epoch-ms timestamp when revoked.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `forbidden` | An API key was used | Use a seller session |

---

## `POST /seller/kyc/consent`

Grant consent to share specific identity fields with an anchor. The server
re-derives the fields the anchor currently requires from the latest KYC record
and refuses any mismatch — the UI cannot consent to fields the anchor did not
ask for. All required fields must be covered; optional fields may be omitted.

**Requires auth.** Session authentication only — API keys are rejected.

**Request**
```json
{ "anchorDomain": "testanchor.stellar.org", "fields": ["first_name", "last_name", "email_address"] }
```

**201** — consent granted
```json
{
  "id": "cnc_2",
  "anchorDomain": "testanchor.stellar.org",
  "fields": ["first_name", "last_name", "email_address"],
  "grantedAt": 1750000001000,
  "revokedAt": null,
  "grantedVia": "session",
  "noticeVersion": "1.0"
}
```

**400** — validation errors
- `{ "error": "invalid_fields", "message": "Consent request includes fields the anchor does not currently require", "fields": ["phone_number"] }`
- `{ "error": "missing_required_fields", "message": "Consent must cover all required fields", "fields": ["last_name"] }`

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `400` | `invalid_body` | `anchorDomain` is missing or `fields` is empty (`issues` lists why) | Fix the request |
| `400` | `invalid_fields` | A listed field is not one the anchor currently requires (`fields` names them) | Remove those fields |
| `400` | `missing_required_fields` | A required field is not covered (`fields` names them) | Add those fields |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `forbidden` | An API key was used | Use a seller session |
| `403` | `anchor_auth_required` | No live anchor session, so the anchor's current requirements cannot be read | Connect, then retry |
| `502` | `anchor_error` | The anchor failed or was unreachable | Retry later |

---

## `DELETE /seller/kyc/consent/:anchorDomain`

Revoke the active consent for an anchor. Revocation stops future data sends to
that anchor; it does not erase data already held by the anchor (see issue 4.28).

**Requires auth.** Session authentication only — API keys are rejected.

**200**
```json
{
  "revoked": true,
  "anchorDomain": "testanchor.stellar.org",
  "note": "Revocation stops future data sends to this anchor. It does not erase data already held by the anchor (see issue 4.28)."
}
```
Revoking when there is no active consent still returns `200`.

| Status | `error` | When | What the client should do |
| --- | --- | --- | --- |
| `401` | `unauthorized` | No or invalid credential | Sign in again |
| `403` | `missing_scope` | API key lacks `offramp:initiate` | Use a key with the scope |
| `403` | `forbidden` | An API key was used | Use a seller session |

---

## `PUT /seller/kyc` — consent enforcement

Submit or update identity fields. **Before any field is sent to the anchor, the
server checks that every field about to be sent is covered by an active consent
for that anchor.** If any field lacks consent, the request is rejected with
`403 consent_required`.

**First-submission behavior:** When an anchor's required fields are not yet known
(`requiredFields` is empty), fields provided in the request body are not forwarded to
the anchor unless active consent covers them. Without active consent, the call acts
as discovery (identical to `PUT {}`), sending no profile fields and returning the
anchor's requirements without leaking unconsented data. Once requirements are discovered
and consent is granted via `POST /seller/kyc/consent`, subsequent submissions enforce
consent against all required fields.

**403**
```json
{ "error": "consent_required", "anchorDomain": "testanchor.stellar.org", "fields": ["last_name", "email_address"] }
```
The `fields` array names exactly which fields lack consent. The seller must
grant consent via `POST /seller/kyc/consent` before retrying.

**422** — same as before when a required field is missing from the request body.

---

## `PUT /seller/kyc/files`

Upload identity documents (e.g. passport or ID photos) required by the anchor for SEP-12 KYC verification.
Files stream directly to the anchor and are immediately discarded; file contents are never stored on disk
or in the database.

**Requires auth.** Session authentication only (`403` for API keys). Requires `offramp:initiate` scope.

**Request**
`Content-Type: multipart/form-data`
Multipart body containing one file per requested binary field (e.g. `photo_id_front`, `photo_id_back`).
Individual file sizes and overall payload size are capped at `KYC_MAX_UPLOAD_BYTES` (default 10 MiB).
Allowed MIME types: `image/jpeg`, `image/png`, `application/pdf`.

**200**
```json
{
  "status": "PROCESSING",
  "requiredFields": [],
  "providedFields": ["photo_id_front", "photo_id_back"],
  "message": null,
  "lastSyncedAt": 1750000000000
}
```

| Status | `error` | When |
| --- | --- | --- |
| `400` | `invalid_body` | Request body could not be parsed as multipart form data |
| `400` | `no_files` | No files were attached to the request |
| `400` | `unrequested_field` | An uploaded field is not among the anchor's requested binary fields (`field` included) |
| `400` | `too_many_files` | Multiple files uploaded for the same field name (`field` included) |
| `400` | `invalid_file` | Uploaded entry is not a file (`field` included) |
| `400` | `invalid_mime_type` | File MIME type is not allowed (must be JPEG, PNG, or PDF; `field` and `mimeType` included) |
| `401` | `unauthorized` | Missing, expired, or invalid session token |
| `403` | `forbidden` | Request made using an API key (`"file uploads require session authentication"`) |
| `403` | `anchor_auth_required` | Seller does not have an active SEP-10 anchor session |
| `403` | `consent_required` | Seller has not granted consent for the uploaded fields to be sent to the anchor (`anchorDomain` and `fields` included) |
| `413` | `payload_too_large` | Overall body or individual file exceeds maximum permitted upload size |
| `422` | `kyc_required` | Anchor requires additional fields (`missingFields` included) |
| `502` | `anchor_error` | Anchor rejected the upload or was unreachable |

---

## `GET /seller/profile`

The seller's reusable identity profile: the values they own, independent of any
anchor. One entry per SEP-9 field, using the canonical SEP-9 name (an alias such
as `first_name` is stored as `given_name`).

**Requires auth.** Session authentication only — API keys get `403`, because the
profile is the seller's own identity data. Values are stored encrypted
(AES-256-GCM, the same key as the SEP-12 KYC record) and are decrypted only to
answer this request.

**200**
```json
{
  "fields": [
    { "field": "birth_date", "value": "1815-12-10", "source": "seller", "updatedAt": 1750000000000 },
    { "field": "given_name", "value": "Ada", "source": "migrated_from_seller_kyc", "updatedAt": 1749000000000 }
  ]
}
```
`source` is `seller` (typed by the seller) or `migrated_from_seller_kyc` (lifted
from the older per-seller KYC record at boot). `updatedAt` is the last time the
value changed; saving the same value again does not move it.

**403** — `{ "error": "forbidden", ... }` for API-key auth.
**503** — `{ "error": "profile_unavailable", ... }` when the deployment has no real
anchor or no `KYC_ENCRYPTION_KEY`, so there is nowhere to keep encrypted values.

---

## `PUT /seller/profile`

Store or update profile fields. The body is a flat map of SEP-9 field name to
string value, the same shape as `PUT /seller/kyc`. Every value is validated with
the SEP-9 validators (country codes, dates, phone numbers, email, choices, ...)
and **nothing is written unless every field is valid**.

**Requires auth.** Session authentication only — API keys get `403`.

**Request**
```json
{ "given_name": "Ada", "birth_date": "1815-12-10", "address_country_code": "GBR" }
```

**200** — the full profile, same shape as `GET /seller/profile`.

**422** — `invalid_fields`, with a reason for each rejected field:
```json
{
  "error": "invalid_fields",
  "fields": {
    "birth_date": "expected a real YYYY-MM-DD date",
    "favourite_colour": "not a SEP-9 field",
    "photo_id_front": "binary fields are not accepted"
  }
}
```
Unknown field names, binary-typed fields (binary data is never persisted) and
empty values are rejected alongside format errors.

**400** — `invalid_body` when the body is not a map of strings.

---

## `POST /anchor-callbacks/sep12/:anchorDomain/:token`

Receives the anchor's SEP-12 push when a seller's KYC status changes, so a decision made overnight
is visible without the seller reloading. **Called by the anchor, not by a browser or an API client:**
there is no session or API key. The anchor is given this URL when Quay registers it with
`PUT [KYC_SERVER]/customer/callback`, using the seller's own anchor session. Registration happens
after a successful `PUT /seller/kyc` and on the first status read that yields a customer id. It is
skipped, with a log line, when the API's public origin is `localhost`. Polling `GET /seller/kyc`
keeps working when no callback arrives.

`:token` is a random per-seller value. Only its SHA-256 hash is stored (on the `seller_kyc` row), so the
URL identifies the seller and cannot be guessed. `:anchorDomain` must be the anchor that token was issued for.

The request must carry the anchor's signature in `Signature: t=<unix-seconds>, s=<base64>` (the deprecated
`X-Stellar-Signature` header is also accepted), over `<t>.<host>.<body>`, verifiable with the `SIGNING_KEY`
in that anchor's `stellar.toml`. A timestamp more than 120 seconds from now is refused. The body is the
SEP-12 `GET /customer` response; its `id` must equal the stored customer id.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "ok": true }` | KYC record updated: `status`, required fields, per-field status, `message` |
| 400 | `{ "error": "invalid_json" }` / `{ "error": "invalid_body" }` | Signed, but not a usable SEP-12 customer body. Nothing is changed |
| 400 | `{ "error": "customer_id_mismatch" }` | Body `id` is not this seller's customer |
| 400 | `{ "error": "unknown_anchor" }` / `{ "error": "missing_anchor_signing_key" }` | The anchor's `stellar.toml` or signing key could not be resolved |
| 401 | `{ "error": "missing_signature" }` / `{ "error": "invalid_signature" }` | No signature, a bad or stale one |
| 404 | `{ "error": "invalid_callback_token" }` | Unknown token, or a token used under a different anchor. No `stellar.toml` is fetched in either case |

---

## `POST /api-keys`

Create an API key for the authenticated seller. Plaintext keys are returned **once** upon creation
and are never stored or displayed again (the database stores only an scrypt hash and a 16-character
searchable prefix).

**Requires auth.** Requires the `api-keys:manage` scope. Protected by `strictRateLimit`.

**Request**
```json
{
  "name": "Backend service",
  "env": "live",
  "scopes": "links:read,links:write"
}
```
- `name` — required, string (1–120 characters).
- `env` — optional, `"live"` (default) or `"test"`. Cosmetic prefix tag (`ak_live_...` vs `ak_test_...`).
- `scopes` — optional, comma-separated list of scopes. Defaults to `links:read,links:write,webhooks:manage`. Sensitive scopes (`offramp:initiate` and `api-keys:manage`) must be requested explicitly. When creating a key using an existing API key, requested scopes must be a subset of the calling key's scopes.

**201**
```json
{
  "id": "key_01J9...",
  "name": "Backend service",
  "prefix": "ak_live_a1B2c3D4",
  "scopes": ["links:read", "links:write"],
  "createdAt": 1750000000000,
  "key": "ak_live_a1B2c3D4xxxxxxxxxxxxxxxxxxxxxxxx"
}
```

| Status | `error` | When |
| --- | --- | --- |
| `400` | `invalid_body` | Validation failed (missing/empty name, name > 120 chars, invalid `env`, or unknown scopes) |
| `401` | `unauthorized` / `invalid_api_key` | Missing, invalid, expired, or revoked credentials |
| `403` | `missing_scope` | API key lacks `api-keys:manage` scope |
| `403` | `forbidden` | Privilege escalation: an API key requested scopes it does not hold |
| `429` | `rate_limited` | Strict rate limit exceeded |

---

## `GET /api-keys`

List all API keys for the authenticated seller. Hashes and plaintext keys are not returned.

**Requires auth.** Requires the `api-keys:manage` scope. Protected by `strictRateLimit`.

**Request**
```http
GET /api-keys HTTP/1.1
Authorization: Bearer <token>
```

**200**
```json
{
  "keys": [
    {
      "id": "key_01J9...",
      "name": "Backend service",
      "prefix": "ak_live_a1B2c3D4",
      "scopes": ["links:read", "links:write"],
      "lastUsedAt": 1750001000000,
      "createdAt": 1750000000000,
      "revokedAt": null
    }
  ],
  "availableScopes": ["links:read", "links:write", "webhooks:manage", "api-keys:manage", "offramp:initiate"],
  "defaultScopes": ["links:read", "links:write", "webhooks:manage"]
}
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` / `invalid_api_key` | Missing, invalid, expired, or revoked credentials |
| `403` | `missing_scope` | API key lacks `api-keys:manage` scope |
| `429` | `rate_limited` | Strict rate limit exceeded |

---

## `DELETE /api-keys/:id`

Revoke an API key. Revocation takes effect immediately; subsequent requests presenting the key return `401 invalid_api_key`.

**Requires auth.** Requires the `api-keys:manage` scope. Protected by `strictRateLimit`.

**Request**
```http
DELETE /api-keys/key_01J9... HTTP/1.1
Authorization: Bearer <token>
```

**200**
```json
{
  "id": "key_01J9...",
  "revokedAt": 1750002000000
}
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` / `invalid_api_key` | Missing, invalid, expired, or revoked credentials |
| `403` | `missing_scope` | API key lacks `api-keys:manage` scope |
| `404` | `not_found` | Key does not exist or does not belong to the authenticated seller |
| `409` | `already_revoked` | Key has already been revoked |
| `429` | `rate_limited` | Strict rate limit exceeded |

---

## `POST /webhooks`

**Requires auth.** Register a webhook endpoint for the authenticated seller.
The signing secret is returned **once** — store it. It is encrypted at rest (not stored
in plaintext); the API can never show it to you again after this response, only a display-only `secretLast4`.

**Request**
```json
{ "url": "https://example.com/hooks/checkout" }
```

**201**
```json
{ "id": "...", "url": "https://example.com/hooks/checkout", "secretLast4": "a1b2", "secret": "<hex>" }
```

---

## `GET /webhooks`

**Requires auth.** List registered webhooks for the authenticated seller. Secrets are
**not** returned — only `secretLast4` for display. Deleted webhooks are excluded.

**200**
```json
{
  "webhooks": [
    {
      "id": "...",
      "url": "...",
      "secretLast4": "a1b2",
      "previousSecretLast4": null,
      "previousSecretExpiresAt": null,
      "deletedAt": null,
      "createdAt": 1750000000000
    }
  ]
}
```

---

## `DELETE /webhooks/:id`

Removes a webhook (soft delete — it stops receiving events immediately, but its
delivery history remains readable via `GET /webhooks/:id/deliveries`).

**204** — no body.
**404** — `{ "error": "not_found" }` if the id doesn't exist or isn't yours.

---

## `POST /webhooks/:id/rotate-secret`

Issues a new signing secret, returned **once** just like at creation. The
previous secret keeps signing deliveries for **24 hours** after rotation (see
"Webhook delivery" below), so you can redeploy your receiver with the new
secret without dropping any events in between.

**200**
```json
{ "id": "...", "url": "...", "secretLast4": "c3d4", "secret": "<hex>" }
```

**404** — `{ "error": "not_found" }`

---

## `GET /webhooks/:id/deliveries?limit=&cursor=`

Paginated delivery history for one webhook, newest first. Works even after the
webhook has been deleted. `limit` defaults to 20, max 100.

**200**
```json
{
  "deliveries": [
    {
      "id": "whd_...",
      "webhookId": "whk_...",
      "linkId": "lnk_...",
      "event": "link.paid",
      "statusCode": 200,
      "ok": true,
      "error": null,
      "createdAt": 1750000000000
    }
  ],
  "nextCursor": "b3RoZXI"
}
```

Pass `nextCursor` back as `?cursor=` to fetch the next page; `null` means there
are no more results.

**400** — `{ "error": "invalid_query" }` if the query parameters fail validation or the cursor is malformed.
**404** — `{ "error": "not_found" }` if the id doesn't exist or isn't yours.

---

## `POST /webhooks/deliveries/:id/replay`

Manually re-queue a webhook delivery for immediate redelivery. Useful for
recovering dead-lettered entries or forcing a retry without waiting for the
next backoff window.

`:id` is the queue entry id returned in delivery metadata, or visible in
`webhook_queue.id`. Scoped to the calling seller: an entry belonging to another
merchant's webhook is reported as **404**, the same as one that does not exist.

**Behaviour by current status**

| Entry status | Effect                                          |
| ------------ | ----------------------------------------------- |
| `dead`       | Re-queued as `pending`, fresh attempt budget (`attempts = 0`), `nextAttemptAt = now`. |
| `pending`    | `nextAttemptAt` reset to now (accelerates next attempt; keeps stored attempt count). |
| `delivered`  | Re-queued as `pending`, fresh attempt budget (`attempts = 0`) (re-sends an already-delivered event). |
| `claimed`    | **409** — delivery is in-flight; wait for it to settle. |

Replay restarts the retry budget for `dead` or `delivered` entries. In `webhook_deliveries`, `attempt` starts again at 1 for the replayed run (all delivery attempts remain grouped by `queue_entry_id` and ordered by `createdAt`).

**202**
```json
{
  "id": "wqe_...",
  "webhookId": "whk_...",
  "linkId": "lnk_...",
  "event": "link.paid",
  "previousAttempts": 5,
  "status": "pending",
  "message": "Queued for immediate redelivery."
}
```
**404** — queue entry not found, or not yours.
**409** — delivery is currently in-flight.

---

## Webhook delivery

When a link changes state, the API writes a delivery row to the durable queue
and returns immediately — event emission never blocks a state transition. A
background `WebhookWorker` claims due rows and POSTs the event to each
registered URL.

### Events

| Event                   | Fired when                                          |
| ----------------------- | --------------------------------------------------- |
| `link.paid`             | a matching payment settled (exact or over)          |
| `link.underpaid`        | a payment arrived for less than requested           |
| `link.cancelled`        | seller voided the link                              |
| `link.expired`          | TTL elapsed before payment confirmed                |
| `payment.unmatched`     | a payment arrived matching an expired or cancelled link |
| `offramp.settled`       | a cash-out job settled                              |
| `offramp.failed`        | a cash-out job failed                               |
| `offramp.transfer_required` | anchor has published deposit instructions; the seller's wallet must send USDC to the anchor to fund the withdrawal |
| `kyc.accepted`          | anchor accepted seller's KYC submission             |
| `kyc.rejected`          | anchor rejected seller's KYC submission             |
| `kyc.needs_info`        | anchor requested additional/missing fields          |

### Body

#### Body for `offramp.transfer_required`
```json
{
  "event": "offramp.transfer_required",
  "data": {
    "linkId": "lnk_...",
    "reference": "...",
    "status": "offramp_pending",
    "amount": "10.50",
    "paidAmount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "txHash": null,
    "transfer": {
      "destination": "GANCHOR...",
      "amount": "10.50",
      "asset": { "code": "USDC", "issuer": "G..." },
      "memo": "withdrawal_123",
      "memoType": "text"
    },
    "jobId": "job_..."
  },
  "id": "lnk_...",
  "sentAt": "2026-06-19T12:00:00.000Z"
}
```

The `transfer` object contains the SEP-6 deposit instructions the seller's wallet must sign and submit. The integrator should display these to the seller or prompt their wallet to sign.

**Note on sensitivity:** The transfer instructions contain no secrets — they are the public anchor account and memo the payer needs. However, integrators should not expose them to anyone but the seller.

#### Payment link events (`link.*`, `offramp.settled`, `offramp.failed`)
```json
{
  "event": "link.paid",
  "data": {
    "linkId": "lnk_...",
    "reference": "...",
    "status": "paid",
    "amount": "10.50",
    "paidAmount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "txHash": "...",
    "overpaid": false
  },
  "id": "lnk_...",
  "sentAt": "2026-06-19T12:00:00.000Z"
}
```

#### KYC events (`kyc.*`)
For seller-level KYC events, `id` is the seller ID and the payload contains **no PII** (only status metadata and field names). `message` is populated only on `kyc.rejected` and is `null` for all other events:
```json
{
  "event": "kyc.needs_info",
  "data": {
    "anchorDomain": "testanchor.stellar.org",
    "status": "NEEDS_INFO",
    "previousStatus": "PROCESSING",
    "missingFields": ["id_document_front", "id_document_back"],
    "message": null
  },
  "id": "sel_...",
  "sentAt": "2026-06-19T12:00:00.000Z"
}
```

### Headers
- `x-checkout-event` — the event name.
- `x-checkout-signature` — one or more `sha256=<hex>` HMAC-SHA256 signatures of
  the **exact raw body**, comma-separated. Normally just one, signed with your
  current secret. For 24h after a secret rotation, **two** are sent (current +
  previous secret) — accept the delivery if *any* listed signature matches, so
  you can redeploy without dropping events.

### Delivery guarantees

- **Durable**: the event body is serialised once at write time and persisted in
  `webhook_queue`, so every attempt re-sends byte-identical content. A process
  crash during backoff does not lose the event — it is delivered after restart,
  and a crash mid-delivery releases its claim so another worker picks it up.
  Signing happens per attempt, which is what lets a secret rotated between
  attempts take effect.
- **At-least-once**: retried up to 5 attempts with exponential backoff + full
  jitter (base 5 s → max ceiling doubles per attempt). Make receivers idempotent.
- **Per-attempt history**: every attempt is written to `webhook_deliveries`
  (`attempt` column + `queue_entry_id`), so you can inspect exactly which
  attempts failed and why.
- **Transient failures** (network errors, `5xx`, `429`) are retried.
- **Permanent failures** (`4xx` except `429`, or an unreadable secret) are dead-lettered immediately; an unreadable secret can be fixed by rotating the secret and replaying.
- **Dead letters** are replayable via `POST /webhooks/deliveries/:id/replay`.

Return `2xx` quickly to acknowledge receipt. Long-running processing should be
done asynchronously.

For **replay protection**, reject events whose in-body `sentAt` is older than a
small window (e.g. 5 minutes). `sentAt` is inside the signed body and cannot be
forged without the secret.

### Verifying signatures

Recompute over the raw body and compare in constant time:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return header.split(",").some((part) => {
    const a = Buffer.from(part.trim());
    const b = Buffer.from(`sha256=${expected}`);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
```

---

## `GET /seller/profile/export`

Data-subject export (NDPA 2023 right of access): a machine-readable copy of
the personal data Quay holds about the authenticated seller.

**Requires auth.** Session authentication only. API keys get `403`; an
integrator's key must not be able to pull a seller's full identity. The export
is scoped to the session's own seller and cannot name another.

**Rate limit.** 5 requests per seller per hour (`429` `rate_limited` with a
`Retry-After` header afterwards). Requests that fail authentication do not
count.

**200** is `application/json`, sent as an attachment with
`Content-Disposition: attachment; filename="quay-export-<sellerId>-<YYYY-MM-DD>.json"`
and `Cache-Control: no-store`. Timestamps are ISO 8601 strings.
```json
{
  "generatedAt": "2026-10-05T12:00:00.000Z",
  "seller": { "id": "sel_...", "name": "...", "wallet": "G...", "createdAt": "..." },
  "profile": [{ "field": "given_name", "value": "Ada", "source": "seller", "updatedAt": "..." }],
  "kyc": [{
    "anchorDomain": "testanchor.stellar.org", "account": "G...", "customerId": "...", "status": "ACCEPTED",
    "message": null, "providedFields": { "first_name": "Ada" },
    "providedFieldStatus": [{ "name": "first_name", "status": "ACCEPTED", "error": null }],
    "sentFields": ["first_name"], "lastSyncedAt": "..."
  }],
  "disclosures": [{ "anchorDomain": "testanchor.stellar.org", "fieldName": "first_name", "sentAt": "..." }],
  "consents": [{
    "anchorDomain": "testanchor.stellar.org", "fields": ["first_name"],
    "grantedAt": "...", "revokedAt": null, "noticeVersion": "..."
  }],
  "anchorConnections": [{ "anchorDomain": "testanchor.stellar.org", "account": "G...", "expiresAt": "..." }],
  "payoutFields": { "bank_account_number": "..." },
  "links": [{
    "id": "...", "reference": "...", "title": "...", "amount": "10", "asset": "USDC",
    "assetIssuer": "G...", "status": "paid", "createdAt": "..."
  }],
  "payments": [{
    "linkId": "...", "txHash": "...", "payer": "G...", "amount": "10", "asset": "USDC",
    "ledger": 123, "createdAt": "..."
  }],
  "offrampJobs": [{
    "jobId": "...", "linkId": "...", "anchor": "...", "account": "G...", "targetCurrency": "NGN",
    "targetAmount": "1000", "rate": "1500", "status": "completed", "sellAsset": "USDC:G...",
    "sellAmount": "1", "sellerTxHash": null, "amountIn": null, "amountFee": null,
    "createdAt": "...", "updatedAt": "..."
  }],
  "webhooks": [{ "id": "...", "url": "https://...", "createdAt": "..." }],
  "apiKeys": [{ "id": "...", "name": "...", "scopes": ["links:read"], "createdAt": "...", "lastUsedAt": null }]
}
```

- `profile` and `kyc` are decrypted for the export. They are omitted entirely
  (not returned empty) on a deployment without a real anchor and
  `KYC_ENCRYPTION_KEY`, because that is where the encrypted stores live.
  Every other section is always present; an empty array means nothing is held.
- `payoutFields` is `null` until the seller has saved payout details.
- `webhooks` lists live webhooks; deleted ones are not included.
- **Never included:** the anchor SEP-10 token, webhook secrets, API key
  hashes or prefixes, the KYC callback token hash, the anchor's deposit
  instructions or raw error text on off-ramp jobs. Also left out because they
  are operational records rather than data about the seller: off-ramp quotes,
  webhook delivery logs, idempotency keys, watcher and telemetry state.
- Each list section is capped at 10,000 rows so one request cannot read an
  unbounded table. A section that was cut is named in a top-level
  `"truncated": ["payments", ...]` array (absent when nothing was cut).

Each export logs `event: "privacy.export"` with the `sellerId` only, never its
contents. The dashboard offers it as **Download my data**.

---

## `DELETE /seller/profile`

Right to erasure (NDPA 2023) for the authenticated seller's identity data.

**Requires auth.** Session authentication only. API keys get `403`; the
request is scoped to the session's own seller and cannot name another.

**Request**
```json
{ "confirm": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }
```
`confirm` must equal the seller's wallet address, otherwise **400**
`invalid_confirmation` and nothing is changed.

**What happens**
1. If the deployment has a real anchor, Quay asks it to erase the seller
   (`DELETE {KYC_SERVER}/customer/{account}`, SEP-12) using the seller's own
   anchor session, before that session is removed. Quay signs nothing for the
   seller. A missing session does not block local erasure.
2. In one database transaction Quay deletes the seller's `seller_profile`
   rows, `seller_kyc` rows (including the encrypted fields and the callback
   token hash), disclosure history, `kyc_consents` rows and `anchor_sessions`
   rows, and clears the saved payout fields.

**200**
```json
{
  "erased": ["profile", "kyc", "consents", "anchor_sessions", "payout_fields"],
  "anchors": [{ "anchorDomain": "testanchor.stellar.org", "result": "erased" }],
  "retained": [
    { "what": "payment history", "why": "public on the Stellar ledger" },
    { "what": "links and payment records", "why": "kept for the merchant's own accounting" },
    { "what": "seller account (wallet login identity)", "why": "deleting the account is a separate decision" },
    { "what": "database backups", "why": "expire after BACKUP_RETENTION_DAYS" }
  ]
}
```
`anchors[].result` is `erased`, `not_held` (the anchor answered 404),
`refused:<status>` or `not_attempted:no_session` (connect to the anchor and
erase again to remove what it holds). `anchors` is empty when no real anchor
is configured. The anchor may be legally required to retain KYC records.

---

## `GET /demo/link`

Public helper for the demo checkout page (`/demo`) to resolve the ID of a seeded demo link
without hardcoding. Only mounted and available when `STELLAR_NETWORK=testnet`.

**Request**
```http
GET /demo/link HTTP/1.1
```

**200**
```json
{
  "linkId": "lnk_demo_123"
}
```
*(or `{ "linkId": null }` if no demo link is seeded)*

| Status | `error` | When |
| --- | --- | --- |
| `403` | `demo endpoints are only available on testnet` | Deployment is running on public network (`pubnet`) |

---

## `POST /demo/reset`

Deletes all demo-flagged links (`is_demo = true`) belonging to the authenticated seller
and clears watcher processed transaction records for them. Only available when `STELLAR_NETWORK=testnet`.

**Requires auth.** Requires seller session or API key.

**Request**
```http
POST /demo/reset HTTP/1.1
Authorization: Bearer <token>
```

**200**
```json
{
  "ok": true,
  "deleted": 3
}
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | Missing, invalid, expired, or revoked credentials |
| `403` | `demo endpoints are only available on testnet` | Deployment is running on public network (`pubnet`) |

---

## `GET /telemetry/summary`

Operator endpoint returning aggregated off-ramp settlement statistics grouped by `(anchorDomain, corridor)`:
total count, settled count, failed count, p50 and p95 settlement latency, and mean quoted-vs-effective spread.
Gated by the `TELEMETRY_TOKEN` environment variable.

**Request**
```http
GET /telemetry/summary HTTP/1.1
Authorization: Bearer <TELEMETRY_TOKEN>
```

**200**
```json
{
  "summary": [
    {
      "anchorDomain": "testanchor.stellar.org",
      "corridor": "USDC:BRL",
      "count": 42,
      "settledCount": 40,
      "failedCount": 2,
      "latencyP50Ms": 14200,
      "latencyP95Ms": 35600,
      "meanSpread": 0.0012
    }
  ]
}
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | Missing or invalid `TELEMETRY_TOKEN` in `Authorization: Bearer` |
| `404` | `telemetry_not_enabled` | `TELEMETRY_TOKEN` is unset in the server environment |

---

## `GET /telemetry/rows`

Operator endpoint returning anonymised recent off-ramp transactions, sorted newest first.
Link IDs and seller IDs are omitted. Gated by `TELEMETRY_TOKEN`.

**Request**
```http
GET /telemetry/rows?corridor=USDC:BRL&limit=20 HTTP/1.1
Authorization: Bearer <TELEMETRY_TOKEN>
```
- `corridor` — optional query filter (e.g. `?corridor=USDC:BRL`).
- `limit` — optional integer (default 20, clamped between 1 and 100).

**200**
```json
{
  "rows": [
    {
      "anchorDomain": "testanchor.stellar.org",
      "corridor": "USDC:BRL",
      "sellAsset": "USDC",
      "sellAmount": "50.00",
      "quotedRate": "5.45",
      "effectiveRate": "5.44",
      "feeAmount": "0.50",
      "quotedAt": 1750000000000,
      "initiatedAt": 1750000010000,
      "settledAt": 1750000025000,
      "status": "settled",
      "failureReason": null
    }
  ]
}
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | Missing or invalid `TELEMETRY_TOKEN` in `Authorization: Bearer` |
| `404` | `telemetry_not_enabled` | `TELEMETRY_TOKEN` is unset in the server environment |

---

## `GET /telemetry/export.csv`

Operator endpoint returning a full anonymised CSV dump of off-ramp transactions suitable for
public dataset export. Link IDs and seller identities are omitted. Gated by `TELEMETRY_TOKEN`.

**Request**
```http
GET /telemetry/export.csv HTTP/1.1
Authorization: Bearer <TELEMETRY_TOKEN>
```

**200**
Content-Type: `text/csv; charset=utf-8`
Content-Disposition: `attachment; filename="offramp_telemetry_2026-10-18.csv"`

```csv
corridor,sell_asset,sell_amount,quoted_rate,quoted_at,initiated_at,settled_at,effective_rate,fee_amount,status
USDC:BRL,USDC,50.00,5.45,2026-10-18T08:00:00.000Z,2026-10-18T08:00:10.000Z,2026-10-18T08:00:25.000Z,5.44,0.50,settled
```

| Status | `error` | When |
| --- | --- | --- |
| `401` | `unauthorized` | Missing or invalid `TELEMETRY_TOKEN` in `Authorization: Bearer` |
| `404` | `telemetry_not_enabled` | `TELEMETRY_TOKEN` is unset in the server environment |

