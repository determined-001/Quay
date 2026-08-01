# Stellar Checkout

[![CI](https://github.com/determined-001/Quay/actions/workflows/ci.yml/badge.svg)](https://github.com/determined-001/Quay/actions/workflows/ci.yml)
[![Anchor Probe](https://github.com/determined-001/Quay/actions/workflows/anchor-probe.yml/badge.svg)](https://github.com/determined-001/Quay/actions/workflows/anchor-probe.yml)

Stellar Checkout is the open-source, non-custodial merchant checkout for the Stellar anchor network — the inbound counterpart to the Stellar Disbursement Platform.

**Live demo (Stellar testnet):** [dashboard](https://quay-web.vercel.app) ·
[API](https://quay-api.onrender.com/health) — create a link, pay it from any
testnet wallet with the shown memo, and watch it flip to **paid**. Cash-out runs
a real SEP-10 → SEP-38 → SEP-6 flow against `testanchor.stellar.org` (USD quotes;
testnet only, no real money moves).

[![API uptime](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-api.json)](docs/STATUS.md)
[![Web uptime](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-web.json)](docs/STATUS.md)
[![Synthetic check](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/determined-001/Quay/main/docs/uptime-badge-synthetic.json)](docs/STATUS.md)
Checked every 5 minutes — see [`docs/STATUS.md`](docs/STATUS.md) for the last 90 days.

The loop, end to end:

1. A seller creates a payment link in the dashboard (title + amount + asset).
2. The buyer opens the checkout page, scans a QR (or taps a wallet deep-link), and pays
   **USDC straight to the seller's own Stellar wallet** — nothing is custodied in between.
3. A backend worker watches the ledger, matches the incoming payment to the link by memo,
   marks it **paid**, and fires any registered webhooks.
4. When the seller wants cash, they trigger a **seller-initiated** cash-out to local currency
   through the off-ramp adapter.

This is the non-custodial version of a hosted checkout (think Stripe-style PaymentIntent),
built on the chain whose anchor network can actually settle to local rails.

---

## Quickstart (5-Minute Integration)

### 1. Install the Widget
Embed the lightweight modal checkout script tag in your HTML and attach it to any button:

```html
<!-- Include widget script -->
<script src="https://quay-web.vercel.app/widget.js"></script>

<!-- Pay button bound to link ID -->
<button data-stellar-checkout="lnk_123">Pay with USDC</button>

<!-- Or trigger programmatically in JavaScript -->
<script>
  StellarCheckout.open("lnk_123");
</script>
```

### 2. Create a Link via API
Generate a payment link from your backend server:

```bash
curl -X POST https://quay-api.onrender.com/links \
  -H "Content-Type: application/json" \
  -d '{
    "title": "T-shirt",
    "amount": "10.50",
    "assetCode": "USDC"
  }'
```

**Response (201 Created):**
```json
{
  "link": {
    "id": "lnk_123",
    "reference": "ref_abc",
    "status": "pending",
    "title": "T-shirt",
    "amount": "10.50",
    "asset": { "code": "USDC", "issuer": "GBBD456..." },
    "destination": "GAHK789..."
  },
  "request": {
    "uri": "web+stellar:pay?destination=GAHK789...&amount=10.50&memo=ref_abc",
    "memo": "ref_abc",
    "memoType": "text"
  }
}
```

### 3. Receive the Webhook
Register your endpoint to receive real-time JSON notifications when payments land on-chain:

```bash
curl -X POST https://quay-api.onrender.com/webhooks \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-domain.com/api/webhooks/checkout" }'
```

Verify incoming HMAC-SHA256 signatures (`x-checkout-signature: sha256=<hex>`) in your webhook route:

```javascript
const crypto = require("crypto");

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

---

## Why it's shaped this way

The link + checkout + on-chain payment is the easy, commodity part. The **off-ramp is the
hard 80% and the whole moat** — and it isn't a step you bolt on, it's a corridor walking back
in: FX rate risk in flight, KYC on the payout, reconciliation that proves local currency
landed, recovery when the anchor is down.

So two deliberate boundaries are baked into the architecture:

- **Off-ramp runs `seller_initiated`, not `inline`.** The seller receives the stablecoin to a
  wallet they control and cashes out as a separate, authorized action. Custody stays at the
  edges. `inline` mode (value routed through the anchor mid-flight, seller receives local
  currency directly) is what merchants ultimately want — and it is the mode that puts you in
  the money-transmission / custody box. The `OffRampPort` already models both modes; do not
  flip to `inline` until a licensed anchor relationship and a compliance story are real.

- **Ports-and-adapters everywhere.** The domain never imports a chain SDK. `RailPort`,
  `WatcherPort`, and `OffRampPort` are the seams. Today: a Stellar (SEP-7 + Horizon) rail and a
  mock anchor. Tomorrow: the same `PaymentIntent` spine behind an `adapter-gateway` (Arc/Circle)
  or a different chain — without touching the domain or the worker.

---

## Monorepo layout

```
packages/
  core/        Domain brain — entities, status machine, money math, SEP-7 builder,
               the pure payment matcher, port interfaces, zod schemas.  (29 unit tests)
  stellar/     Stellar adapter — SEP-7 rail + Horizon polling watcher (RailPort/WatcherPort).
  offramp/     Off-ramp adapter — MockAnchorOffRamp (OffRampPort, seller_initiated).  *** mock ***
apps/
  api/         Hono API + Drizzle (libSQL) + the ledger-watching worker.
  web/         Next.js (App Router) seller dashboard + buyer checkout page + widget.js.
```

`core` is the only package with business logic worth unit-testing in isolation, and it is:
money is compared in integer **stroops** (never floats), the status machine rejects illegal
transitions, the SEP-7 builder is spec-checked, and the matcher is exhaustively tested for
paid / overpaid / underpaid / wrong-asset / no-memo / unknown-reference.

---

## Run it locally

Requirements: Node 20+ and pnpm 9.

```bash
pnpm install
cp .env.example .env
```

Two processes (two terminals):

```bash
# 1) API + ledger watcher  →  http://localhost:8787
pnpm --filter @checkout/api dev

# 2) Web dashboard + checkout  →  http://localhost:3000
pnpm --filter @checkout/web dev
```

On first boot with no `DEFAULT_SELLER_WALLET` set, the API generates a **throwaway testnet
keypair**, prints it, and gives you a Friendbot link to fund it. Set `DEFAULT_SELLER_WALLET`
in `.env` to a wallet you control to reuse a stable address across restarts.

Then: open the dashboard, create a link, open its checkout page, and pay the displayed amount
of USDC **with the shown memo** from any Stellar testnet wallet. Within a poll interval the
dashboard flips the link to **paid**; hit **Cash out to NGN** to exercise the off-ramp seam.

Useful scripts (from the repo root):

```bash
pnpm typecheck   # all packages
pnpm test        # core unit tests
pnpm build       # builds the web app
pnpm sweep       # pre-entry ritual: uptime + synthetic checks against the live demo
```

---

## What's real vs. stubbed

| Piece | Status |
| --- | --- |
| SEP-7 payment-request URIs | **Real**, spec-correct (native vs issued asset, memo ≤28 bytes, %20 encoding, network passphrase). |
| Horizon payment watching + memo matching | **Real** logic against the Stellar SDK v16 API. Polling (restart-safe), idempotent via persisted cursor + processed-tx ledger. |
| Status lifecycle, webhooks (HMAC-SHA256 signed) | **Real**. |
| Persistence | **Real**, libSQL/SQLite for zero-config local dev (swap the `DATABASE_URL` for Turso/Postgres). Tables self-initialize on boot. |
| Off-ramp (`@checkout/offramp`) | **Real, opt-in.** Set `OFFRAMP=testanchor` for a genuine SEP-10 → SEP-38 → SEP-6 flow against the public Stellar testnet anchor (`https://testanchor.stellar.org`). Defaults to `OFFRAMP=mock` (`MockAnchorOffRamp`, fake FX rate, no money moves) for offline dev — the dashboard labels the cash-out button "(simulated)" whenever mock mode is active. |
| Metrics | **Real.** `GET /metrics` (Prometheus text format, `METRICS_TOKEN`-gated) — payment/webhook/anchor counters, watcher-lag and latency histograms, a circuit breaker around the off-ramp adapter. See [`docs/API.md`](docs/API.md#get-metrics) and [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json). |
| Embeddable widget (`/widget.js`) | **Real**, lightweight embeddable script rendering modal checkout. |
| Auth | **Partial.** Wallet-native login is real: `GET/POST /auth` implements the server side of SEP-10 (challenge, signature + M-of-N threshold verification via Horizon, single-use, session JWT), and `/.well-known/stellar.toml` makes it discoverable. A seller row is created for a wallet on first login, but `/links` and `/webhooks` don't check the session yet — every request still operates on the single demo seller. See [`docs/API.md`](docs/API.md#get-authaccountg). |

---

## Before you go live (the parts code can't do)

1. **Verify the USDC issuer.** `.env.example` ships placeholder Circle issuers for testnet and
   public. Confirm the current issuer for your network before relying on it — a wrong issuer
   silently matches nothing (or the wrong asset).
2. **Get a real anchor relationship first.** A checkout that dead-ends in USDC isn't the
   product. `packages/offramp/src/testanchor.ts` is a real SEP-10 → SEP-38 → SEP-6 adapter, but
   against Stellar's public *testnet reference sandbox* — not a licensed anchor. Fork its shape
   for a production adapter against a licensed Nigerian anchor's SEP endpoints, and validate the
   anchor will actually onboard you and pay out **before** building further.
3. **Don't enable `inline` off-ramp without legal review.** See the boundary note above.
4. **Wire the login through.** SEP-10 wallet login (`/auth`) works, but scope
   `/links` and `/webhooks` to the authenticated seller (from the session JWT)
   before anyone but you touches it — right now they still hit the single demo
   seller regardless of who's logged in. Add API keys for programmatic access.
5. **Multiple sellers / scale:** the watcher polls per active destination account; for many
   sellers you may want a streaming `WatcherPort` implementation (the interface already allows it).

> This README is engineering guidance, not legal advice. Money transmission is the box you do
> not want to back into by accident.

---

## Docs & contributing

- **[Architecture](docs/ARCHITECTURE.md)** — package graph, the three ports, sequence diagrams for each flow, the status machine, and how to add a new chain/anchor/rail.
- **[Triage & review SLAs](docs/TRIAGE.md)** — issue taxonomy, 48h labelling SLA, and the stale-issue policy.
- **[HTTP API reference](docs/API.md)** — endpoints, request/response shapes, and webhook delivery.
- **[SCF Build proposal](docs/PROPOSAL.md)** — the problem, the wedge, milestones, budget, traction, and risk register.
- **[Contributing](CONTRIBUTING.md)** — setup, the check suite, and PR guidelines.
- **[Security policy](SECURITY.md)** — how to report a vulnerability privately.
- **[Code of conduct](CODE_OF_CONDUCT.md)**.

Licensed under the [Apache License 2.0](LICENSE).
