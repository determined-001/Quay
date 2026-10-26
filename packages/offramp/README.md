# @checkout/offramp

`packages/offramp` implements the domain's `OffRampPort` interface (`@checkout/core`), providing adapter implementations that bridge Quay's non-custodial payment-link off-ramp lifecycle (`quote()`, `initiate()`, `status()`) to external Stellar anchor services. It provides `MockAnchorOffRamp` for offline local development and test suites (simulating FX rates and status transitions without moving funds or making network requests), `TestAnchorOffRamp` for real anchor integrations connecting SEP-1 discovery (`sep1.ts`), seller-delegated SEP-10 challenge authentication (`anchor-session.ts`), SEP-12 KYC customer registration (`kyc.ts`), SEP-38 / rate-source quoting (`sep38.ts`, `rates/`), and SEP-6 withdrawal initiation and transaction polling (`testanchor.ts`), as well as `AnchorOffRamp` (`anchor.ts`, SEP-24 interactive withdrawal) and `SelectingOffRamp` (`select.ts`), which routes each call to the SEP-6 or SEP-24 adapter per anchor (`OFFRAMP_PROTOCOL`: `auto` prefers SEP-6 when the anchor declares `TRANSFER_SERVER`). Under Quay's non-custodial architecture, the server never holds anchor credentials or private keys; challenge transactions and withdrawal asset transfers are signed exclusively by the seller's own wallet.

---

## SEP-6 Status Mapping

When polling an anchor for withdrawal status (`TestAnchorOffRamp.status()` in `src/testanchor.ts`), the external SEP-6 transaction status is mapped to Quay's internal `OffRampJobStatus` using `SEP6_STATUS_MAP` (and its `Sep6TransactionStatus` type) in `src/testanchor.ts`:

| SEP-6 Transaction Status | Job Status (`OffRampJobStatus`) | Seller Action Needed (`needsSellerAction`) | Terminal? | Behavior / Fallback Reason |
| --- | --- | --- | --- | --- |
| `pending_anchor` | `pending` | No | No | Anchor is processing the withdrawal. |
| `pending_user_transfer_start` | `awaiting_transfer` | No | No | Anchor is waiting for user transfer. Relays deposit instructions (`transfer`) if `withdrawAnchorAccount` is published. |
| `pending_user_transfer_complete` | `pending` | No | No | User transfer submitted/received on-chain, pending anchor confirmation. |
| `pending_external` | `pending` | No | No | Anchor submitted payout to external banking/payment rail. |
| `on_hold` | `pending` | No | No | Transaction held by anchor (e.g. manual AML/compliance review). |
| `pending_stellar` | `pending` | No | No | Anchor is waiting on a Stellar network transaction. |
| `pending_trust` | `pending` | No | No | Anchor is waiting for trustline establishment. |
| `pending_user` | `pending` | No | No | Anchor is waiting for user action. |
| `pending_customer_info_update` | `pending` | **Yes** (`true`) | No | Anchor requires updated KYC/customer info (SEP-12). Signals `needsSellerAction: true` on job response. |
| `pending_transaction_info_update` | `pending` | **Yes** (`true`) | No | Anchor requires additional transaction info. Signals `needsSellerAction: true` on job response. |
| `incomplete` | `awaiting_transfer` | No | No | Withdrawal created but deposit/transfer has not yet completed. |
| `completed` | `settled` | No | **Yes** | Withdrawal successfully completed and paid out to seller. Transitions link to `offramp_settled`. |
| `refunded` | `failed` | No | **Yes** | `withdrawal was refunded (refunded)`. Transitions link to `offramp_failed`. |
| `expired` | `failed` | No | **Yes** | `withdrawal expired (expired)`. Transitions link to `offramp_failed`. |
| `error` | `failed` | No | **Yes** | `anchor reported an error (error)`. Transitions link to `offramp_failed`. |
| `no_market` | `failed` | No | **Yes** | `no market for the asset pair (no_market)`. Transitions link to `offramp_failed`. |
| `too_small` | `failed` | No | **Yes** | `amount below the anchor's limit (too_small)`. Transitions link to `offramp_failed`. |
| `too_large` | `failed` | No | **Yes** | `amount above the anchor's limit (too_large)`. Transitions link to `offramp_failed`. |

### Failure Reason Resolution

For failed statuses (`refunded`, `expired`, `error`, `no_market`, `too_small`, `too_large`), `TestAnchorOffRamp.status()` resolves the failure reason in order of precedence:
1. `tx.message`: The explicit error message returned by the anchor transaction object.
2. `mappedStatus.reason`: The fallback reason string defined in `SEP6_STATUS_MAP` (e.g. `"amount above the anchor's limit (too_large)"`).
3. `${this.anchorName}: withdrawal failed`: Default fallback string.

