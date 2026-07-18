# Maintainer TODO

Working plan around the Drips wave 7 entry (≈ **Jul 21–27, 2026**). Everything
band-moving must land **before** entry — work shipped inside the wave window doesn't
count until the following wave. Target: close the depth + surface loop
(band C ≈ $36 → band B ≈ $100, band A ≈ $200 reachable).

**Status as of Jul 18, 2026:** the anchor adapter (old item 1) shipped Jul 14
(`TestAnchorOffRamp`, SEP-10 → SEP-38 → SEP-6, live-flagged tests). The deploy
(old item 2) is **half done and currently broken for a stranger**: the web app is
live at https://quay-web.vercel.app, but the API was never deployed —
`stellar-checkout-api.fly.dev` does not resolve, and the deployed web bundle falls
back to `http://localhost:8787`, so "Create link" dead-ends for anyone but us.
A live URL with a broken core flow at entry is the Nester-W6 demotion pattern.
Fixing this is the only pre-entry work item.

---

## 0. NOW (before ~Jul 20): finish the deploy — the only thing that moves the band

- [ ] Deploy `apps/api` to Render — **decided Jul 18**: one Web Service on the
      Starter plan ($7/mo; free tier spins down after 15 min idle, which kills the
      watcher — never use it for this service). Docker runtime pointed at
      `apps/api/Dockerfile`, health check path `/health`, port 8787. Web stays on
      Vercel; Turso is external — one Render service total.
- [ ] Database: Turso free tier (`DATABASE_URL=libsql://…` + `DATABASE_AUTH_TOKEN`),
      or a Fly volume with the existing `file:` SQLite URL — either works, pick one
      and stop deliberating (see "Database options" below).
- [ ] Secrets: `STELLAR_NETWORK=testnet`, `USDC_ISSUER_TESTNET`, `OFFRAMP=testanchor`,
      `DEFAULT_SELLER_WALLET` + `DEFAULT_SELLER_SECRET`, `CORS_ORIGINS=https://quay-web.vercel.app`.
- [ ] Vercel env: `NEXT_PUBLIC_API_URL=<api url>`, `API_URL=<api url>`,
      `NEXT_PUBLIC_OFFRAMP_MODE=testanchor`, `NEXT_PUBLIC_OFFRAMP_CURRENCY=USD`
      (testanchor only quotes USD/CAD) — then **redeploy the web app**
      (`NEXT_PUBLIC_*` is baked at build time).
- [ ] Smoke-test the full stranger flow from a clean browser: create link → open
      checkout → pay testnet USDC with the memo → link flips paid → webhook fires →
      cash-out returns a real SEP-38 quote.
- [ ] Run `RUN_LIVE_ANCHOR_TESTS=1 pnpm --filter @checkout/offramp test` once and
      note the result.

Then rest until entry. Do not ship anything new into the entry snapshot.

---

## Decision log — Jul 18, 2026: path-payment settlement is PARKED

We evaluated settling sellers in NGNC on-chain via path payments (buyer pays USDC,
seller receives NGNC, no anchor call in checkout). Ran the liquidity check against
mainnet Horizon (`/paths/strict-receive`, NGNC issuer
`GASBV6W7GGED66MXEVC7YZHTWWYMSVYEY35USF2HJZBLABLYIFQGXZY6` from ngnc.online,
USDC Circle issuer):

| Destination | Best path | Implied rate | Verdict |
| --- | --- | --- | --- |
| ₦10,000 | 11.22 USDC | 891 NGN/USD | ~40%+ worse than real rate (~1,500+) |
| ₦50,000 | 75.34 USDC | 664 NGN/USD | >100% worse |
| ₦500,000 | — | — | **no paths at all** |

NGNC/USDC orderbook is effectively empty (one thin ask level, near-zero bids).
Cowrie's stellar.toml no longer lists an NGN asset. **Conclusion: the DEX cannot
carry checkout volume today. USDC settlement + anchor redemption (current
architecture) stays the flagship; the LINK SEP-24 production adapter is the depth
story.** Revisit path payments only after a LINK relationship exists and they have
a reason to market-make — our telemetry data (below) is the leverage for that ask.

---

## Post-entry roadmap (start AFTER the W7 snapshot, in this order)

### 1. `OffRampPort` union for SEP-24 (small, do first)

Make `initiate()` return a discriminated union before the port calcifies:

