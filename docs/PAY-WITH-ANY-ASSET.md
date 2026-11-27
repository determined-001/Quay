# Paying in any asset: a guide for merchants and operators

Quay allows buyers to pay for a payment link using other Stellar assets (such as XLM)
while the merchant always receives the exact asset and amount specified on the link.
This guide explains how path payments work, what the buyer experiences, what settings
control execution, and the rule for enabling this feature in production.

> [!NOTE]
> Path payments are an optional feature governed by the `PATH_PAYMENTS_ENABLED` flag.
> By default, the feature is disabled. On mainnet, it remains disabled until the
> automated testnet end-to-end verification suite passes.

---

## For Merchants

### What the merchant always receives: exact amount in the link asset

When you create a payment link for `10 USDC`, you receive **exactly 10 USDC** into your
Stellar wallet. You never receive fluctuating tokens, and you do not absorb exchange risk
or conversion fees.

This guarantee is built on Stellar's native **strict-receive path payment** mechanism
([`path_payment_strict_receive`](https://developers.stellar.org/docs/build/guides/transactions/path-payments)).
In a strict-receive operation:
1. The destination amount (`destAmount`) is fixed to the exact link balance owed.
2. Stellar's decentralized exchange (SDEX) and Automated Market Maker (AMM) liquidity pools
   convert the buyer's asset into your link asset atomically in a single ledger transaction.
3. If the conversion cannot deliver the full amount, the entire transaction fails on-chain
   and nothing moves. Under-delivery is mathematically impossible.

### What the buyer sees

When path payments are enabled and liquidity is available:
- **Asset choice:** The checkout displays a currency selector alongside the link asset.
  For example, a buyer holding XLM can choose "Pay with XLM".
- **Estimated cost & `sendMax`:** The buyer sees the estimated cost in their chosen asset
  along with a guaranteed maximum spending limit (`sendMax`). The network will never charge
  more than `sendMax`. If the order book can deliver your payment for less, the buyer keeps
  the difference.
- **Quote lifetime:** Quotes remain valid for 30 seconds (`PATH_QUOTE_TTL_MS`), with a
  live countdown timer. If the timer expires before the buyer signs, the checkout automatically
  fetches a fresh quote.

### The QR code always asks for the link asset

If the buyer chooses to pay via the QR code or clicks "Open in wallet app", the QR code
**always requests the exact link asset** (e.g. USDC).

Path payments require dynamic order-book routing, real-time slippage calculations, and
interactive quote expiration bounds. Standard mobile wallet QR codes (SEP-0007) do not
support interactive path negotiation. For safety, static QR codes always request the link
asset directly.

### Failure reasons a buyer can hit

During market volatility or low liquidity, a buyer's payment may be refused. The checkout
translates Horizon error codes into clear messages:

| Error code | Horizon cause | What it means | What the buyer sees |
| --- | --- | --- | --- |
| `price_moved` | `op_over_source_max` | The exchange price shifted on the order book while the buyer was signing, causing the required source amount to exceed `sendMax`. | *"The price changed while you were signing. Get a new price and try again."* (Checkout offers a button to refresh the quote). |
| `no_path` | `op_too_few_offers` | There is insufficient liquidity across the DEX or AMM pools to convert the required amount, or price impact exceeded safe limits. | *"There is not enough market depth to pay this in <asset> right now. Pay in <link asset> instead."* |

---

## For Operators

### Configuration and defaults

Path payments are configured in the API environment (`apps/api/src/env.ts`):

| Setting | Type / Range | Default | Purpose |
| --- | --- | --- | --- |
| `PATH_PAYMENTS_ENABLED` | Boolean (`"true"` / `"false"`) | `false` | Master switch. When `false`, `GET /links/:id/pay-options` returns `501 path_payments_disabled` and checkout offers only the link asset. |
| `PATH_PAYMENTS_MAX_SLIPPAGE_BPS` | Integer (`0` to `1000`) | `100` | Maximum slippage tolerance in basis points (100 bps = 1.00%). Added to quoted source amounts to compute `sendMax = sourceAmount * (1 + slippage)`. Values outside 0–1000 cause boot failure. |
| `PATH_QUOTE_TTL_MS` | Integer (milliseconds) | `30000` | Quote lifetime (30 seconds). Submissions at `POST /links/:id/submit` must have transaction `timeBounds.maxTime` no later than `now + PATH_QUOTE_TTL_MS + 30s` (grace period). |
| `PATH_PAYMENTS_MAX_PRICE_IMPACT_BPS` | Integer (basis points) | `300` | Maximum allowed price impact (300 bps = 3.00%). Compares a quote for the full link amount against a quote for 1% of the amount. Options exceeding this threshold are hidden to protect buyers against thin order books. |
| `PATH_PAYMENTS_SOURCE_ASSETS` | Comma-separated list | `native` | Allowlist of source assets that the API will quote for path payments. Defaults to `native` (XLM only) so deployments do not quote untrusted tokens. Format: `native,EURC:GDHU...`. |

### The Go-Live rule

> [!IMPORTANT]
> **`PATH_PAYMENTS_ENABLED` must stay OFF in production until the nightly testnet end-to-end test passes.**

Path payments interact with live liquidity pools and decentralized order books. To ensure
reliability before enabling the flag on mainnet:
1. The nightly testnet probe (`apps/api/test/live/path-payment.live.test.ts`, run via
   `.github/workflows/path-payment-probe.yml`) must run cleanly and report green.
2. The probe exercises the complete flow on testnet: self-seeding SDEX liquidity,
   generating quotes, verifying `price_moved` rejection when `sendMax` is reduced,
   submitting valid `path_payment_strict_receive` transactions, and verifying that the
   ledger watcher matches the delivered payment.
3. If the probe fails, path payments must remain disabled (`PATH_PAYMENTS_ENABLED=false`).
   When booting with `STELLAR_NETWORK=public` and `PATH_PAYMENTS_ENABLED=true`, the server
   emits a startup warning reminding operators to verify the probe.

Related guides:
- [HTTP API Reference: POST /links/:id/submit](API.md#post-linksidsubmit)
- [Operator Runbook: Nightly path payment probe](RUNBOOK.md#nightly-path-payment-probe)
- [Cashing out a payment: a guide for merchants](MERCHANT-CASH-OUT.md)
