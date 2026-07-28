# HTTP API

The API is served by `@checkout/api` (Hono) on `http://localhost:8787` by default
(`API_PORT`). All request and response bodies are JSON.

> **Auth:** `POST /auth` issues a session JWT after a wallet-signed SEP-10
> challenge; a seller row is created for the wallet on first login. **`/links`
> and `/webhooks` now require it** — every route under those two prefixes needs
> `Authorization: Bearer <token>` (or the httpOnly `session` cookie set by
> `POST /auth`) and returns `401` without one. There is currently no web UI to
> obtain a token (that needs a wallet-connect button — tracked separately), so
> the demo dashboard will need one wired up before it can create/list links
> again post-upgrade. See `apps/web/lib/api.ts`'s `getAuthChallenge` /
> `submitAuthChallenge` for the client-side pieces already in place.

CORS is restricted to the origins in `CORS_ORIGINS` (comma-separated), with
`credentials: true` (required for the browser to send/receive the session cookie
cross-origin — so `CORS_ORIGINS` can't be `*` while auth is in use).

## Authentication

Every route marked **Requires auth** below needs `Authorization: Bearer <token>`
(from `POST /auth`) or the httpOnly `session` cookie it also sets.

- **401 `unauthorized`** — you're not authenticated at all: no token, or one
  that's missing, malformed, tampered, expired, or revoked (`POST /auth/logout`
  put its `jti` on the revocation list). The response body always has this
  shape: `{ "error": "unauthorized", "message": "<why>" }`.
- **403 `forbidden`** — you *are* authenticated, just not as the seller who
  owns the resource (e.g. someone else's link). `{ "error": "forbidden", "message": "<why>" }`.

These are deliberately different failure modes: 401 means "prove who you are
again"; 403 means "you did, and the answer is still no."

## Conventions

- Money amounts are decimal strings (e.g. `"10.50"`), validated to at most 7
  decimals. Internally compared in integer stroops, never floats.
- Errors return `{ "error": "<code>", ... }` with an appropriate HTTP status.
  Validation failures return `400` with `{ "error": "invalid_body", "issues": [...] }`.

---

## `GET /health`

Liveness + basic config echo.

**200**
```json
{ "ok": true, "network": "testnet", "sellerWallet": "G..." }
```

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
`SameSite=Lax`), for server-side/SSR requests that can't hold the token in JS memory.
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
how `packages/offramp/src/sep10.ts` discovers anchors.

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
    "status": "pending",
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

---

## `GET /links`

**Requires auth.** Lists the authenticated seller's own links only.

**200**
```json
{ "links": [ { "id": "lnk_...", "status": "paid", "...": "..." } ] }
```

---

## `GET /links/:id`

**Requires auth.** Fetch one link plus its payment request (used by the
checkout page).

**200** — same shape as the `POST /links` response.
**403** — `{ "error": "forbidden", "message": "..." }`: the link exists but
belongs to a different seller.
**404** — `{ "error": "not_found" }`

---

## `POST /links/:id/cash-out`

**Requires auth** (403 if the link belongs to a different seller). Seller-initiated off-ramp of a **paid** link to local currency. Runs
`quote → initiate` against the off-ramp adapter and moves the link to
`offramp_pending`; a background poller advances it to `offramp_settled` /
`offramp_failed`.

> The default adapter is `MockAnchorOffRamp` — it simulates an FX quote and payout
> and **moves no money**.

**Request**
```json
{
  "targetCurrency": "NGN",
  "payoutFields": { "bank": "...", "accountNumber": "..." }
}
```
- `targetCurrency` — 3-letter code, defaults to `NGN`.
- `payoutFields` — opaque string map handed to the anchor adapter.

**200**
```json
{
  "job": {
    "jobId": "ofr_...",
    "linkId": "lnk_...",
    "status": "pending",
    "targetCurrency": "NGN",
    "targetAmount": "17325.00",
    "rate": "1650"
  }
}
```
**409** — link is not in `paid` state: `{ "error": "Link must be paid to cash out (is \"pending\")" }`
**404** — `{ "error": "Link not found" }`

---

## `POST /webhooks`

**Requires auth.** Register a webhook endpoint for the authenticated seller.
The signing secret is returned **once** — store it.

**Request**
```json
{ "url": "https://example.com/hooks/checkout" }
```

**201**
```json
{ "id": "...", "url": "https://example.com/hooks/checkout", "secret": "<hex>" }
```

---

## `GET /webhooks`

**Requires auth.** Lists the authenticated seller's registered webhooks.
Secrets are **not** returned.

**200**
```json
{ "webhooks": [ { "id": "...", "url": "...", "createdAt": 1750000000000 } ] }
```

---

## Webhook delivery

When a link changes state, the API POSTs a JSON event to each registered URL:

| Event             | Fired when                                  |
| ----------------- | ------------------------------------------- |
| `link.paid`       | a matching payment settled (exact or over)  |
| `link.underpaid`  | a payment arrived for less than requested   |
| `offramp.settled` | a cash-out job settled                       |
| `offramp.failed`  | a cash-out job failed                        |

**Body**
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

**Headers**
- `x-checkout-event` — the event name.
- `x-checkout-signature` — `sha256=<hex>`, an HMAC-SHA256 of the **exact raw body**
  using your webhook secret.

Delivery is retried with exponential backoff (default 4 attempts) on transient
failures — network errors and `5xx`/`429` responses. A `4xx` (other than `429`) is
treated as permanent and not retried. Return `2xx` quickly to acknowledge receipt.

For **replay protection**, reject events whose in-body `sentAt` is older than a
small window (e.g. 5 minutes). `sentAt` is part of the signed body, so it cannot be
forged without the secret.

**Verifying** (recompute over the raw body and compare in constant time):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```
