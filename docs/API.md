# HTTP API

The API is served by `@checkout/api` (Hono) on `http://localhost:8787` by default
(`API_PORT`). All request and response bodies are JSON.

> **Auth:** there is currently **no authentication**. Every request operates on a
> single hard-coded demo seller. This is fine for local development and demos, not
> for production. See the README's "Before you go live" section.

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

Create a payment link.

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

List the seller's links.

**200**
```json
{ "links": [ { "id": "lnk_...", "status": "paid", "...": "..." } ] }
```

---

## `GET /links/:id`

Fetch one link plus its payment request (used by the checkout page).

**200** — same shape as the `POST /links` response.
**404** — `{ "error": "not_found" }`

---

## `POST /links/:id/cash-out`

Seller-initiated off-ramp of a **paid** link to local currency. Runs
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
**403** — `{ "error": "kyc_required" }`. Only possible with `OFFRAMP=testanchor`: the
seller's SEP-12 KYC (see below) hasn't reached `ACCEPTED` yet. `payoutFields` is
bank/routing info only — it is never used as a source of identity data.

---

## `GET /seller/kyc`

Current SEP-12 requirements and status for the seller, re-synced from the anchor
(`OFFRAMP=mock` always reports `ACCEPTED` — there's no real anchor to satisfy).

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

---

## `PUT /seller/kyc`

Submit or update identity fields. Values are sent to the anchor **exactly as
given** — no field is ever defaulted or fabricated. Call with `{}` to kick off
discovery before any fields are known.

**Request**
```json
{ "first_name": "Ada", "email_address": "ada@example.org" }
```

**200** — same shape as `GET /seller/kyc`, reflecting the anchor's response
(which may reveal further required fields — SEP-12 discovery is progressive).

**422**
```json
{ "error": "kyc_required", "missingFields": ["email_address"] }
```
Returned when a field the anchor is already known to require is missing —
naming exactly which ones, never silently substituting a placeholder.

---

## `POST /webhooks`

Register a webhook endpoint. The signing secret is returned **once** — store it.
It's encrypted at rest (not stored in plaintext); the API can never show it to you
again after this response, only a display-only `secretLast4`.

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

List registered webhooks. Secrets are **not** returned — only `secretLast4` for
display. Deleted webhooks are excluded.

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

**404** — `{ "error": "not_found" }` if the id doesn't exist or isn't yours.

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
- `x-checkout-signature` — one or more `sha256=<hex>` HMAC-SHA256 signatures of
  the **exact raw body**, comma-separated. Normally just one, signed with your
  current secret. For 24h after a secret rotation, **two** are sent (current +
  previous secret) — accept the delivery if *any* listed signature matches, so
  you can redeploy without dropping events.

Delivery is retried with exponential backoff (default 4 attempts) on transient
failures — network errors and `5xx`/`429` responses. A `4xx` (other than `429`) is
treated as permanent and not retried. Return `2xx` quickly to acknowledge receipt.

For **replay protection**, reject events whose in-body `sentAt` is older than a
small window (e.g. 5 minutes). `sentAt` is part of the signed body, so it cannot be
forged without the secret.

**Verifying** (recompute over the raw body, accept if any signature matches):

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
