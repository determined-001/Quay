# Quay — Product Backlog (Wave Issues)

> Source file for [`.github/create-issues.js`](.github/create-issues.js).
> Run `node .github/create-issues.js` to push every issue below to
> `determined-001/Quay` with labels, milestones and complexity points applied.

**What this is.** Everything between the repo as it stands today (a real,
deployed, testnet-honest checkout with a live SEP-10 → SEP-38 → SEP-6 off-ramp
leg) and a *complete product* a merchant could actually run. It is the
[`MAINTAINER.md`](MAINTAINER.md) roadmap exploded into buildable units, plus the
gaps found by reading the code that the roadmap does not yet name.

**Numbering.** `<major>.<minor>`. Majors are permanent area buckets — never
re-use a number, never renumber:

| Major | Area label | Scope |
| --- | --- | --- |
| 1 | `area:core` | `packages/core` — domain, ports, status machine, matcher, money |
| 2 | `area:stellar` | `packages/stellar` — SEP-7 rail, Horizon watcher, normalization |
| 3 | `area:offramp` | `packages/offramp` — anchors, SEP-1/6/10/12/24/38 |
| 4 | `area:api` | `apps/api` — Hono routes, worker, persistence, delivery |
| 5 | `area:web` | `apps/web` — dashboard, checkout, widget |
| 6 | `area:auth` | wallet-native auth + multi-tenancy (spans api + web) |
| 7 | `area:distribution` | npm packages, docs, grant framing, demo assets |
| 8 | `area:ops` | CI, Docker, metrics, backups, uptime |

**Milestones.**

| ID | Milestone | The question it answers |
| --- | --- | --- |
| M1 | Off-ramp depth | Can a seller actually get local currency, from a real anchor, reliably? |
| M2 | Multi-tenant platform | Can someone who is not us run this without trusting us? |
| M3 | Settlement correctness | Does every on-chain payment land in the right state, exactly once? |
| M4 | Merchant surface | Can a merchant integrate in an afternoon? |
| M5 | Distribution & grant | Can a stranger install it, and can a committee fund it? |
| M6 | Ops & rigor | Do we know when it breaks, and can we prove it works? |

**Body format.** Every issue has `Complexity`, `Milestone`, `Band lever`,
`Context`, `Problem`, `What needs to be done`, `Key files`, `Done when`. The
complexity tier and the backticked `type:*` tokens are parsed by the bulk-create
script; do not reformat that line.

**Band lever** is the Drips read: which payout gate the issue moves.
`hold-B` = protects the closed loop we already have (do not regress it),
`B→A` = protocol-standard depth, the money transition from ~$100 to ~$200,
`A→S` = infrastructure-class work, `none` = necessary product work that moves no
band on its own. Wave-entry rule stands: anything shipped **inside** a wave
window is invisible until the next entry — land band levers *before* the entry,
never during.

---

## `packages/core` — domain (1.x)

The only package with logic worth unit-testing in isolation, and the seam every
adapter is written against. Changes here are contract changes: they ripple into
`apps/api`, both adapters, and the web client's types.

---

### 1.1 - Discriminated union return for `OffRampPort.initiate()`

**Complexity:** Medium - 150 Points · `type:refactor`

**Milestone:** M1 - Off-ramp depth

**Band lever:** B→A (unblocks the SEP-24 adapter, 3.6)

**Context**
`OffRampPort` is the seam the whole product is built around. Today `initiate()`
returns a bare `OffRampJob`, which encodes one assumption: that starting a
withdrawal needs no user interaction. That is true for SEP-6 (field-driven) and
false for SEP-24 (the anchor hands back an interactive URL the seller must open).
Nearly every licensed anchor exposes SEP-24, not SEP-6.

**Problem**
The port cannot express "the anchor needs the human in a browser". Adding SEP-24
later without this change means surgery on `LinkService`, the API route and the
dashboard simultaneously — exactly the coupling ports-and-adapters exists to
prevent.

**What needs to be done**
1. Introduce the union in `packages/core/src/ports/index.ts`:
   ```ts
   export type OffRampInitiation =
     | { kind: "fields"; job: OffRampJob }
     | { kind: "interactive"; job: OffRampJob; url: string };
   ```
2. Change `OffRampPort.initiate()` to return `Promise<OffRampInitiation>`.
3. `MockAnchorOffRamp` and `TestAnchorOffRamp` return `{ kind: "fields", job }`.
4. `LinkService.triggerCashOut` passes the union through unchanged; the link
   still moves to `offramp_pending` in both arms.
5. `POST /links/:id/cash-out` returns `{ job, interactiveUrl? }`.
6. Dashboard: when `interactiveUrl` is present, open it in a popup and keep
   polling `status()` exactly as today.

**Key files**
- `packages/core/src/ports/index.ts` — the union
- `apps/api/src/services/link-service.ts:120` — `triggerCashOut`
- `apps/api/src/routes/links.ts:30` — cash-out route
- `packages/offramp/src/mock-anchor.ts`, `packages/offramp/src/testanchor.ts:109`
- `apps/web/app/components/Dashboard.tsx:73` — `cashOut`

**Done when**
- [ ] Both existing adapters compile against the new signature with no behaviour change.
- [ ] Unit test asserts `LinkService` moves the link to `offramp_pending` for both arms.
- [ ] `pnpm typecheck` clean across the workspace.

---

### 1.2 - Enforce SEP-38 quote expiry before initiating a withdrawal

**Complexity:** Medium - 150 Points · `type:bug`

**Milestone:** M3 - Settlement correctness

**Band lever:** hold-B

**Context**
`OffRampQuote.expiresAt` exists and `TestAnchorOffRamp.quote()` populates it from
the anchor's `expires_at`. A firm SEP-38 quote is a rate lock with a deadline —
that deadline is the entire point of asking for one.

**Problem**
Nothing reads `expiresAt`. `triggerCashOut` quotes then immediately initiates, so
today the window is small — but the moment a payout form (5.2) or an interactive
SEP-24 arm (1.1) puts a human between the two calls, a stale quote goes to the
anchor and the seller is settled at a rate nobody agreed to, or the anchor
rejects it with an opaque error.

**What needs to be done**
1. Add `isQuoteExpired(quote, now)` and a `QuoteExpiredError` to core.
2. `LinkService.triggerCashOut` checks expiry before `initiate()`; on expiry it
   re-quotes once automatically and fails with `409 quote_expired` if the second
   quote is also stale.
3. Return `expiresAt` and a server-computed `expiresInSeconds` on the cash-out
   quote response so the client can show a countdown.
4. Reject quotes whose `expiresAt` is unparsable (`NaN`) instead of treating
   `NaN` comparisons as "not expired".

**Key files**
- `packages/core/src/ports/index.ts:64` — `OffRampQuote`
- `apps/api/src/services/link-service.ts:128` — quote → initiate window
- `packages/offramp/src/testanchor.ts:105` — `Date.parse(q.expiresAt)`

**Done when**
- [ ] Unit tests cover fresh / expired / unparsable expiry.
- [ ] An expired quote never reaches `initiate()`.

---

### 1.3 - Drive the `expired` and `cancelled` transitions

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M3 - Settlement correctness

**Band lever:** none

**Context**
`LINK_STATUSES` declares `expired` and `cancelled`, and `TRANSITIONS` permits
`active → expired` and `active → cancelled`. `createLink` stores `expiresAt`.

**Problem**
No code path ever writes either status. A link with a 10-minute TTL stays
`active` forever, still renders a live QR, and will still be matched and marked
paid hours after it "expired" — a merchant-visible lie, and a lie sitting on the
live demo surface. There is also no way for a seller to void a link they created
by mistake.

**What needs to be done**
1. Add an expiry sweeper to the worker: every tick, move `active` links whose
   `expiresAt < now` to `expired` (respect `canTransition`, skip anything already
   paid or underpaid).
2. Add `POST /links/:id/cancel` → `cancelled`, rejected with `409` from any
   non-`active` state.
3. Fire `link.expired` and `link.cancelled` webhooks.
4. Watcher: a payment matching an `expired`/`cancelled` link must not resurrect
   it — record it as an unmatched payment with the link id attached, and fire
   `payment.unmatched` so the seller can refund out-of-band.
5. Checkout page renders a terminal "This link is no longer active" state.

**Key files**
- `packages/core/src/domain/status.ts:17` — transition table
- `apps/api/src/worker/watcher-loop.ts` — sweeper home
- `apps/api/src/routes/links.ts` — cancel route
- `apps/web/app/components/CheckoutClient.tsx:7` — `SETTLED` set

**Done when**
- [ ] A TTL'd link flips to `expired` within one poll interval of its deadline.
- [ ] Paying an expired link produces `payment.unmatched`, never `paid`.
- [ ] Cancel is idempotent and rejects from terminal states.

---

### 1.4 - Cumulative payment accounting: top-ups, overpayment, split payments

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M3 - Settlement correctness

**Band lever:** hold-B

**Context**
`matchPayment` compares **one** payment against the link's full amount. The
status machine already allows `underpaid → paid` "if topped up", and the README
advertises exhaustive matcher coverage.

**Problem**
The top-up path is unreachable. A buyer who sends 10 USDC then 15 USDC against a
25 USDC link produces two `underpaid` outcomes and the link never completes,
because the second payment is compared against 25, not against the 15 still
outstanding. Overpayment is flagged as a boolean but the surplus is never
recorded, so a merchant cannot see or refund it.

**What needs to be done**
1. New table `link_payments (id, link_id, tx_hash UNIQUE, payer, amount, asset_code,
   asset_issuer, created_at)` — the authoritative record of what arrived.
2. Change the matcher to take the link's *outstanding* amount:
   `matchPayment(payment, findLink, alreadyPaidStroops)` and return
   `{ kind: "partial", link, receivedTotal, outstanding }` for a genuine shortfall.
3. `LinkService.applyMatch` sums prior payments, decides `paid` / `underpaid`,
   writes `paidAmount` as the **cumulative** total, and stores the surplus in a
   new `overpaidAmount` column.
4. Fire `link.underpaid` with `outstanding` so a receiver can prompt for the rest.
5. Keep all money comparisons in integer stroops — never re-introduce a float.

**Key files**
- `packages/core/src/matching/match-payment.ts:32`
- `packages/core/src/domain/money.ts`
- `apps/api/src/db/schema.ts:10` — `links`
- `apps/api/src/services/link-service.ts:91` — `applyMatch`

**Done when**
- [ ] Two partial payments summing to the requested amount flip the link to `paid`.
- [ ] Three-way splits, overpayment on the final leg, and duplicate tx hashes are covered by unit tests.
- [ ] `paidAmount` always equals the sum of rows in `link_payments`.

---

### 1.5 - Model anchor fees so the seller sees net proceeds

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** B→A

