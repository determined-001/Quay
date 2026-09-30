# Roadmap

Written 2026-09-06, the day the first real payment settled on mainnet
(`3e8dfd1…`, 2 XLM, buyer wallet straight to merchant wallet, correlated by the
memo inside the signed transaction).

This file is about **direction**, not tasks. `TODO.md` holds the work queue and
`ISSUES.md` holds the contributor backlog. What follows is the argument for
where effort should go, including the parts that are uncomfortable.

---

## The uncomfortable premise

**A Nigerian merchant does not want USDC. They want naira in their bank
account.**

Quay currently stops at "USDC arrived in your wallet" and hands the hard part
back to the seller. That is the gap between *technically works* and *someone
would use this*.

The blocker is already documented and it is sharper than a missing feature:
real anchors do not implement `ANCHOR_QUOTE_SERVER`. Cowrie declares
`TRANSFER_SERVER`, `WEB_AUTH_ENDPOINT`, `KYC_SERVER` and
`DIRECT_PAYMENT_SERVER` — no SEP-38. `TestAnchorOffRamp` is built against a
shape production does not have. Fees are available from `/sep6/info`
(`feeFixed` / `feePercent`); the FX rate has no standard source.

**That unsolved FX quote is the product.** Payment links, memo correlation, the
watcher, the widget, the receipts — all of it is scaffolding around that hole.

---

## The reframe

Quay is not competing with Paystack.

Paystack owns domestic Nigerian card payments and that fight is unwinnable: the
buyer needs USDC on Stellar, which almost no domestic Nigerian buyer holds.

**Quay competes with the cost of paying a Nigerian business from abroad.**
Diaspora customers, a freelancer's international clients, cross-border B2B.
There the incumbent is a wire that costs $25–45, takes 2–5 days, and carries a
3–5% FX spread. Against that, a Stellar payment settling in five seconds for a
fraction of a cent is not an improvement — it is a different category.

The reframe changes what gets built:

- **Buyer-side onboarding stops mattering.** This buyer already holds USDC or
  can get it trivially. No on-ramp needed to reach them.
- **The off-ramp becomes everything.** The merchant is the one who needs local
  currency, and they need it reliably, not occasionally.

---

## Three assets that are already built and undersold

**1. No chargebacks.** Card payments for digital goods sold across borders carry
real fraud-chargeback risk, and the merchant eats both the loss and a fee.
Stellar payments are final. For anyone selling software, design, or services
internationally this is a headline benefit, and saying it costs nothing.

**2. The payment link, not the widget.** A widget asks a merchant to integrate a
payment method their customers may not have. A link asks for nothing — it goes
in a DM or an invoice email. The link is how this gets its first ten real users.
The widget is for the eleventh.

**3. Verifiable receipts.** Most processors ask you to trust their dashboard.
Quay hands over a transaction hash and a memo binding payment to invoice on a
public ledger, checkable without asking Quay anything. For cross-border
invoicing between parties who do not know each other, that is genuinely
differentiated — and it currently lives as a footnote in `docs/API.md` rather
than as a reason to choose this.

---

## Order of work

1. **One real merchant.** Someone who invoices foreign clients. One is enough to
   learn from; ten is a distraction at this stage.
2. **USDC on mainnet.** Native XLM is proven. USDC is the actual path and has
   never run in production — it exercises `resolveAsset` with an issuer and the
   `assertCanReceive` trustline preflight, neither of which has fired for real.
3. **The FX quote against one real anchor.** Not SEP-38 in general. One anchor,
   one corridor, end to end. This is the difference between a demo and a
   business.
4. **Muxed correlation** (#197). Real, and it removes the memo as a failure
   mode — but it improves a flow that already works, and the off-ramp does not
   exist yet.

---

## A measurement worth keeping

The uptime workflow asks for `*/5` and gets between 30 minutes and 3 hours.
That was assumed to be every 5 minutes for weeks, and the assumption was used
to justify running mainnet on a free instance — the reasoning being that a ping
under the 15-minute idle timeout keeps it awake. Measured, every observed gap
exceeds that timeout, so it never did.

Two lessons, both cheap to forget:

- **A cron expression is a request, not a guarantee.** On a free public repo it
  is heavily coalesced under load.
- **Nothing in this repo should depend on that schedule.** Monitoring may lag;
  the settlement watcher must not. It does not — it resumes from a persisted
  cursor — but the reason it does not is worth protecting.

## The standing risk

The engineering here is strong, and that is the trap. The temptation is to build
more of what already works well rather than the one thing that does not work at
all.

Two decisions this codebase has already made correctly, both by deletion:

- **The attestation contract** was removed because the classic transaction and
  its memo were already the proof. The product became *more* verifiable, and it
  deleted the only component that would have required paid mainnet
  infrastructure.
- **`DEFAULT_SELLER_WALLET`** stopped being required because Quay is
  multi-tenant and owns no wallet — the guard had outlived the singleton it was
  written for and implied a custody relationship that does not exist.

Both were subtractions that made the thing truer. Point that instinct at the
off-ramp next.