### Unknown Status Rule

Unknown or unmapped status strings returned by an anchor are handled by `mapSep6Status(status: string)` (`src/testanchor.ts`):
- Any status string not present in `SEP6_STATUS_MAP` falls back to `{ status: "pending" }` (non-terminal, `needsSellerAction: false`).
- A warning event `anchor.sep6.status.unknown` (`{ event: "anchor.sep6.status.unknown", status: tx.status }`) is logged.
- De-duplication: Tracked in `unknownStatusesLogged: Set<string>` on `TestAnchorOffRamp` to log only once per job, avoiding log flooding during periodic background polling ticks.

---

## Stellar TOML (`stellar.toml`) Keys

When discovering anchor endpoints via SEP-1 (`parseStellarToml` in `src/sep1.ts`), Quay reads flat key/value pairs and `[[CURRENCIES]]` blocks:

| TOML Key | Aliases / Alternatives | Used For | Behaviour When Missing / Omitted |
| --- | --- | --- | --- |
| `WEB_AUTH_ENDPOINT` | `WEB_AUTH_URL` | SEP-10 Web Authentication endpoint (challenge generation & token exchange). | Retains fallback default `https://${homeDomain}/auth`. |
| `TRANSFER_SERVER` | None | SEP-6 Transfer Server base URL (`/info`, `/withdraw`, `/transaction`). | Retains fallback default `https://${homeDomain}/sep6`. Also serves as default for `KYC_SERVER` if `KYC_SERVER` is omitted. |
| `TRANSFER_SERVER_SEP0024` | `TRANSFER_SERVER_SEP24` | SEP-24 Interactive Deposit/Withdrawal server base URL. | Retains fallback default `https://${homeDomain}/sep24`. |
| `ANCHOR_QUOTE_SERVER` | None | SEP-38 Anchor RFQ / Quotes server base URL. | Defaults to `null` (never guessed/fabricated; guessing `/sep38` was removed in BUG-3.22 / issues 3.19 & 3.22). When `null`, quoting relies on a configured `RateSourcePort` (`quoteWithoutSep38`) or fails with `OffRampRejectedError` if no rate source is configured. |
| `KYC_SERVER` | None | SEP-12 Customer / KYC identification server base URL (`/customer`). | Defaults to `TRANSFER_SERVER` (`info.kycServer = info.transferServer` in `parseStellarToml`), adhering to SEP-12 specification where anchors omitting `KYC_SERVER` serve KYC directly from the transfer server. |
| `SIGNING_KEY` | None | Public Stellar account address (`G...`) that signs the anchor's SEP-10 challenge transaction. | Defaults to `null`. If missing, `verifiableDiscovery` rejects authentication. |
| `NETWORK_PASSPHRASE` | None | Stellar network passphrase declared by the anchor (e.g. `Test SDF Network ; September 2015` vs `Public Global Stellar Network ; September 2015`). | Defaults to `null`. |
| `CURRENCIES[].code` | `code` in `[[CURRENCIES]]` blocks | Asset codes supported by the anchor. Populates `currencies: string[]`. | `currencies` is empty array (`[]`). `listsCurrency(info, code)` returns `true` when empty (does not reject, assuming absence of currency blocks does not assert asset absence). |

---

## Fallback Endpoints & Verifiable Discovery

When `stellar.toml` cannot be fetched over the network (e.g. connection error, 500 status), `fallbackInfo(homeDomain)` (`src/sep1.ts`) generates default URLs:
- `webAuthEndpoint`: `https://${homeDomain}/auth`
- `transferServer`: `https://${homeDomain}/sep6`
- `transferServerSep24`: `https://${homeDomain}/sep24`
- `anchorQuoteServer`: `null` (never guessed)
- `kycServer`: `https://${homeDomain}/sep12`
- `signingKey`: `null`
- `networkPassphrase`: `null`
- `currencies`: `[]`
- `fallback`: `true`

### Security Rule: Fallbacks Refused for Seller SEP-10

Guessed fallback endpoints are strictly prohibited from authenticating sellers. `verifiableDiscovery()` in `src/anchor-session.ts` enforces:

```typescript
if (d.fallback || !d.signingKey) {
  throw new AnchorChallengeError(
    `could not verify ${this.anchorDomain}: its stellar.toml was unreachable or declares no SIGNING_KEY`,
    "unverifiable",
  );
}
```

A guessed endpoint or a missing `SIGNING_KEY` provides no cryptographic assurance to verify the challenge transaction. Asking a seller to sign an unverified transaction with their funds wallet is a security risk that Quay refuses to take.