**Context**
SEP-6 `/info` publishes `fee_fixed`, `fee_percent` and min/max per asset; SEP-38
quotes carry a `total_price` alongside `price`, and the difference *is* the
anchor's spread.

**Problem**
`OffRampQuote` carries `targetAmount` and `rate` only. The dashboard shows the
seller a gross figure that is not what lands in their bank account, and there is
no field in which an adapter could report the fee even if it knew it. For a
product whose whole thesis is "the off-ramp is the hard 80%", not modelling the
off-ramp's price is a hole in the domain.

**What needs to be done**
1. Extend `OffRampQuote` with `fee: { amount: string; currency: string; source: "anchor" | "estimated" }`
   and `netTargetAmount`.
2. `TestAnchorOffRamp.quote()` populates it from SEP-38 `price` vs `total_price`;
   `MockAnchorOffRamp` reports a clearly-labelled estimate.
3. Persist quoted fee and net on the link so the receipt can reproduce it.
4. Surface gross / fee / net as three lines in the cash-out confirmation UI.

**Key files**
- `packages/core/src/ports/index.ts:64`
- `packages/offramp/src/sep38.ts:36` — response parsing
- `apps/web/app/components/Dashboard.tsx`

**Done when**
- [ ] A live testanchor quote reports a non-null fee source of `"anchor"`.
- [ ] The seller-facing number is net, with gross and fee shown beneath it.

---

### 1.6 - Property-based tests for money and matching

**Complexity:** Medium - 150 Points · `type:test`

**Milestone:** M6 - Ops & rigor

**Band lever:** none (D8)

**Context**
29 example-based unit tests cover the domain. Money math in stroops and a
payment matcher are the two places where an off-by-one is silently expensive.

**What needs to be done**
1. Add `fast-check` to `packages/core`.
2. Properties for money: parse→format round-trips; `compareAmount` is a total
   order; addition is associative in stroops; no input with ≤7 decimals loses
   precision; >7 decimals is always rejected.
