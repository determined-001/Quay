# 0001 — SEP-6 vs SEP-24 for the off-ramp

## Status

Accepted (2026-09-30). Supersedes the rejection reasoning that previously
lived in `packages/offramp/src/testanchor.ts`'s header and
`docs/ARCHITECTURE.md` §"Why SEP-6, not SEP-24" — both said the port could
not express an interactive flow, which is no longer true.

## Context

A seller's cash-out has to drive a real anchor withdrawal. Stellar's
ecosystem defines two withdrawal protocols:

- **SEP-6** ([spec](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md)) —
  programmatic: the client collects everything (payout fields, KYC via
  SEP-12) and calls `GET /withdraw`; the anchor answers with deposit
  instructions.
- **SEP-24** ([spec](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)) —
  interactive: the client opens the anchor's own hosted UI, which collects
  KYC and payout details itself; instructions arrive later on the
  transaction record.

The original decision picked SEP-6 *because the port was backend-only* — no
interactive-redirect concept existed anywhere upstream of the adapter. That
premise has since been built away:

- `OffRampInitiation` has an `interactive` arm
  (`packages/core/src/ports/index.ts:201-204`);
- the API forwards `interactiveUrl` to the dashboard
  (`apps/api/src/routes/links.ts:263-267`);
- the dashboard opens it, with https-only and popup-blocked handling
  (`apps/web/app/components/CashOutModal.tsx:255`, `openInteractive`);
- a SEP-24 adapter exists (`packages/offramp/src/anchor.ts`).

Meanwhile production reality pushed the other way: real anchors publish
SEP-6 without SEP-38 (`ROADMAP.md:22-29` — Cowrie declares `TRANSFER_SERVER`
but no `ANCHOR_QUOTE_SERVER`), and `scripts/anchor-sep-scan.mjs` measures
exactly which anchors publish which SEPs.

## Options

### SEP-6 — Quay-hosted form, programmatic withdrawal

- Quay's dashboard collects the payout fields the anchor's `/info` declares,
  and KYC goes through SEP-12 (`packages/offramp/src/kyc.ts:36`,
  `TestAnchorKyc`) — a **reusable profile**: the anchor keeps the KYC per
  SEP-10 account, so the seller enters it once, not per cash-out.
- The anchor returns its deposit instructions at initiate time
  (`packages/offramp/src/testanchor.ts:258` — `startSep6Withdraw`, whose
  `account_id`/`memo` come straight back as the `kind: "transfer"`
  initiation), so the seller can be shown *exactly* what to send,
  immediately.
- The seller signs the transfer in their own wallet
  (`apps/web/lib/wallet.ts:159`, `sendAnchorTransfer`).
- Cost: Quay owns a dynamic form and the field-validation UX, and carries
  the seller's payout fields (encrypted at rest since #296).

### SEP-24 — anchor-hosted UI, interactive withdrawal

- The anchor hosts KYC and payout collection in a popup; Quay never sees
  bank details at all. The anchor likewise remembers KYC per SEP-10 account
  (SEP-24 §"KYC"), and Quay may prefill SEP-9 fields with the seller's
  consent (SEP-24 §"Providing prepopulated fields").
- Deposit instructions arrive **later**, when the transaction reaches
  `pending_user_transfer_start` — the poller watches for it and only then
  can hand the seller a transfer to sign
  (`packages/offramp/src/anchor.ts:186`).
- Cost: a popup dependency (blocked popups need the fallback link
  `CashOutModal` already renders), and the wait between initiating and
  knowing where to send funds.

### Common to both — the non-custodial line does not move

In **either** protocol the seller's wallet signs the SEP-10 challenge
(`packages/offramp/src/anchor-session.ts`, `SellerAnchorAuth` — the
challenge is relayed, signed in the browser, and only the resulting JWT is
kept) **and** signs the withdrawal transfer itself. Quay's server signs
neither. The custody model (`README.md` §"Custody model") is identical
across the choice; this decision is about *who hosts the form and when
instructions arrive*, not about who can move money.

### Quotes are orthogonal, and the harder problem

SEP-38 gives a firm FX quote where the anchor offers it
(`packages/offramp/src/sep38.ts`, used by `TestAnchorOffRamp.quote`). Real
anchors often don't (`ROADMAP.md:22-29`); there, fees come from `/info`
(`fee_fixed`/`fee_percent`) and the FX rate needs another source — tracked
as [#217 (3.20)](https://github.com/determined-001/Quay/issues/217) for
SEP-24 `/info` fees and
[#219 (3.22)](https://github.com/determined-001/Quay/issues/219) for the
no-SEP-38 quote. Neither protocol solves this; neither is blocked by it.

## Decision

**Support both, selected per anchor from its SEP-1 capabilities**
([#216 (3.19)](https://github.com/determined-001/Quay/issues/216)): an
anchor declaring only `TRANSFER_SERVER` gets SEP-6, only
`TRANSFER_SERVER_SEP0024` gets SEP-24, and **when both are declared, prefer
SEP-6** — instructions at initiate time, no popup dependency, and a
cash-out that completes inside the dashboard the seller is already in.

## Consequences

- `TestAnchorOffRamp` (SEP-6) stays the reference adapter and the default
  testnet path; `AnchorOffRamp` (SEP-24) is the shape for anchors that only
  offer interactive.
- The dashboard must keep both UX paths working: the dynamic field form and
  the popup-with-fallback-link.
- Per-anchor selection (#216) is the remaining wiring; until it lands the
  protocol is fixed by the `OFFRAMP` deployment setting.

## Revisit when

- A target production anchor offers **only** SEP-24, or its SEP-6 lacks
  fields the payout actually needs — the preference flips per-anchor, which
  #216's mechanism already permits.
- SEP-38 adoption among target anchors changes materially
  (`scripts/anchor-sep-scan.mjs` is the measurement), since the no-SEP-38
  quote workaround (#219) is most of SEP-6's remaining cost.
- The `inline` off-ramp mode ever becomes real (see `docs/ARCHITECTURE.md`
  §"Why `seller_initiated` only"), which changes who is in the flow at all.
