# HTTP API

The API is served by `@checkout/api` (Hono) on `http://localhost:8787` by default
(`API_PORT`). All request and response bodies are JSON.

## Auth

Every route below requires `Authorization: Bearer ak_live_<key>` **except**
`GET /links/:id`, which is intentionally public (a buyer paying a link has no
seller credential). An invalid or missing key on a protected route returns
`401 { "error": "unauthorized" }`.

A key authenticates as exactly one seller - every other route is scoped to
that seller's own data. A link or webhook belonging to a different seller
behaves as if it doesn't exist (`404`), never `403` - the API does not
confirm that a cross-tenant id is real.

There is currently no self-serve way to create a new seller or mint
additional keys (that's issues 6.1/6.2/6.3's job - wallet-based login and
session/API-key management). On first boot, if the seeded demo seller has no
key yet, the API mints one and prints it to the server log once - store it
then, it is never shown again.

For local development only, set `SINGLE_TENANT_DEV=1` (the default in
`.env.example`) to skip the credential requirement entirely - every request
is treated as the seeded seller. This is refused at startup if
`NODE_ENV=production` is also set.

CORS is restricted to the origins in `CORS_ORIGINS` (comma-separated).

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

## `POST /links`

**Requires auth.** Create a payment link.

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

**Requires auth.** List the authenticated seller's own links - never anyone else's.

**200**
```json
{ "links": [ { "id": "lnk_...", "status": "paid", "...": "..." } ] }
```

---

## `GET /links/:id`

**Public - no auth required.** Fetch one link's checkout view (used by the
checkout page). Returns only what a buyer needs to pay and see status -
`id`, `reference`, `title`, `amount`, `asset`, `status`, `paidAmount`,
`txHash` - never `sellerId`, `destination`, or any off-ramp bookkeeping.

If a **valid `Authorization` header for the link's own owner** is included,
the full authenticated record is returned instead (same shape as `POST
/links`'s response). Any other credential (missing, invalid, or a different
seller's) is not an error here - it just falls through to the public view,
since a payment link is supposed to be viewable by anyone with the id.

**200 (public)**
```json
{
  "link": {
    "id": "lnk_...",
    "reference": "...",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "G..." },
    "status": "paid",
    "paidAmount": "10.50",
    "txHash": "..."
  },
  "request": {
    "uri": "web+stellar:pay?destination=...&amount=...&memo=...",
    "memo": "...",
    "memoType": "text"
  }
}
```
**404** — `{ "error": "not_found" }`

---

## `POST /links/:id/cash-out`

**Requires auth.** Seller-initiated off-ramp of a **paid** link to local
currency, scoped to the authenticated seller's own links - a link belonging
to someone else 404s (`Link not found`), the same as one that doesn't exist
at all. Runs
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

**Requires auth.** Register a webhook endpoint, scoped to the authenticated
seller. The signing secret is returned **once** — store it.

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

**Requires auth.** List the authenticated seller's own registered webhooks.
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