3. Properties for the matcher: an exact-amount payment with the right memo and
   destination is always `paid`; any destination mismatch is never `paid`; the
   outcome is invariant to memo whitespace only if we explicitly trim (assert the
   chosen behaviour, don't guess it).
4. Run 1,000 cases per property in CI; seed printed on failure.

**Key files**
- `packages/core/test/money.test.ts`, `packages/core/test/match-payment.test.ts`
- `packages/core/vitest.config.ts`

**Done when**
- [ ] Property suite passes in CI and fails loudly with a reproducible seed.

---

## `packages/stellar` — chain adapter (2.x)

---

### 2.1 - Streaming `WatcherPort` over Horizon SSE

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M3 - Settlement correctness

**Band lever:** hold-B

**Context**
`HorizonWatcher` polls every `WATCH_POLL_MS` (6 s default). The port was designed
so a streaming implementation could drop in without touching the domain or the
worker — that claim is untested.

**Problem**
Polling costs a mean 3 s of buyer-visible latency on the checkout page and
issues one Horizon request per active destination per tick forever, whether or
not anything happened. At more than a handful of sellers that is the dominant
cost of running the service.

**What needs to be done**
1. `StreamingHorizonWatcher implements WatcherPort` using
   `server.payments().forAccount(a).cursor(c).stream()`.
2. Buffer streamed events into the same `NormalizedPayment[]` shape so
   `fetchSince` semantics are preserved for the worker.
3. Auto-reconnect with exponential backoff; on reconnect, resume from the last
   persisted cursor and reconcile the gap via one polled page.
4. Select via `WATCH_MODE=poll|stream` (default `poll` until proven).
5. Contract test suite that runs the **same** assertions against both
   implementations.

**Key files**
- `packages/stellar/src/horizon-watcher.ts`
- `apps/api/src/worker/watcher-loop.ts`
- `packages/core/src/ports/index.ts:39` — `WatcherPort`

**Done when**
- [ ] Both implementations pass one shared contract test suite.
- [ ] A killed connection resumes without duplicating or dropping a payment.

---

### 2.2 - Drain the full payment backlog in a single tick

**Complexity:** Medium - 150 Points · `type:bug`

**Milestone:** M3 - Settlement correctness

**Band lever:** hold-B

**Context**
`fetchSince` requests one Horizon page (`limit`, default 200) and returns it.
`processAccount` advances the cursor to the last token of that page.

**Problem**
If more than `limit` payments arrive between ticks, the surplus waits a whole
poll interval per page. After any outage the backlog drains at 200 payments per
6 s while every affected buyer stares at "Waiting for payment…". Worse, the code
reads as if it drained fully, so the bug only shows up under the load nobody
tests.

**What needs to be done**
1. Loop `fetchSince` inside `processAccount` until a short page is returned or a
   configurable `MAX_PAGES_PER_TICK` (default 10) is hit.
2. Persist the cursor after **each** page, not once at the end, so a crash
   mid-drain does not replay a full backlog.
3. Log a warning whenever the page cap is hit — that is the signal to move to
   streaming (2.1).

**Key files**
- `packages/stellar/src/horizon-watcher.ts:39`
- `apps/api/src/worker/watcher-loop.ts:67` — `processAccount`

**Done when**
- [ ] A seeded 500-payment backlog is fully processed within one tick.
- [ ] Cursor advances monotonically page by page; a mid-drain crash resumes correctly.

---

### 2.3 - Account and trustline preflight before a link goes live

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** hold-B

**Context**
On Stellar, an account cannot receive an issued asset without an established
trustline, and cannot exist at all below the base reserve.

**Problem**
`createLink` never checks either. A seller whose wallet lacks a USDC trustline
gets a perfectly valid checkout page, the buyer pays, Horizon rejects the
payment, and the link sits `active` forever with the buyer believing they paid.
This is the single worst failure mode in the product and it is currently
undetectable from the UI.

**What needs to be done**
1. Add `assertCanReceive(account, asset)` to the Stellar adapter: account exists,
   funded above reserve, trustline present and not `authorized: false`, and
   below `limit`.
2. Call it on link creation; reject with `422 destination_cannot_receive` and a
   message naming the missing trustline and how to add it.
3. Cache per (account, asset) for 60 s so link creation stays fast.
4. Dashboard shows a persistent banner with a "Add USDC trustline" deep link when
   the seller's wallet fails preflight.
5. Re-check in the health endpoint (4.8) so a revoked trustline is visible in ops.

**Key files**
- `packages/stellar/src/stellar-rail.ts`, `packages/stellar/src/asset.ts`
- `apps/api/src/services/link-service.ts:53` — `createLink`

**Done when**
- [ ] Creating a USDC link against a trustline-less account returns 422, not a dead link.
- [ ] The dashboard tells the seller exactly what to fix.

---

### 2.4 - Horizon resilience: retry, backoff, 429 handling, failover

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
Every Horizon call goes through the raw SDK server object. The watcher catches
errors per account and logs them, so a Horizon incident degrades silently to
"nothing is ever marked paid".

**What needs to be done**
1. Wrap Horizon calls in a retry policy: 3 attempts, exponential backoff with
   full jitter, honouring `Retry-After` on 429.
2. Distinguish retryable (5xx, 429, network) from terminal (400, 404) — 404 for a
   missing account must stay the existing fast path.
3. Optional `HORIZON_URL_FALLBACK`; switch after N consecutive failures, switch
   back on recovery.
4. Emit a `horizon_degraded` metric/log line and surface it in `/health`.

**Key files**
- `packages/stellar/src/horizon-watcher.ts:60` — `isNotFound`
- `apps/api/src/env.ts:54` — `horizonUrl`

**Done when**
- [ ] A stubbed 429-then-200 sequence resolves without an operator noticing.
- [ ] Sustained Horizon failure marks the service degraded rather than silently idle.

---

### 2.5 - Kill the per-payment transaction fetch (N+1 on memo lookup)

**Complexity:** Medium - 150 Points · `type:perf`

**Milestone:** M3 - Settlement correctness

**Band lever:** none

**Context**
The memo lives on the transaction, not the operation, so `normalizePayment`
calls `record.transaction()` for **every** payment record.

**Problem**
A 200-record page issues 201 Horizon requests, each subject to rate limiting. It
is also the reason a Horizon hiccup silently degrades a payment to `no_memo`
(`catch` sets `memo = null`) — a matchable payment gets parked as unmatched
because of an unrelated network blip. Silent data loss dressed as a fallback.

**What needs to be done**
1. Use `join=transactions` on the payments call so Horizon returns the embedded
   transaction, eliminating the follow-up request entirely.
2. Where the join is unavailable, batch distinct `transaction_hash` values and
   fetch once per transaction, memoized per tick.
3. On fetch failure, do **not** downgrade to `no_memo` — throw, so the tick
   retries and the cursor does not advance past an unresolved payment.
4. Add a regression test asserting a transient transaction-fetch failure never
   produces a `no_memo` outcome.

**Key files**
- `packages/stellar/src/normalize.ts:38`
- `packages/stellar/src/horizon-watcher.ts:39`

**Done when**
- [ ] One page of N payments costs one Horizon request.
- [ ] A transaction-fetch failure retries instead of mislabelling the payment.

---

### 2.6 - Muxed accounts (M-addresses) as a memo-free correlation path

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** B→A

**Context**
Memo-based correlation is the classic Stellar merchant pattern and the classic
Stellar merchant support ticket: wallets that silently drop memos, buyers who
paste the address without the memo, exchanges that overwrite it. SEP-23 muxed
accounts (`M…`) put a 64-bit id *inside* the destination address, so
correlation survives any wallet.

**What needs to be done**
1. Add `muxedFor(account, id)` to the Stellar adapter, plus decoding of an
   inbound `to_muxed_id` on Horizon payment records.
2. Store a `muxedId` per link; build the SEP-7 URI against the `M…` address when
   `CORRELATION=muxed`.
3. `matchPayment` accepts either correlation key: memo reference **or** muxed id.
4. Preflight (2.3) verifies the underlying `G…` account can receive the asset.
5. Checkout page drops the "Memo — must be included" warning in muxed mode; keep
   it prominent in memo mode.
6. Document the tradeoff — some older wallets refuse `M…` destinations — and keep
   memo as the default until measured.

**Key files**
- `packages/stellar/src/stellar-rail.ts`, `packages/stellar/src/normalize.ts`
- `packages/core/src/matching/match-payment.ts`
- `apps/web/app/components/CheckoutClient.tsx:64` — memo note

**Done when**
- [ ] A testnet payment to an `M…` destination with no memo is matched and marked paid.
- [ ] Memo mode is byte-for-byte unchanged when `CORRELATION=memo`.

---

## `packages/offramp` — anchors and SEPs (3.x)

The moat. Depth here is what separates band B from band A.

---

### 3.1 - Persist off-ramp quotes and jobs

**Complexity:** High - 200 Points · `type:bug`

**Milestone:** M1 - Off-ramp depth

**Band lever:** hold-B

**Context**
`TestAnchorOffRamp` keeps `quotes` and `jobs` in two in-process `Map`s.

**Problem**
A restart — a Render redeploy, an OOM, a crash — erases them. Every link sitting
in `offramp_pending` is then permanently stuck: the cash-out poller calls
`status(jobId)`, `this.jobs.get()` misses, and it throws
`Unknown off-ramp job` on every tick, forever, with the seller's money in
limbo and no path forward through the UI. This is real money-adjacent state held
in a variable that does not survive a deploy.

**What needs to be done**
1. New tables: `offramp_quotes (quote_id PK, link_id, sell_asset_code,
   sell_asset_issuer, sell_amount, buy_currency, price, expires_at, created_at)`
   and `offramp_jobs (job_id PK, link_id, anchor, target_currency, target_amount,
   rate, status, external_status, last_error, created_at, updated_at)`.
2. Introduce an `OffRampStateRepository` port in core; inject it into the
   adapters instead of the Maps.
3. `status()` rehydrates from the store; an unknown job id returns a typed
   `JobNotFound` the poller can act on rather than an anonymous `Error`.
4. Backfill on boot: any link in `offramp_pending` without a job row is moved to
   `offramp_failed` with reason `job_state_lost`, which is a retryable state.
5. Integration test: initiate, restart the process, poll → job still resolves.

**Key files**
- `packages/offramp/src/testanchor.ts:63` — the two Maps
- `apps/api/src/db/schema.ts`, `apps/api/src/repos/index.ts`
- `apps/api/src/services/link-service.ts:156` — `pollCashOuts`

**Done when**
- [ ] A pending cash-out survives an API restart and still settles.
- [ ] No off-ramp state lives only in memory.

---

### 3.2 - SEP-1 `stellar.toml` discovery instead of hard-coded endpoints

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** B→A (adds a SEP to D4 coverage)

**Context**
Endpoint paths are hard-coded: `/auth`, `/sep38/quote`, `/sep6/withdraw`,
`/sep12/customer`. Those are testanchor's layout, not the standard's. SEP-1
exists precisely so a client discovers `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER`,
`ANCHOR_QUOTE_SERVER`, `KYC_SERVER` and `SIGNING_KEY` from
`https://<home_domain>/.well-known/stellar.toml`.

**Problem**
Every hard-coded path is a per-anchor code change. The production adapter (3.6)
cannot be configuration — it has to be a fork — and a project claiming SEP depth
is skipping the SEP that makes anchors interchangeable.

**What needs to be done**
1. `fetchStellarToml(homeDomain)` with a TOML parse, 5-minute cache and a typed
   result; validate `NETWORK_PASSPHRASE` matches our network.
2. Resolve every endpoint from the TOML; keep hard-coded paths only as a
   last-resort fallback behind a warning log.
3. Verify the SEP-10 challenge is signed by the TOML's `SIGNING_KEY` before
   signing it — today we sign whatever the server hands us, which is the whole
   attack surface of SEP-10.
4. Read `CURRENCIES` to check the asset we intend to withdraw is actually listed.

**Key files**
- `packages/offramp/src/sep10.ts:38`, `sep38.ts:22`, `sep6.ts:19`
- `packages/offramp/src/testanchor.ts:28` — `DEFAULT_BASE_URL`

**Done when**
- [ ] The adapter reaches testanchor using only `homeDomain` as configuration.
- [ ] A challenge signed by an unexpected key is rejected before we sign it.

---

### 3.3 - SEP-6 `/info` capability discovery

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** B→A

**Context**
`startSep6Withdraw` hard-codes `type: "bank_account"` and SEP-38 hard-codes
`buy_delivery_method: "WIRE"`. Both are guesses that happen to be right for
testanchor.

**Problem**
Withdrawal types, required fields, min/max amounts and fees are anchor-specific
and published by `GET /info`. Without reading it, we cannot validate an amount
before submitting, cannot render the correct payout form (5.2), and cannot tell a
seller *why* an anchor refused them — we just surface the raw error text.

**What needs to be done**
1. `getSep6Info(baseUrl)` → typed `{ withdraw: Record<assetCode, { enabled,
   fee_fixed, fee_percent, min_amount, max_amount, types: Record<string, { fields }> }> }`,
   cached 5 minutes.
2. Validate amount against min/max and the asset against `enabled` *before*
   quoting; return `422` with the anchor's own limits in the message.
3. Choose the withdrawal type from `/info` (prefer configured `OFFRAMP_TYPE`,
   else the single enabled type, else fail with the list).
4. Expose the required field descriptors over the API so the web form can render
   them (5.2).
5. Feed `fee_fixed` / `fee_percent` into the fee model (1.5).

**Key files**
- `packages/offramp/src/sep6.ts:35`
- `packages/offramp/src/sep38.ts:29` — `buy_delivery_method`

**Done when**
- [ ] An out-of-range amount is rejected locally with the anchor's published limits.
- [ ] Withdrawal type is discovered, never assumed.

---

### 3.4 - Collect real SEP-12 KYC instead of shipping "Demo Seller"

**Complexity:** High - 200 Points · `type:security`

**Milestone:** M1 - Off-ramp depth

**Band lever:** hold-B — this is placeholder data on a live surface

**Context**
`putSep12Customer` defaults `first_name: "Demo"`, `last_name: "Seller"`,
`email_address: "demo-seller@example.com"`, and the dashboard sends
`payoutFields: {}` — so **every** live cash-out on the deployed demo submits
those literals to a real anchor's KYC endpoint.

**Problem**
Two separate failures. Product: no real anchor will ever pay out against
fabricated identity data, so the flow cannot graduate past testanchor. Program:
this is hardcoded placeholder data flowing through the flagship path of a live
demo — precisely the pattern that has been penalised at wave entry. It is
currently the largest honesty gap in the repo.

**What needs to be done**
1. Fetch `GET /sep12/customer` to discover required fields and their status
   (`NEEDS_INFO`, `PROCESSING`, `ACCEPTED`, `REJECTED`) per customer.
2. Persist a `seller_kyc` record keyed by seller (never by link) with field
   values, status and `last_synced_at`. Treat every field as PII: encrypt at
   rest, never log, exclude from webhook payloads and from `/links` responses.
3. Remove **all** hard-coded defaults from `putSep12Customer` — missing required
   fields must produce `422 kyc_required` naming exactly which fields are missing.
4. API: `GET /seller/kyc` (requirements + status) and `PUT /seller/kyc` (submit).
5. Dashboard: a KYC panel that blocks cash-out until status is `ACCEPTED`, and
   shows `REJECTED` reasons verbatim from the anchor.
6. Until (5) ships, the dashboard cash-out button must state that identity data
   is required and unset — never silently submit placeholders.

**Key files**
- `packages/offramp/src/sep6.ts:14` — `putSep12Customer`
- `apps/web/app/components/Dashboard.tsx:73` — `cashOut` sends `{}`
- `apps/api/src/routes/links.ts:30`

**Done when**
- [ ] No literal "Demo"/"Seller"/"example.com" value can reach an anchor.
- [ ] A live cash-out is impossible until real KYC reaches `ACCEPTED`.

---

### 3.5 - Indicative SEP-38 prices before committing to a firm quote

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** B→A

**Context**
SEP-38 offers `GET /prices` (indicative, unauthenticated-ish, no commitment) and
`POST /quote` (firm, rate-locked, expiring). We only ever call the second.

**Problem**
The seller sees no rate until they have already committed to a firm quote, and
every browse of the dashboard would burn a firm quote if we showed one. There is
also no way to compare corridors or anchors (3.6) without indicative pricing.

**What needs to be done**
1. `getSep38Prices(baseUrl, { sellAsset, sellAmount })` → available buy
   currencies with indicative prices and delivery methods.
2. `GET /links/:id/offramp-preview` returns indicative rate, estimated fee (1.5)
   and estimated net — clearly labelled *indicative*.
3. Dashboard shows the indicative rate inline; the firm quote is only requested
   when the seller opens the cash-out form.
4. Record both indicative and firm rates in telemetry (3.8) — the gap between
   them is the anchor's real spread and the most interesting number we collect.

**Key files**
- `packages/offramp/src/sep38.ts`
- `apps/api/src/routes/links.ts`

**Done when**
- [ ] The dashboard shows a rate without consuming a firm quote.
- [ ] Indicative-vs-firm delta is persisted per cash-out.

---

### 3.6 - Production anchor adapter over SEP-24

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** **B→A — the single highest-value issue in this backlog**

**Context**
`TestAnchorOffRamp` talks to Stellar's public *reference sandbox*. Real anchors
(LINK / ngnc.online being the live NGN candidate) expose SEP-24 interactive
withdrawal, not field-driven SEP-6. `MAINTAINER.md` names this the A-band lever
and gates it on 1.1 (the union) shipping first.

**Problem**
The product cannot pay a real seller real naira. Everything else in the repo is
plumbing until this exists.

**What needs to be done**
1. `Sep24Client`: `POST /sep24/transactions/withdraw/interactive` → `{ id, url,
   type: "interactive_customer_info_needed" }`; `GET /sep24/transaction?id=` for
   polling; reuse the existing `Sep10Client` for auth.
2. `AnchorOffRamp implements OffRampPort` configured purely by `homeDomain` via
   SEP-1 discovery (3.2), returning `{ kind: "interactive", url }` from 1.1.
3. Map SEP-24 statuses onto `OffRampJobStatus`, including the states SEP-6 lacks:
   `pending_user_transfer_start` (we must send the asset to the anchor),
   `pending_anchor`, `completed`, `refunded`, `error`.
4. Handle the send leg: when the anchor asks for the withdrawal payment, build
   and submit the Stellar transaction to `withdraw_anchor_account` with
   `withdraw_memo`/`withdraw_memo_type`, then track it to confirmation.
5. `OFFRAMP=anchor` + `ANCHOR_HOME_DOMAIN=…`; keep `mock` and `testanchor` intact.
6. Live-flagged integration test (`RUN_LIVE_ANCHOR_TESTS=1`) mirroring
   `packages/offramp/test/testanchor.test.ts`.
7. **Business gate before code:** confirm the anchor will onboard us and pay out.
   Approach them with telemetry (3.8) and live checkout volume in hand.

**Key files**
- new `packages/offramp/src/sep24.ts`, `packages/offramp/src/anchor.ts`
- `packages/offramp/src/index.ts`, `apps/api/src/services/container.ts:128`

**Done when**
- [ ] A withdrawal reaches `completed` against a real anchor on testnet.
- [ ] Switching anchors is a `ANCHOR_HOME_DOMAIN` change, not a code change.

---

### 3.7 - Anchor health probe and circuit breaker

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
Anchors go down, rotate signing keys, and change their TOML. `triggerCashOut`
wraps failures into `502 Off-ramp error: <message>` and the poller swallows
`status()` errors with a bare `catch { continue; }`.

**Problem**
A dead anchor is indistinguishable from a slow one, both to the seller and to
us. Pending jobs poll a dead endpoint forever; a seller clicking cash-out gets a
raw upstream error string.

**What needs to be done**
1. Background probe per configured anchor: TOML reachable, SEP-10 challenge
   obtainable, `/info` 200. Every 60 s, result cached.
2. Circuit breaker: after N consecutive failures, open for a cooldown; while
   open, `triggerCashOut` fails fast with `503 anchor_unavailable` and a plain
   message instead of attempting the flow.
3. `pollCashOuts` records the error on the job (`last_error`) rather than
   discarding it, and backs off per job.
4. Expose anchor state in `/health` (4.8) and as a metric (8.3).
5. Dashboard shows a clear "cash-out temporarily unavailable" state — never a
   fake success.

**Key files**
- `apps/api/src/services/link-service.ts:141` — the 502 wrap
- `apps/api/src/services/link-service.ts:163` — the swallowed catch
- `apps/api/src/worker/watcher-loop.ts:111` — `startCashOutPoller`

**Done when**
- [ ] A downed anchor produces one clear user-facing state and stops hammering.
- [ ] Every failed poll is attributable after the fact.

---

### 3.8 - Off-ramp telemetry table

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** A→S (this is the dataset nobody else on Stellar has)

**Context**
`MAINTAINER.md` item 2: "cheap now, the moat later". Every off-ramp job passes
through code that already knows the anchor, the corridor, the quoted rate and
the settlement time. Nothing records it.

**Problem**
Anchor settlement latency and effective NGN spread on Stellar are unmeasured
publicly. Months of even modest volume make this the only such dataset — the
leverage for an anchor relationship (3.6) and the credible follow-on grant
angle ("anchor telemetry & reliability layer"). Cheap to add now, impossible to
backfill later.

**What needs to be done**
1. Table `offramp_telemetry (id, anchor_domain, corridor, sell_asset, sell_amount,
   indicative_rate, quoted_rate, quoted_at, initiated_at, settled_at,
   effective_rate, fee_amount, status, failure_reason)`.
2. Write passively from `quote()`, `initiate()` and every `status()` transition —
   no product surface consumes it yet, by design.
3. Derive `effective_rate` from the anchor-reported `amount_out` at settlement,
   not from the quote.
4. `GET /telemetry/summary` (auth-gated, 6.x): count, p50/p95 settlement latency,
   mean quoted-vs-effective spread, per anchor and corridor.
5. Weekly anonymised CSV export job for the eventual public dataset.
6. Explicitly out of scope: any product built on this data. Collect first.

**Key files**
- `apps/api/src/db/schema.ts`
- `apps/api/src/services/link-service.ts:120,156`

**Done when**
- [ ] Every cash-out writes exactly one telemetry row, updated through settlement.
- [ ] Summary endpoint returns real percentiles over accumulated rows.

---
## `apps/api` — service, worker, persistence (4.x)

---

### 4.1 - Replace boot-time DDL with real Drizzle migrations

**Complexity:** Medium - 150 Points · `type:refactor`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`bootstrap(client)` issues `CREATE TABLE IF NOT EXISTS` on every start. There is
a `drizzle.config.ts` but no migration history.

**Problem**
`IF NOT EXISTS` can create a schema but can never *change* one. Half this
backlog adds columns (`overpaidAmount`, `muxedId`, `sellerId` scoping) and
tables (`link_payments`, `offramp_jobs`, `offramp_telemetry`, `seller_kyc`). With
no migration story, every one of those is a manual production surgery on a
database holding payment records — and two deploys can disagree about the shape
of the same table with no error.

**What needs to be done**
1. Generate the baseline migration from the current schema (`drizzle-kit generate`).
2. Run migrations on boot with an advisory lock so concurrent instances cannot
   race; fail fast and refuse to serve if migration fails.
3. `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:status` scripts.
4. Delete `bootstrap()`'s DDL once the baseline is applied everywhere.
5. CI step that asserts the schema and the migrations have not drifted apart.

**Key files**
- `apps/api/src/db/client.ts` — `bootstrap`
- `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.ts`

**Done when**
- [ ] A fresh database and an existing one both converge via migrations only.
- [ ] CI fails on schema/migration drift.

---

### 4.2 - Durable webhook delivery queue

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`WebhookSender` retries 4 times with jittered backoff, in-process. Its own
docblock admits: "a crash mid-backoff loses pending retries."

**Problem**
`link.paid` is the event a merchant's fulfilment depends on. Losing it because
the API restarted during a backoff means an order that was paid on-chain is
never fulfilled — the failure mode that makes a payments product untrustworthy.
The delivery record only stores the final outcome, so nobody can even tell it
happened.

**What needs to be done**
1. Table `webhook_queue (id, webhook_id, link_id, event, payload, attempts,
   next_attempt_at, status, last_status_code, last_error, created_at, updated_at)`.
2. `fireWebhook` enqueues and returns immediately — event emission must never
   block a state transition.
3. A delivery worker claims due rows (`next_attempt_at <= now`, atomic
   claim so multiple instances cannot double-send), delivers, reschedules with
   exponential backoff, and dead-letters after N attempts.
4. Record every attempt in `webhook_deliveries`, not just the last.
5. `POST /webhooks/deliveries/:id/replay` for manual redelivery.
6. Preserve the exact signing scheme and headers — receivers must not need changes.

**Key files**
- `apps/api/src/services/webhook-sender.ts:29` — the acknowledged gap
- `apps/api/src/services/link-service.ts:183` — `fireWebhook`
- `apps/api/src/db/schema.ts:39` — `webhookDeliveries`

**Done when**
- [ ] Killing the API mid-backoff still delivers the event after restart.
- [ ] Every attempt is queryable; dead letters are replayable.

---

### 4.3 - SSRF guard on webhook registration

**Complexity:** High - 200 Points · `type:security`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`registerWebhookSchema` validates `z.string().url()` and nothing else. The
server then POSTs a JSON body to that URL on every payment event.

**Problem**
This is a server-side request forgery primitive with a built-in trigger. Once
webhook registration is open to any seller (6.x), an attacker registers
`http://169.254.169.254/latest/meta-data/`, `http://localhost:8787/links`, or an
internal Render address, and uses our own service to reach things they cannot.
Redirects widen it further — the SDK follows them by default.

**What needs to be done**
1. Enforce `https` only (allow `http` solely when `NODE_ENV !== "production"`).
2. Resolve the hostname and reject any address in a private/reserved range —
   `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`,
   IPv4-mapped IPv6 — and re-check at delivery time to defeat DNS rebinding
   (resolve once, connect to the resolved IP).
3. `redirect: "manual"` on the delivery fetch; treat 3xx as a failed attempt.
4. Block non-standard ports; cap response reads; keep the existing 8 s timeout.
5. Optional `WEBHOOK_HOST_ALLOWLIST` for locked-down deployments.
6. Unit tests per rejected class, including a rebinding simulation.

**Key files**
- `packages/core/src/schemas.ts:21` — `registerWebhookSchema`
- `apps/api/src/services/webhook-sender.ts:65` — the fetch
- `apps/api/src/routes/webhooks.ts`

**Done when**
- [ ] Every private-range and loopback target is rejected at registration *and* at delivery.
- [ ] Redirects cannot escape the guard.

---

### 4.4 - Webhook lifecycle: list, delete, rotate, inspect

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** none

**Context**
`WebhookRepository` exposes `create`, `listBySeller` and `recordDelivery`. The
route surface is create + list.

**Problem**
A secret, once issued, can never be rotated and an endpoint can never be
removed. If a merchant's secret leaks, their only remedy is to ask us to edit
the database. Delivery history is written but unreadable, so nobody can debug a
missed event.

**What needs to be done**
1. `DELETE /webhooks/:id`, `POST /webhooks/:id/rotate-secret` (returns the new
   secret exactly once), `GET /webhooks/:id/deliveries?limit=&cursor=`.
2. Return the secret only at creation and rotation; store a hash plus a
   display-only last-4 elsewhere.
3. Support an overlap window: accept the previous secret for 24 h after rotation
   so a merchant can deploy without dropping events.
4. Dashboard panel: endpoints, last delivery status, rotate, delete, replay.

**Key files**
- `apps/api/src/routes/webhooks.ts`
- `apps/api/src/repos/index.ts`
- `packages/core/src/ports/index.ts:158` — `WebhookRepository`

**Done when**
- [ ] A merchant can rotate a leaked secret with zero dropped events.
- [ ] Delivery history is visible in the dashboard.

---

### 4.5 - Rate limiter: proxy trust and a shared store

**Complexity:** Medium - 150 Points · `type:security`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`clientIp` takes the first entry of `x-forwarded-for` unconditionally, and the
counter map is per-process.

**Problem**
`x-forwarded-for` is attacker-controlled unless a trusted proxy is guaranteed to
overwrite it. Anyone can send a fresh spoofed value per request and bypass the
limit entirely — the limiter currently protects against accident, not intent.
Separately, scaling past one Render instance divides the effective limit by the
instance count.

**What needs to be done**
1. `TRUST_PROXY_HOPS` (default 1 in production, 0 locally): take the *n*-th
   entry from the right of `x-forwarded-for`, not the first from the left.
2. Fall back to the socket address when the header is absent or malformed.
3. Pluggable store behind a small interface; add a Redis-backed store used when
   `REDIS_URL` is set, in-memory otherwise.
4. Separate, tighter buckets for expensive routes (`POST /links`,
   `POST /links/:id/cash-out`) than for reads.
5. Tests asserting a spoofed `x-forwarded-for` chain cannot reset the counter.

**Key files**
- `apps/api/src/middleware/rate-limit.ts:47` — `clientIp`
- `apps/api/src/env.ts:68`

**Done when**
- [ ] Spoofed forwarding headers cannot bypass the limit.
- [ ] Two instances share one budget when `REDIS_URL` is configured.

---

### 4.6 - Idempotency keys on link creation and cash-out

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** none

**Context**
`POST /links` and `POST /links/:id/cash-out` are unguarded. A retried request
creates a second link or starts a second withdrawal.

**Problem**
Every payments API a merchant has integrated before (Stripe, Adyen, Paystack)
takes an `Idempotency-Key`. Without one, a network timeout on cash-out can mean
two anchor withdrawals against one payment — a double payout.

**What needs to be done**
1. Table `idempotency_keys (key, seller_id, endpoint, request_hash,
   response_status, response_body, created_at)` with a 24 h TTL sweep.
2. Middleware: same key + same request hash → replay the stored response; same
   key + different body → `409 idempotency_key_reuse`.
3. Handle the in-flight case: a second request while the first is still running
   waits or returns `409 request_in_progress` — never executes twice.
4. Document the header in `docs/API.md` and honour it in the JS client (7.1).

**Key files**
- `apps/api/src/routes/links.ts:10,30`
- new `apps/api/src/middleware/idempotency.ts`

**Done when**
- [ ] A replayed cash-out request never produces a second anchor job.
- [ ] The stored response is byte-identical to the original.

---

### 4.7 - Structured logging with correlation IDs

**Complexity:** Medium - 150 Points · `type:dx`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
Logging is `console.log` with `[api]` / `[watcher]` prefixes and a `short()`
truncator that deliberately elides the identifiers you need to grep for.

**Problem**
On Render there is one flat text stream. Correlating "seller clicked cash-out"
→ "SEP-10 auth" → "SEP-38 quote" → "SEP-6 withdraw" → "poll settled" is
impossible, so every production question becomes guesswork. A truncated tx hash
cannot be searched.

**What needs to be done**
1. Adopt `pino` (JSON lines, `level` from `LOG_LEVEL`).
2. Request middleware assigns `requestId` (honour inbound `x-request-id`) and
   binds a child logger onto the context.
3. Propagate a `linkId` / `jobId` correlation field through `LinkService`, the
   watcher and the off-ramp adapters.
4. Redact secrets and PII by path: `DEFAULT_SELLER_SECRET`, SEP-10 JWTs, webhook
   secrets, every SEP-12 field.
5. Log full identifiers; keep `short()` for human-facing lines only.
6. Emit one structured line per payment matched, per state transition, per
   webhook attempt, per anchor call.

**Key files**
- `apps/api/src/index.ts:31`, `apps/api/src/worker/watcher-loop.ts:118`
- `apps/api/src/services/container.ts:64`

**Done when**
- [ ] One `requestId` traces a cash-out end to end through every subsystem.
- [ ] No secret or PII value can appear in a log line.

---

### 4.8 - Real health and readiness endpoints

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M6 - Ops & rigor

**Band lever:** hold-B (a green health check on a dead watcher is how a live demo silently breaks)

**Context**
`GET /health` returns `{ ok: true, network, sellerWallet }` — computed from
config, never from state. Render's health check points at it.

**Problem**
It returns 200 while the database is unreachable, the watcher loop has died, the
anchor is down, or the seller wallet has lost its trustline. The service can be
fully broken and every monitor stays green — and it leaks the seller wallet
address to unauthenticated callers.

**What needs to be done**
1. `GET /health` — liveness only: process up. Cheap, unauthenticated, no config
   detail beyond `ok` and version.
2. `GET /ready` — readiness: database `SELECT 1`, last successful watcher tick
   within `3 × WATCH_POLL_MS`, migrations applied, anchor circuit closed (3.7),
   destination trustline valid (2.3). Non-200 on failure with a per-check
   breakdown.
3. Watcher records `lastTickAt` / `lastError` in a shared status object.
4. Point Render's health check at `/ready`.
5. Remove `sellerWallet` from the unauthenticated response.

**Key files**
- `apps/api/src/index.ts:17`
- `apps/api/src/worker/watcher-loop.ts:34`
- `render.yaml:18` — `healthCheckPath`

**Done when**
- [ ] Stopping the watcher turns `/ready` red within one interval.
- [ ] `/health` exposes no wallet address.

---

### 4.9 - Graceful shutdown that drains in-flight work

**Complexity:** Medium - 150 Points · `type:bug`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
`shutdown()` calls `container.stop()` then `process.exit(0)` synchronously.

**Problem**
`stop()` only clears timers. An in-flight watcher tick, a half-written cursor, a
webhook mid-backoff and an open anchor request are all killed on the spot. Every
Render deploy is therefore a small chance of a lost webhook or a replayed page
of payments.

**What needs to be done**
1. Stop accepting new connections, then await: current watcher tick, current
   cash-out poll, in-flight webhook attempts (bounded by `SHUTDOWN_TIMEOUT_MS`,
   default 15 s).
2. Make `WatcherLoop.stop()` return a promise that resolves after the running
   tick settles; carry an `AbortSignal` into Horizon and anchor calls.
3. Flush and close the database client last.
4. `process.exit(1)` on timeout, with a log line naming what was still pending.
5. Handle `SIGTERM` (Render/Docker) identically to `SIGINT`.

**Key files**
- `apps/api/src/index.ts:37`
- `apps/api/src/services/container.ts:79` — `stop`
- `apps/api/src/worker/watcher-loop.ts:50`

**Done when**
- [ ] `SIGTERM` mid-tick completes the tick and persists the cursor before exit.
- [ ] Rolling deploys drop no webhooks.

---

### 4.10 - Integration test suite for the API

**Complexity:** High - 200 Points · `type:test`

**Milestone:** M6 - Ops & rigor

**Band lever:** none (D8)

**Context**
`packages/core` has 29 unit tests; `packages/offramp` has a live-flagged anchor
test. `apps/api` — routes, worker, repositories, webhook delivery — has **zero**.

**Problem**
Every behaviour that emerges from wiring is untested: route validation, status
transitions through the service, cursor persistence, idempotency of the
processed-tx ledger, webhook signing. That is where the bugs in this backlog
live, and where a contributor's PR could regress the product invisibly.

**What needs to be done**
1. Test harness: in-memory libSQL (`file::memory:`), migrations applied,
   container built with fake `RailPort` / `WatcherPort` / `OffRampPort`.
2. Route tests over `app.request()` — no network: create/list/get link,
   validation failures, cash-out happy path, cash-out from a non-`paid` link,
   404s, rate-limit headers.
3. Worker tests: a scripted payment sequence drives `active → paid`; replaying
   the same tx is a no-op; cursor advances exactly once; a crash between
   `markProcessed` and `setCursor` does not double-apply.
4. Webhook tests: signature is verifiable with the stored secret, retry on 500,
   no retry on 400, delivery rows recorded.
5. Wire into `pnpm test`; target ≥70% line coverage on `apps/api/src`.

**Key files**
- new `apps/api/test/**`, `apps/api/vitest.config.ts`
- `.github/workflows/ci.yml:28`

**Done when**
- [ ] `pnpm test` covers the API without touching the network.
- [ ] Every issue in 1.x–4.x that lands ships with a test in this suite.

---

## `apps/web` — merchant and buyer surface (5.x)

---

### 5.1 - Wallet connect on the checkout page

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** B→A (real transaction submission from the product surface)

**Context**
Checkout renders a SEP-7 QR and an "Open in wallet" deep link. That covers
mobile wallets and nothing else.

**Problem**
A desktop buyer with Freighter, Albedo, xBull or Lobstr has to scan a QR with a
phone that holds different keys. The product's live surface never itself submits
a transaction — it only asks someone else to.

**What needs to be done**
1. Integrate `@creit.tech/stellar-wallets-kit` behind a lazily-loaded client
   component (keep it out of the initial bundle).
2. "Pay with wallet" builds the payment operation with the correct asset, amount
   and `MEMO_TEXT`, has the wallet sign, and submits via the API.
3. `POST /links/:id/submit` accepts a signed XDR, validates it matches the link
   (destination, asset, amount, memo) before submitting to Horizon, and returns
   the tx hash. Never submit an unvalidated XDR.
4. Optimistic "submitted" state that reconciles against the watcher's `paid`.
5. Preserve QR and deep link untouched as fallbacks; feature-flag the new path.
6. Failure states: user rejected, insufficient balance, missing trustline (2.3),
   wrong network.

**Key files**
- `apps/web/app/components/CheckoutClient.tsx`
- `apps/web/lib/api.ts`, `apps/api/src/routes/links.ts`

**Done when**
- [ ] A desktop Freighter user completes payment without leaving the page.
- [ ] A tampered XDR is rejected server-side.

---

### 5.2 - Payout details form driven by anchor field descriptors

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M1 - Off-ramp depth

**Band lever:** hold-B (removes the last hardcoded payload on the live surface)

**Context**
`cashOut(id)` posts `{ targetCurrency, payoutFields: {} }`. `TestAnchorOffRamp`
then reads `fields.type`, `fields.dest`, `fields.dest_extra` from that empty
object, so the withdrawal is submitted with `type: "bank_account"` and no
destination at all.

**Problem**
The seller is never asked where the money should go. Combined with 3.4's
hardcoded identity, the entire "cash out" button is a shape rather than a
transaction. This is the most visible honesty gap on the deployed demo.

**What needs to be done**
1. `GET /links/:id/offramp-requirements` returns the anchor's field descriptors
   from SEP-6 `/info` (3.3) and SEP-12 (3.4): name, type, description,
   `optional`, `choices`.
2. Render the form dynamically from descriptors — no hardcoded Nigerian bank
   fields in the component.
3. Client-side validation from the descriptors, plus a confirmation step showing
   gross / fee / net (1.5) and the quote countdown (1.2).
4. Persist the seller's payout destination for reuse, masked in the UI, never in
   logs or webhooks.
5. Disable cash-out entirely with an explanatory message while requirements are
   unmet.

**Key files**
- `apps/web/app/components/Dashboard.tsx:73`
- `apps/web/lib/api.ts:48` — `cashOut`
- `packages/offramp/src/testanchor.ts:124` — `fields.type`, `fields.dest`

**Done when**
- [ ] Cash-out cannot be submitted with empty payout fields.
- [ ] The form is generated from the anchor's own descriptors.

---

### 5.3 - Link detail and receipt page

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** none

**Context**
The dashboard is a flat table; the checkout page shows a bare tx hash on
success. Nothing links out to the ledger.

**Problem**
Neither party can prove what happened. A merchant reconciling their books has no
timeline, no payer address, no fee breakdown, no anchor reference — and no
shareable artefact to hand a customer who disputes a payment.

**What needs to be done**
1. `/links/[id]` — a full timeline: created, paid (payer, amount, tx), off-ramp
   quoted / initiated / settled, webhook attempts, all with timestamps.
2. Every hash and address links to Stellar Expert on the correct network.
3. `/r/[reference]` — a public, no-auth receipt for the buyer showing amount,
   asset, tx hash and merchant title (never the seller's KYC or payout details).
4. "Copy receipt link" and print-friendly CSS.
5. CSV export of links for a date range.

**Key files**
- new `apps/web/app/links/[id]/page.tsx`, `apps/web/app/r/[reference]/page.tsx`
- `apps/web/app/components/Dashboard.tsx:122`

**Done when**
- [ ] Every state change in a link's life is visible on one page with a ledger link.
- [ ] The public receipt leaks no seller PII.

---

### 5.4 - Honest error, empty and offline states

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** hold-B

**Context**
`http()` throws `API ${status}: ${detail}` and the dashboard renders that string
directly. `CheckoutClient`'s poll swallows every error with
`catch { /* keep polling */ }`.

**Problem**
The seller sees raw JSON and status codes. Worse, the buyer sees an eternal
"Waiting for payment…" spinner whether the payment is pending, the API is down,
or the link does not exist — a live surface that is confidently wrong. That is
precisely the class of breakage that turns a working demo into a broken one for
a stranger.

**What needs to be done**
1. Typed error envelope from the API (4.x) mapped to human copy per code.
2. Distinguish, on checkout: waiting · API unreachable · link expired ·
   link cancelled · payment detected but underpaid — each with distinct copy.
3. Track consecutive poll failures; after 3, show "we've lost contact with the
   payment service" with a manual retry, and back the interval off.
4. Skeleton loaders instead of empty tables; retry buttons on every failed fetch.
5. Global error boundary + `not-found` for unknown link ids.
6. Never render an unhandled exception message to a buyer.

**Key files**
- `apps/web/lib/api.ts:26`
- `apps/web/app/components/CheckoutClient.tsx:21`
- `apps/web/app/components/Dashboard.tsx:36`

**Done when**
- [ ] With the API stopped, both pages state clearly that the service is unreachable.
- [ ] No raw status code or stack reaches a user.

---

### 5.5 - Expiry countdown and terminal states on checkout

**Complexity:** Trivial - 100 Points · `type:feature`

**Milestone:** M4 - Merchant surface

**Band lever:** none

**Context**
Links carry `expiresAt`; checkout ignores it. Depends on 1.3.

**What needs to be done**
1. Countdown ("expires in 9:41") driven by server time, with clock-skew
   correction from a response header.
2. At zero, flip to a terminal expired card with a "request a new link" prompt —
   stop polling.
3. Distinct cards for `cancelled` and `underpaid` (showing the outstanding
   amount from 1.4).
4. Warn below two minutes remaining so a buyer mid-transfer knows to hurry.

**Key files**
- `apps/web/app/components/CheckoutClient.tsx:7`
- `apps/web/app/pay/[id]/page.tsx`

**Done when**
- [ ] An expired link never shows a payable QR.

---

### 5.6 - Embeddable checkout widget

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M5 - Distribution & grant

**Band lever:** B→A (a second, independently usable product surface)

**Context**
`MAINTAINER.md` item 5: a ~5 KB script tag rendering a "Pay ₦X" button that opens
the hosted checkout in a modal, keyed by link id. One surface — Woo/Shopify
plugins become community issues rather than our build.

**Problem**
Integration today means the merchant hand-rolls a redirect. There is no artefact
a stranger can drop into an existing site in five minutes, which is the only
distribution channel this product has.

**What needs to be done**
1. `packages/widget`, zero-dependency TS, built to a single IIFE, hard budget
   ≤5 KB gzipped (CI-enforced).
2. Usage:
   ```html
   <script src="https://quay-web.vercel.app/widget.js" defer></script>
   <button data-quay-link="lnk_123" data-quay-label="Pay ₦25,000">Pay</button>
   ```
3. Opens the hosted checkout in an iframe modal; `postMessage` events
   (`quay:paid`, `quay:closed`, `quay:error`) with a strict origin check both ways.
4. Server-side: frame-ancestors CSP so only the merchant's registered origins can
   embed, and never expose seller data through the frame.
5. Keyboard/focus trap, ESC to close, reduced-motion support, mobile full-screen.
6. A copy-pasteable snippet in the dashboard per link, plus a demo page.

**Key files**
- new `packages/widget/**`
- `apps/web/app/pay/[id]/page.tsx` — embeddable mode

**Done when**
- [ ] The bundle is ≤5 KB gzipped and CI fails if it grows.
- [ ] A plain HTML page with only the script tag can take a payment.

---

### 5.7 - Playwright end-to-end test of the payment loop

**Complexity:** High - 200 Points · `type:test`

**Milestone:** M6 - Ops & rigor

**Band lever:** hold-B (this is the pre-entry hygiene sweep, automated)

**Context**
`MAINTAINER.md`'s standing rule is a manual sweep of the live surface for mock
data and broken flows before every wave entry. The last entry shipped with the
API undeployed and "Create link" dead-ending — exactly what an automated sweep
catches.

**What needs to be done**
1. Playwright suite against a locally-composed stack (API + web + in-memory DB +
   fake rail/watcher): create link → open checkout → simulate payment → assert
   `paid` → cash out (mock adapter) → assert `offramp_settled`.
2. A separate `@live` suite against the deployed URLs that asserts: `/ready` is
   green, link creation succeeds from a clean browser context, and the checkout
   page renders a QR — the exact stranger path.
3. A scan step that fails on placeholder strings (`Demo Seller`, `example.com`,
   `localhost:8787`, `TODO`, `lorem`) in the **rendered** production HTML.
4. Run the local suite on every PR; run the `@live` suite nightly and on demand.
5. `pnpm sweep` runs the live suite locally — the pre-entry ritual as one command.

**Key files**
- new `apps/web/e2e/**`, `playwright.config.ts`
- `.github/workflows/ci.yml`

**Done when**
- [ ] `pnpm sweep` fails if the deployed stranger flow is broken or shows placeholder data.
- [ ] The local suite runs in CI without network access.

---
## Wallet-native auth and multi-tenancy (6.x)

`MAINTAINER.md` item 3. Skip email/password entirely: the seller's Stellar
address **is** the identity and the payout destination. Ship 6.1 → 6.4 as one
arc; the intermediate states are not safely deployable.

---

### 6.1 - SEP-10-style wallet challenge login

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** B→A (SEP-10 implemented on the *server* side, not just consumed)

**Context**
We already act as a SEP-10 *client* against anchors (`packages/offramp/src/sep10.ts`).
The same protocol, inverted, is the cleanest possible login for a Stellar-native
product — and implementing the server half is genuinely deeper protocol work
than consuming it.

**Problem**
There is no login at all. `README.md` states it plainly: "Single hard-coded demo
seller, no API keys / login."

**What needs to be done**
1. `GET /auth?account=G…` builds a SEP-10 challenge transaction: sequence 0,
   `manage_data` op named `<home_domain> auth` with a 48-byte nonce, a
   `web_auth_domain` op, 15-minute timebounds, signed by `SERVER_SIGNING_KEY`.
2. `POST /auth` verifies: our signature intact, the client signed with the
   claimed account, timebounds valid, nonce unused (single-use store), operation
   names and `web_auth_domain` correct, correct network passphrase.
3. Support signers on the account: check `M`-of-`N` thresholds via Horizon rather
   than assuming a single master key.
4. Publish `/.well-known/stellar.toml` with `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`,
   `NETWORK_PASSPHRASE` — we become discoverable by the same standard we consume.
5. On success, create the seller if absent (address = identity) and issue the
   session token from 6.2.

**Key files**
- new `apps/api/src/routes/auth.ts`, `apps/api/src/services/challenge.ts`
- `packages/offramp/src/sep10.ts` — the client-side reference
- `apps/web` — connect-wallet button reusing the kit from 5.1

**Done when**
- [ ] A wallet-signed challenge yields a session; a replayed or tampered challenge never does.
- [ ] Our `stellar.toml` validates against SEP-1.

---

### 6.2 - Session tokens and auth middleware

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
Follows 6.1. Every route is currently anonymous.

**What needs to be done**
1. Issue a short-lived JWT (`sub` = G-address, `exp` ≤ 24 h, `jti`) signed with
   `JWT_SECRET`; refresh by re-signing a challenge, no long-lived refresh token.
2. `requireSeller` middleware resolving `Authorization: Bearer` → seller, bound
   onto the request context.
3. Revocation list keyed by `jti` for logout and compromise.
4. Web: token in memory + an httpOnly cookie for SSR; never `localStorage`.
5. Clear 401 vs 403 semantics and a typed error body.

**Key files**
- new `apps/api/src/middleware/auth.ts`
- `apps/api/src/index.ts:13`, `apps/web/lib/api.ts`

**Done when**
- [ ] Protected routes reject missing, expired, tampered and revoked tokens.

---

### 6.3 - Scoped API keys for programmatic access

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
A merchant server cannot sign a wallet challenge on every request; it needs a
static credential. `MAINTAINER.md`: `ak_live_…`, store hash only.

**What needs to be done**
1. Table `api_keys (id, seller_id, name, prefix, hash, scopes, last_used_at,
   created_at, revoked_at)`.
2. Format `ak_live_<32 random base62>` / `ak_test_…`; store an Argon2id (or
   scrypt) hash plus a searchable 8-char prefix. Show the full key exactly once.
3. Scopes: `links:read`, `links:write`, `webhooks:manage`, `offramp:initiate`.
   `offramp:initiate` must be opt-in and off by default — it moves money.
4. Constant-time verification; per-key rate-limit bucket (4.5); update
   `last_used_at` asynchronously.
5. Dashboard: create, name, scope, reveal-once, revoke, last-used.
6. Both auth schemes resolve to the same seller context so routes stay agnostic.

**Key files**
- new `apps/api/src/services/api-keys.ts`
- `apps/api/src/middleware/auth.ts`, `apps/api/src/db/schema.ts`

**Done when**
- [ ] No plaintext key is ever stored or logged.
- [ ] A key without `offramp:initiate` cannot trigger a cash-out.

---

### 6.4 - Scope every route by seller and delete the default-seller singleton

**Complexity:** High - 200 Points · `type:security`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`LinkService` calls `sellers.getDefault()` in `createLink` and `listLinks`;
`SellerRepository` exposes `getDefault()` as a first-class operation;
`GET /links` returns every link in the database.

**Problem**
There is exactly one tenant, and it is global. Anyone who can reach the API can
enumerate every link, create links that pay into the operator's wallet, and
trigger a cash-out on a payment they did not receive. Multi-tenancy is not a
feature here — it is the difference between a demo and a product.

**What needs to be done**
1. Delete `getDefault()` from the port and every call site; a seller comes from
   the authenticated context or the request fails.
2. `createLink` takes `sellerId` and sets `destination` to that seller's own
   verified wallet — never a client-supplied address.
3. `listLinks`, `getLink`, `triggerCashOut`, `cancel` and all webhook routes
   filter by `sellerId`; a cross-tenant id returns 404, never 403 (do not
   confirm existence).
4. Repository methods take `sellerId` explicitly so the filter cannot be
   forgotten at a call site.
5. Public reads stay public but minimal: the checkout endpoint returns only what
   the buyer needs (title, amount, asset, memo, status) — never the seller record.
6. Migration path for existing single-tenant rows; keep `DEFAULT_SELLER_WALLET`
   working for local dev behind `SINGLE_TENANT_DEV=1`, hard-disabled in production.
7. Cross-tenant access tests for every route.

**Key files**
- `apps/api/src/services/link-service.ts:54,75`
- `packages/core/src/ports/index.ts:136` — `SellerRepository`
- `apps/api/src/routes/links.ts`, `apps/api/src/routes/webhooks.ts`

**Done when**
- [ ] Seller A cannot see, cancel or cash out any object belonging to seller B.
- [ ] `getDefault()` no longer exists in the codebase.

---

### 6.5 - Per-seller watcher fan-out with fairness limits

**Complexity:** Medium - 150 Points · `type:perf`

**Milestone:** M2 - Multi-tenant platform

**Band lever:** none

**Context**
`runOnce` iterates `activeDestinations()` sequentially, one Horizon round-trip
per account per tick. `WatcherPort` is already per-account, so the shape is
right; the scheduling is not.

**Problem**
With one seller this is invisible. With 200, a tick takes 200 sequential
round-trips, the effective poll interval becomes minutes, and one slow or
erroring account delays every other seller's settlement.

**What needs to be done**
1. Bounded-concurrency fan-out (default 10) instead of a sequential loop.
2. Per-account adaptive interval: back off accounts that have been idle for many
   ticks, poll accounts with a recently created link aggressively.
3. Per-account circuit breaker so a persistently failing account cannot consume
   the budget; surface it in `/ready` (4.8).
4. Cap accounts processed per tick with a fair round-robin cursor — no account
   can be starved.
5. Metrics (8.3): accounts watched, tick duration, per-account lag.

**Key files**
- `apps/api/src/worker/watcher-loop.ts:56` — `runOnce`
- `packages/core/src/ports/index.ts:122` — `activeDestinations`

**Done when**
- [ ] 200 simulated destinations complete a tick inside one poll interval.
- [ ] One failing account cannot delay the others.

---

## Distribution, docs and grant framing (7.x)

---

### 7.1 - Publish the packages to npm with a runnable example

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M5 - Distribution & grant

**Band lever:** hold-B (a second live surface a stranger can use without cloning)

**Context**
`@checkout/core`, `@checkout/stellar` and `@checkout/offramp` are private
workspace packages. `@checkout/*` is also not a scope we own.

**Problem**
Nothing here is installable. A developer who wants only the SEP-7 builder, the
payment matcher or the off-ramp port has to clone the monorepo. An installable
artefact is a distribution channel we currently do not have.

**What needs to be done**
1. Rename the scope to `@quay/*` (`core`, `stellar`, `offramp`) across the
   workspace, `tsconfig` paths and every import.
2. Build ESM + CJS + `.d.ts` (tsup), set `exports`, `files`, `sideEffects: false`,
   `repository`, `license`, `engines`.
3. Adopt Changesets: versioning, changelog generation, `npm publish
   --provenance` from CI on a tagged release.
4. `examples/watch-payments` — ~30 lines that watch an address and print matched
   payments, runnable with `npx tsx examples/watch-payments.ts G…`.
5. README badges and an install snippet per package.
6. Publish `0.1.0` and verify a clean `npm i @quay/core` in an empty directory.

**Key files**
- `packages/*/package.json`, `pnpm-workspace.yaml`, `turbo.json`
- new `.changeset/`, `examples/`

**Done when**
- [ ] `npm i @quay/core` works outside this repo and the example runs against testnet.

---

### 7.2 - ARCHITECTURE.md with the ports-and-adapters map

**Complexity:** Medium - 150 Points · `type:docs`

**Milestone:** M5 - Distribution & grant

**Band lever:** none

**Context**
The README explains *why* the boundaries exist; nothing explains *how* the
pieces connect. Contributors are currently reading `container.ts` to find out.

**What needs to be done**
1. `docs/ARCHITECTURE.md`: package graph, the three ports and their
   implementations, and the rule "the domain never imports a chain SDK" with the
   enforcement story.
2. Mermaid sequence diagrams for: link creation, payment detection and matching,
   cash-out (SEP-10 → SEP-38 → SEP-6, and the SEP-24 interactive variant).
3. State diagram of `LINK_STATUSES` generated from `TRANSITIONS` so it cannot
   drift from the code.
4. An explicit "how to add a new chain / anchor / rail" walkthrough.
5. A decisions section: why polling, why `seller_initiated` only, why SEP-6 in
   the reference adapter, why path payments are parked (with the liquidity table
   from `MAINTAINER.md`).

**Key files**
- new `docs/ARCHITECTURE.md`; `packages/core/src/domain/status.ts:17`

**Done when**
- [ ] A new contributor can locate the right seam for a change without reading `container.ts`.

---

### 7.3 - Grant proposal with itemized budget and milestones

**Complexity:** Medium - 150 Points · `type:docs`

**Milestone:** M5 - Distribution & grant

**Band lever:** grade modifier (×1.05 for an explicit tiered ask with a budget)

**Context**
`MAINTAINER.md` item 5 calls for an SCF Build submission with the deployed
testnet demo. No proposal document exists.

**What needs to be done**
1. `docs/PROPOSAL.md`: problem, the specific wedge ("the inbound counterpart to
   the Stellar Disbursement Platform"), why Stellar's anchor network is the only
   place this works, and the current state with links to the live demo.
2. Milestones mapped to this backlog's M1–M6 with dates and acceptance criteria.
3. Itemized budget by bucket — engineering, anchor integration, audit, infra —
   with amounts and justification, not a lump sum.
4. Traction section fed by real telemetry (3.8): links created, payments
   settled, cash-outs completed, measured settlement latency.
5. Risk register: anchor dependency, NGNC liquidity (with the measured path
   payment data), regulatory boundary on `inline` mode.
6. Keep it honest — testnet is testnet, and say so in the first paragraph.

**Key files**
- new `docs/PROPOSAL.md`; `MAINTAINER.md:45` — the liquidity findings

**Done when**
- [ ] The proposal states a specific tier, a specific amount, and per-bucket justification.

---

### 7.4 - FIXLOG.md linking every fixed defect to its regression test

**Complexity:** Trivial - 100 Points · `type:docs`

**Milestone:** M5 - Distribution & grant

**Band lever:** none

**Context**
A fix-log with regression tests is a cheap, high-signal artefact: it shows a
project that finds its own bugs and prevents their return.

**What needs to be done**
1. `docs/FIXLOG.md`, one row per defect: date · symptom · root cause · fix
   commit · the test that now prevents it.
2. Backfill the bugs this backlog names — stuck jobs after restart (3.1),
   unreachable top-up path (1.4), `no_memo` on transaction-fetch failure (2.5),
   the undeployed-API entry (`MAINTAINER.md:8`).
3. Adopt the rule: no bug fix merges without a regression test and a row here.
4. Add the row requirement to the PR template.

**Key files**
- new `docs/FIXLOG.md`; `.github/PULL_REQUEST_TEMPLATE.md`

**Done when**
- [ ] Every fixed bug has a row and a named test.

---

### 7.5 - Seeded testnet demo script

**Complexity:** Medium - 150 Points · `type:dx`

**Milestone:** M5 - Distribution & grant

**Band lever:** none

**Context**
A first-time visitor to the live demo sees an empty dashboard and has to fund a
testnet wallet before anything happens.

**What needs to be done**
1. `pnpm demo:seed` — creates a funded testnet keypair via Friendbot, adds the
   USDC trustline, creates a handful of links, and pays some of them from a
   second funded account so the dashboard shows real `paid` and `offramp_settled`
   rows.
2. Every seeded row is **real on-chain testnet data** — never fabricated. Label
   them clearly as demo data in the UI.
3. `pnpm demo:reset` to clear seeded rows.
4. A "Try it" flow on the live demo that provisions a sandbox seller and walks a
   visitor through one payment.
5. Document it in the README's demo section.

**Key files**
- new `scripts/demo-seed.ts`; `package.json`, `README.md:6`

**Done when**
- [ ] A stranger sees a populated, genuinely on-chain dashboard within a minute.
- [ ] No seeded value is fabricated.

---

### 7.6 - README repositioning and integration quickstart

**Complexity:** Trivial - 100 Points · `type:docs`

**Milestone:** M5 - Distribution & grant

**Band lever:** none

**Context**
`MAINTAINER.md` item 5 specifies the first line: "the open-source, non-custodial
merchant checkout for the Stellar anchor network — the inbound counterpart to the
Stellar Disbursement Platform."

**What needs to be done**
1. Rewrite the opening paragraph to that positioning; keep the honest
   what's-real-vs-stubbed table, which is the README's best asset.
2. Add a five-minute integration quickstart: install the widget (5.6), create a
   link via API, receive the webhook — with copy-pasteable snippets.
3. Link `ARCHITECTURE.md`, `PROPOSAL.md`, `FIXLOG.md` and `ISSUES.md`.
4. Keep the "Before you go live" section verbatim — it is the honesty signal.
5. Update the status table as each backlog item lands; never let it overstate.

**Key files**
- `README.md:1`, `README.md:109` — the status table

**Done when**
- [ ] The first line states the positioning and the status table matches the code.

---

### 7.7 - Contributor ladder and issue triage

**Complexity:** Trivial - 100 Points · `type:dx`

**Milestone:** M5 - Distribution & grant

**Band lever:** none

**Context**
`CONTRIBUTING.md`, a code of conduct and issue templates exist. Labels, wave
tagging and a first-issue path do not.

**What needs to be done**
1. Apply the label taxonomy this file assumes (`area:*`, `type:*`,
   `complexity:*`, `Stellar Wave`, `good-first-issue`, `help-wanted`).
2. Mark 8–10 genuinely self-contained issues `good-first-issue` (1.6, 5.5, 7.4,
   7.6, 8.5, 8.7 are the natural set) and add a "first PR" walkthrough in
   `CONTRIBUTING.md`.
3. `CODEOWNERS` plus a documented review SLA.
4. A `docs/TRIAGE.md` cadence: label within 48 h, close stale in 30 days.
5. Stop squashing — commit velocity is legible to reviewers, and a squashed drop
   reads as a code dump (`MAINTAINER.md:120`).

**Key files**
- `.github/` labels, `CONTRIBUTING.md`, new `.github/CODEOWNERS`

**Done when**
- [ ] Every open issue carries area, type and complexity labels.
- [ ] A newcomer has a labelled, self-contained path to a first PR.

---

## Ops, CI and observability (8.x)

---

### 8.1 - Coverage gating in CI

**Complexity:** Medium - 150 Points · `type:test`

**Milestone:** M6 - Ops & rigor

**Band lever:** none (D8)

**Context**
CI runs typecheck, test, build. `pnpm test` covers `packages/core` only, and no
threshold is enforced.

**What needs to be done**
1. Enable `@vitest/coverage-v8` in every package; aggregate across the workspace.
2. Thresholds: `packages/core` ≥90%, `packages/stellar` and `packages/offramp`
   ≥70%, `apps/api` ≥70% once 4.10 lands. Fail the build below them.
3. Upload the report as a CI artifact and comment the delta on PRs.
4. Ratchet-only rule: thresholds may rise, never fall.
5. Exclude generated files and type-only modules explicitly.

**Key files**
- `.github/workflows/ci.yml:28`, `packages/*/vitest.config.ts`

**Done when**
- [ ] A PR that drops coverage below threshold fails CI.

---

### 8.2 - Nightly live-anchor probe

**Complexity:** Medium - 150 Points · `type:test`

**Milestone:** M6 - Ops & rigor

**Band lever:** hold-B (proves the SEP flow is still live, continuously)

**Context**
`packages/offramp/test/testanchor.test.ts` runs the real SEP-10 → SEP-38 → SEP-6
flow but only when `RUN_LIVE_ANCHOR_TESTS=1`, which nothing sets. `MAINTAINER.md`
asks for it to be run manually, once.

**Problem**
The off-ramp depth claim rests on a flow nobody verifies on a schedule. If
testanchor rotates a key, changes a path or drops USD quoting, we find out from a
seller — or from a reviewer looking at a broken demo.

**What needs to be done**
1. `.github/workflows/anchor-probe.yml`, nightly cron plus `workflow_dispatch`.
2. Runs the live-flagged suite with a funded testnet keypair from repo secrets;
   asserts SEP-1 discovery, SEP-10 auth, a SEP-38 quote and a SEP-6 withdrawal
   reaching a non-error status.
3. Publishes latency and quoted rate into telemetry (3.8) so the probe itself
   builds the dataset.
4. Opens (or updates) a GitHub issue on failure rather than emailing into a void.
5. A README badge showing last probe status — an honest, live signal.

**Key files**
- new `.github/workflows/anchor-probe.yml`
- `packages/offramp/test/testanchor.test.ts`

**Done when**
- [ ] The probe runs nightly and files an issue when the anchor flow breaks.

---

### 8.3 - Prometheus metrics endpoint

**Complexity:** Medium - 150 Points · `type:feature`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
Everything operational is currently a `console.log`. There is no way to answer
"how long between payment and `paid`?" without reading raw logs.

**What needs to be done**
1. `GET /metrics` (guarded by `METRICS_TOKEN`) in Prometheus text format.
2. Counters: payments matched by outcome, links by status transition, webhook
   attempts by result, anchor calls by SEP and status.
3. Histograms: watcher tick duration, payment-to-`paid` latency, anchor call
   latency, quote-to-settlement duration.
4. Gauges: accounts watched, pending cash-outs, queued webhooks, circuit-breaker
   state, watcher lag in seconds.
5. A ready-made Grafana dashboard JSON in `docs/`.

**Key files**
- new `apps/api/src/metrics.ts`; `apps/api/src/index.ts`

**Done when**
- [ ] Watcher lag and payment-to-paid latency are graphable without touching logs.

---

### 8.4 - Harden the API Dockerfile

**Complexity:** Medium - 150 Points · `type:security`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
`apps/api/Dockerfile` is the deploy artefact for the Render service defined in
`render.yaml`.

**What needs to be done**
1. Multi-stage build: deps → build → a slim runtime stage carrying only
   production `node_modules` and compiled output.
2. Run as a non-root user; read-only root filesystem with a writable tmpfs.
3. Pin the base image by digest, not tag; document the update cadence.
4. `HEALTHCHECK` hitting `/ready` (4.8); `dumb-init` (or `--init`) so signals
   reach the process for graceful shutdown (4.9).
5. `.dockerignore` audit — no `.env`, no `.git`, no test fixtures in the image.
6. Trivy scan in CI, failing on HIGH/CRITICAL.
7. Record the final image size; target under 200 MB.

**Key files**
- `apps/api/Dockerfile`, `.dockerignore`, `render.yaml`

**Done when**
- [ ] The container runs as non-root and passes a clean Trivy scan.
- [ ] `SIGTERM` reaches the Node process.

---

### 8.5 - Dependency audit and secret scanning in CI

**Complexity:** Trivial - 100 Points · `type:security`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
The repo handles Stellar secret keys, anchor JWTs and webhook secrets. `.env` is
correctly gitignored — the job now is to keep it that way mechanically.

**What needs to be done**
1. `pnpm audit --audit-level=high` in CI, with a documented allowlist file for
   accepted advisories.
2. Enable Dependabot for npm and GitHub Actions, grouped weekly.
3. Add `gitleaks` as a CI step and a pre-commit hook, with a config that catches
   Stellar secret seeds (`S` + 55 base32 chars) specifically.
4. Enable GitHub secret scanning and push protection on the repository.
5. Document the rotation procedure for `DEFAULT_SELLER_SECRET`,
   `DATABASE_AUTH_TOKEN` and `JWT_SECRET` in `SECURITY.md`.

**Key files**
- `.github/workflows/ci.yml`, new `.github/dependabot.yml`, `SECURITY.md`

**Done when**
- [ ] A committed Stellar secret seed fails CI and is blocked at push.

---

### 8.6 - Database backup, restore and runbook

**Complexity:** Medium - 150 Points · `type:ops`

**Milestone:** M6 - Ops & rigor

**Band lever:** none

**Context**
Production runs on Turso's free tier. The database holds payment records,
off-ramp jobs and (after 3.4) KYC data.

**Problem**
There is no backup, no tested restore, and no written procedure. Losing the
database loses the evidence that a merchant was paid.

**What needs to be done**
1. `pnpm db:backup` — dump to a timestamped file; nightly scheduled job pushing
   to object storage with 30-day retention.
2. `pnpm db:restore <file>` — plus a **tested** restore into a scratch database,
   run quarterly and recorded.
3. `docs/RUNBOOK.md`: deploy, rollback, restore, key rotation, anchor outage,
   watcher stuck, stuck `offramp_pending` job, incident template.
4. Encrypt backups at rest; never store KYC fields unencrypted in a dump.
5. State the RPO/RTO honestly (nightly backup ⇒ up to 24 h RPO) rather than
   implying continuous protection.

**Key files**
- new `scripts/db-backup.ts`, `docs/RUNBOOK.md`
- `apps/api/src/db/client.ts`

**Done when**
- [ ] A restore into a scratch database has been performed and documented.

---

### 8.7 - Uptime monitoring for the live demo

**Complexity:** Trivial - 100 Points · `type:ops`

**Milestone:** M6 - Ops & rigor

**Band lever:** hold-B (the demo being reachable is the surface half of the loop)

**Context**
The last wave entry shipped with `stellar-checkout-api.fly.dev` not resolving and
the web bundle falling back to `localhost:8787`. Nothing detected it.

**What needs to be done**
1. External uptime checks against `https://quay-api.onrender.com/ready` and the
   Vercel dashboard root, at 5-minute intervals.
2. Alert to a channel that is actually read, with a 2-failure threshold.
3. A synthetic check that creates a link through the public API and asserts a
   201 — reachability is not the same as working.
4. Status badges in the README, and a `docs/STATUS.md` with the last 90 days.
5. Wire the same checks into `pnpm sweep` (5.7) so the pre-entry ritual is one
   command.

**Key files**
- `README.md:6` — the demo links; new `docs/STATUS.md`

**Done when**
- [ ] A broken deploy pages someone within five minutes, not at the next wave entry.

---

## `contracts/` — Soroban and on-chain attestation (9.x)

### 9.2 - Wire the attestation contract into the settlement path

**Complexity:** High - 200 Points · `type:feature`

**Milestone:** M3 - Settlement correctness

**Band lever:** A→S

**Context**
`contracts/quay-attest` is deployed to testnet as
`CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3` and verified live
(issue 9.1). Nothing in the product calls it yet, so today it proves the
capability exists but not that Quay uses it — and a contract the product does
not invoke is not depth, it is a demo.

**Problem**
A Quay receipt currently asserts "this invoice was paid" on the authority of
Quay's own database. For a non-custodial checkout that is the one claim that
most needs to be independently checkable, and it is the one claim a reader has
to take on trust.

**What needs to be done**
1. `AttestationPort` in `packages/core/src/ports/index.ts` — plain string/number
   types only, no `@stellar/*` import, so `check-domain-boundary` stays green.
2. A `packages/soroban` adapter implementing it over `@stellar/stellar-sdk`'s
   `rpc`/`contract` modules (already on 16.0.1 — no dependency bump needed).
3. Call it from `LinkService.applyMatch()` **after** the `paid` transition is
   persisted, fire-and-forget with the same `.catch(() => {})` discipline as
   `touchLastUsed` in `middleware/auth.ts`. A Soroban RPC outage must degrade to
   "not yet attested", never to "payment not marked paid".
4. Three nullable columns on `links` (`attestation_tx_hash`,
   `attestation_ledger`, `attested_at`) — additive DDL only.
5. Extend the existing `startCashOutPoller` timer to sweep `paid` links with a
   null `attestation_tx_hash`, so a failed attestation retries.
6. Surface it on `GET /r/:reference` and link it from the receipt page, so a
   buyer can check the ledger without trusting us.

**Constraints**
- **No new link status.** `paid` keeps its single outgoing edge to
  `offramp_pending`; attestation is a side-effect of settlement, not a state.
  This deliberately avoids the three-file status-machine change.
- The attester is the API's SEP-10 signing identity (`SERVER_SIGNING_SECRET`),
  which must be funded on testnet to pay invocation fees.

**Key files**
- `packages/core/src/ports/index.ts`, new `packages/soroban/`,
  `apps/api/src/services/link-service.ts`, `apps/api/src/db/schema.ts`,
  `apps/api/src/worker/watcher-loop.ts`, `apps/api/src/routes/public.ts`,
  `apps/web/app/r/[reference]/ReceiptClient.tsx`

**Done when**
- [ ] A payment that settles on testnet produces an on-chain attestation without
      any manual step
- [ ] `GET /r/:reference` returns the contract id, ledger and attestation tx
- [ ] Killing the Soroban RPC endpoint does not stop a payment being marked paid
- [ ] An attestation that failed is retried by the sweep and eventually lands
- [ ] `pnpm docs:check-domain-boundary` still passes

---

## Appendix — sequencing

**Before the next wave entry (hygiene only — nothing new on the live surface):**
5.7 (`pnpm sweep`), 8.7, 4.8. These prove the loop is closed rather than
extending it, and none of them add mock-wired surface to the entry snapshot.

**Band lever order after the entry:** 1.1 → 3.2 → 3.3 → 3.6 is the B→A arc; do
not start 3.6 before the anchor relationship is confirmed. 3.8 is cheap and
compounds — start writing telemetry rows the day 3.1 lands.

**Correctness debt that must not wait:** 3.1 (jobs lost on restart), 2.3
(payments that can never land), 3.4 and 5.2 (placeholder data reaching a real
anchor), 1.4 (top-ups that can never complete). These are live-surface defects,
and a demoted band is the cheapest thing they cost.

**Do not do before an entry:** docs-only work (7.2, 7.4, 7.6), extra CI
workflows, or anything that puts a new page on the live demo without wiring it
to real data first.