```ts
type OffRampInitiation =
  | { kind: "fields"; jobId: string }                      // SEP-6, current
  | { kind: "interactive"; jobId: string; url: string };   // SEP-24
```

`LinkService` passes it through; dashboard opens `url` in a popup for
`interactive` and polls `status()` as today. `TestAnchorOffRamp` keeps returning
`fields`. ~Half a day; means the LINK adapter needs no domain surgery.

### 2. Telemetry table (cheap now, the moat later)

One table, populated passively from day one: every off-ramp job writes
`(anchor, corridor, quoted_rate, quoted_at, settled_at, effective_rate, status)`.
Don't build product on it yet. Months of even modest volume = the only dataset of
anchor settlement latency and effective NGN spread on Stellar → the SCF follow-on
angle ("anchor telemetry & reliability layer") and the LINK conversation leverage.

### 3. Wallet-native auth + multi-tenancy

Skip email/password entirely. Seller connects a wallet (Stellar Wallets Kit) and
signs a SEP-10-style challenge proving control of the G-address; that address IS
the identity and the payout destination. Session = JWT. API keys (`ak_live_…`,
store hash only) for programmatic access. Scope `/links` and `/webhooks` by
authenticated seller. Watcher loop moves to per-active-seller polling — iterate
distinct destinations with pending links, cursor per account (`WatcherPort`
already takes the account param). This also closes the hole where anyone can
create links paying to any wallet.

### 4. LINK SEP-24 production adapter (the A-band lever)

Fork `TestAnchorOffRamp`'s shape against LINK's (ngnc.online) SEP endpoints, using
the SEP-24 `interactive` arm from step 1. Validate they will actually onboard and
pay out before building past the adapter. Approach LINK with telemetry + live
checkout volume in hand — arrive showing settlement routed into their asset, not
asking for rails.

### 5. Distribution + SCF packaging (together)

- Embeddable widget: ~5KB script tag rendering a "Pay ₦X" button that opens the
  hosted checkout in a modal, keyed by link ID. One surface; WooCommerce/Shopify
  plugins become community issues, not our build.
- README first line repositioned: "the open-source, non-custodial merchant
  checkout for the Stellar anchor network — the inbound counterpart to the
  Stellar Disbursement Platform."
- Break this roadmap into public GitHub issues (wave label format).
- Stop squashing: commit velocity is legible to reviewers; a squashed drop reads
  as a code dump.
- SCF Build submission with the deployed testnet demo (testanchor has no NGNC, so
  demo the SEP-6 off-ramp leg as-is; a path-payment demo would use self-issued
  testnet assets *if* that leg is ever revived).

---

## Database options (for item 0 and beyond)

- **Turso free tier** (as of Jul 2026): 100 databases / 100 monthly-active, 5 GB
  total storage, 500M row reads/mo, 10M row writes/mo; Developer plan $4.99/mo
  (2.5B reads). Our watcher at a 6s poll writes a cursor row ~432k times/month per
  account — comfortably inside free limits. Drop-in: code already speaks libSQL.
- **Fly volume + `file:` SQLite** — zero extra vendor, works because the API is a
  single always-on machine. Drop-in (current local setup, unchanged). Loses the
  DB if the volume dies; fine for testnet demo.
- **Self-hosted libsql-server (sqld)** — libSQL-compatible, more ops for no gain
  at this scale.
- **Cloudflare D1 / Neon / Supabase** — all require swapping the Drizzle driver in
  `apps/api/src/db/client.ts`; not drop-in. Only worth it if leaving libSQL anyway.

---

## ⚠️ Standing rule — never let mock data or broken flows into an entry snapshot

The dashboard already labels cash-out "(simulated)" whenever `OFFRAMP=mock`.
Keep that invariant: in the final days before EVERY wave entry, sweep the live
surface for hardcoded/mock/placeholder data **and for flows that error** (a live
URL whose create-link fails is as bad as fake data). Wire it live or remove the
page. Ship-then-wire is the demotion pattern.

---

## Deliberately deferred (do NOT do before the W7 entry)

None of these move the band; they only cost the days remaining:

- Everything in the post-entry roadmap above, including auth.
- More docs (README/API docs already strong; docs-only changes pay nothing).
- Streaming `WatcherPort` implementation — polling is fine at this scale.
- Extra CI workflows.
- A Soroban contract for its own sake — off-architecture; the SEP path is the depth story.
- A second repo — never split the project.
