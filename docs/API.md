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

---

## `POST /webhooks`

Register a webhook endpoint. The signing secret is returned **once** — store it.

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

List registered webhooks. Secrets are **not** returned.

**200**
```json
{ "webhooks": [ { "id": "...", "url": "...", "createdAt": 1750000000000 } ] }
```

---

## `POST /webhooks/deliveries/:id/replay`

Manually re-queue a webhook delivery for immediate redelivery. Useful for
recovering dead-lettered entries or forcing a retry without waiting for the
next backoff window.

`:id` is the queue entry id returned in delivery metadata, or visible in
`webhook_queue.id`.

**Behaviour by current status**

| Entry status | Effect                                          |
| ------------ | ----------------------------------------------- |
| `dead`       | Re-queued as `pending`, `nextAttemptAt = now`.  |
| `pending`    | `nextAttemptAt` reset to now (accelerates next attempt). |
| `delivered`  | Re-queued as `pending` (re-sends an already-delivered event). |
| `claimed`    | **409** — delivery is in-flight; wait for it to settle. |

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
**404** — queue entry not found.
**409** — delivery is currently in-flight.

---

## Webhook delivery

When a link changes state, the API writes a delivery row to the durable queue
and returns immediately — event emission never blocks a state transition. A
background `WebhookWorker` claims due rows and POSTs the event to each
registered URL.

### Events

| Event             | Fired when                                  |
| ----------------- | ------------------------------------------- |
| `link.paid`       | a matching payment settled (exact or over)  |
| `link.underpaid`  | a payment arrived for less than requested   |
| `offramp.settled` | a cash-out job settled                       |
| `offramp.failed`  | a cash-out job failed                        |

### Body
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

### Headers
- `x-checkout-event` — the event name.
- `x-checkout-signature` — `sha256=<hex>`, an HMAC-SHA256 of the **exact raw body**
  using your webhook secret.

### Delivery guarantees

- **Durable**: the event body is serialised and signed once at write time and
  persisted in `webhook_queue`. A process crash during backoff does not lose the
  event — it will be delivered after restart.
- **At-least-once**: retried up to 5 attempts with exponential backoff + full
  jitter (base 5 s → max ceiling doubles per attempt). Make receivers idempotent.
- **Per-attempt history**: every attempt is written to `webhook_deliveries`
  (`attempt` column + `queue_entry_id`), so you can inspect exactly which
  attempts failed and why.
- **Transient failures** (network errors, `5xx`, `429`) are retried.
- **Permanent failures** (`4xx` except `429`) are dead-lettered immediately.
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
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```
