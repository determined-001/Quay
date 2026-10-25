# Mainnet cutover

Moving Quay from the Stellar testnet to the public network (pubnet).

The code is already network-parameterised — `STELLAR_NETWORK=public` selects the
pubnet passphrase, Horizon endpoint, and USDC issuer throughout. What follows is
therefore mostly configuration, one genuine code decision (which anchor), and a
set of checks. It is written as a runbook: do the steps in order, and do not
skip the verification at the end of each phase.

**Read this first:** the public-network guardrails throw at boot rather than
warn. A service that refuses to start is loud; one that quietly settles into a
sandbox anchor is not. The guards are split across three places: the OFFRAMP,
seller-secret, anchor-URL and e2e checks and the USDC issuer check fire in
`apps/api/src/env.ts` at module load; the `SERVER_SIGNING_SECRET` and
`JWT_SECRET` checks (`resolveServerSigningKeypair`, `resolveJwtSecret`) and the
`REDIS_URL` / `SINGLE_INSTANCE` check (`assertSharedStateOrSingleInstance`) fire
in `apps/api/src/services/container.ts` inside `createContainer()`, which also
calls `assertKeyConfigured()` from `apps/api/src/services/secret-crypto.ts` for
the webhook-secret key. If a guard fires, fix the configuration — never relax the guard to get a green deploy.

---

## What the guardrails refuse

| Condition | Why it is fatal on pubnet |
|---|---|
| `OFFRAMP=mock` | The mock anchor fakes settlement 8s after cash-out and pays out nothing. Sellers would see completed cash-outs against real funds that never left. Use `none`, not `mock`, to ship without a cash-out leg. |
| `OFFRAMP=testanchor` | `testanchor.stellar.org` is the SDF testnet sandbox. It does not settle real money. |
| `DEFAULT_SELLER_SECRET` set (`STELLAR_NETWORK=public`) | Quay never signs for a seller; each seller's wallet signs its own anchor login and withdrawals. A server-side seller secret is only for the testnet demo scripts. |
| `OFFRAMP=anchor` without `ANCHOR_URL` / `ANCHOR_HOME_DOMAIN` | There is deliberately no default. A default would mean "the sandbox". |
| `ANCHOR_URL` over plain HTTP | SEP-10 auth tokens and SEP-12 KYC fields cross this connection. |
| Missing `USDC_ISSUER_PUBLIC` | Without an issuer the watcher cannot tell real USDC from an impostor asset. |
| Missing `KYC_ENCRYPTION_KEY` (`OFFRAMP=testanchor` or `anchor`; on pubnet that means `anchor`) | Seller SEP-12 PII would be stored unencrypted. Not required under `OFFRAMP=none`, which collects none. |
| Missing `SERVER_SIGNING_SECRET` | A per-boot SEP-10 identity changes the advertised `SIGNING_KEY` on every restart, breaking every wallet that cached it. |
| Missing `JWT_SECRET` | Every seller is logged out on each deploy. |
| Missing `REDIS_URL` without `SINGLE_INSTANCE=true` (`STELLAR_NETWORK=public`) | Rate-limit counters and SEP-10 single-use challenge claims are per-process without Redis, so N instances allow N times every limit and N redemptions of one signed challenge. Set `REDIS_URL`, or set `SINGLE_INSTANCE=true` to state that this deployment runs exactly one instance. |
| Missing `WEBHOOK_SECRET_ENCRYPTION_KEY` (`NODE_ENV=production`, any network) | It encrypts webhook signing secrets and seller anchor session tokens at rest. The trigger is `NODE_ENV=production`, not `STELLAR_NETWORK=public`. A value that does not decode to exactly 32 bytes (64 hex chars, or base64 of 32 bytes) is also refused. |
| `E2E_TEST_MODE=1` with `NODE_ENV=production` or `STELLAR_NETWORK=public` | The e2e harness mounts routes that mint sessions and mark links paid without authentication or a ledger. |
| Unrecognised `STELLAR_NETWORK`, `OFFRAMP`, `WATCH_MODE` or `CORRELATION` value | Each is validated against its allowed set at module load. |
| A blank or non-numeric numeric var | A blank value used to yield `0` — `TRUST_PROXY_HOPS=` silently collapsed every client into one rate-limit bucket. A typo yields `NaN`, and `setInterval(NaN)` is a tight loop against Horizon, not a slow poll. |

The `env.ts` guards (OFFRAMP, `DEFAULT_SELLER_SECRET`, anchor URL, USDC
issuer, KYC key, unknown OFFRAMP value) are covered by
`apps/api/test/env-mainnet-guards.test.ts`. The `REDIS_URL` / `SINGLE_INSTANCE`
guard is covered by `apps/api/test/single-instance-guard.test.ts` and the
webhook-key guard by `apps/api/test/secret-crypto.test.ts`. The
`SERVER_SIGNING_SECRET` and `JWT_SECRET` guards
(`resolveServerSigningKeypair`, `resolveJwtSecret` in
`apps/api/src/services/container.ts`) and the `E2E_TEST_MODE` guard have no
dedicated test.

---

## Phase 0 — Decide whether you need an anchor at all

`OFFRAMP=none` ships payments without a cash-out leg. Buyers pay the seller's
wallet directly, the watcher confirms the payment on the ledger, receipts and
webhooks fire as normal, and the seller moves their own funds. Everything that
is verified working stays; only cash-out to fiat is absent.

This is the fastest route to a live mainnet deployment, and the lowest-risk one:

- **No anchor agreement**, which is otherwise the only blocker that money and
  code cannot solve.
- **No SEP-12 identity data**, so no `KYC_ENCRYPTION_KEY` and none of the
  data-protection surface that holding seller PII creates.
- **No anchor sessions.** With a real anchor, each seller signs the anchor's
  SEP-10 challenge with their own wallet and Quay keeps the resulting token so
  it can follow their withdrawals. That token cannot move funds, but it is
  still a credential to hold. Payments-only holds none.
- **Non-custodial end to end** — funds move from buyer to seller on the public
  ledger and never touch an account this service controls.

Structurally it is a small change because the off-ramp hangs off the *end* of
the payment flow rather than running through it: `paid` is the only status that
leads into the `offramp_*` states (`packages/core/src/domain/status.ts`). Those
states stay in the machine, simply unreachable, so enabling cash-out later is a
change of environment variable, not a migration.

To run this way:

```
OFFRAMP=none                      # API
NEXT_PUBLIC_OFFRAMP_MODE=none     # web
```

and leave `ANCHOR_URL`, `ANCHOR_HOME_DOMAIN` and `KYC_ENCRYPTION_KEY` unset.
`DEFAULT_SELLER_SECRET` stays unset in every mode — the server never signs for a
seller. The dashboard hides the cash-out button, the KYC
panel and the cash-out modal; the API answers **501** (not 502 — this is
permanent, not an outage) on `/:id/cash-out`, `/:id/cash-out/quote` and
`/:id/offramp-requirements`; and the cash-out poller and anchor probe never
start.

**If you are shipping payments-only, skip to Phase 2.** Phase 1 applies only
when you add the off-ramp.

---

## Phase 1 — Choose an anchor

Share the [anchor due diligence brief](ANCHOR-DUE-DILIGENCE.md) with a prospective partner before enabling cash-out. It covers custody, credential authority, seller data, retention gaps, and incident contacts.

Only if you are enabling cash-out. This is the one decision no configuration
can make for you, and it gates everything else.

Quay's off-ramp speaks SEP-10 (auth), SEP-12 (KYC) and either SEP-6 or SEP-24
(withdrawal), with SEP-38 for quotes where the anchor has them. Any production
anchor implementing that set works with no code change — `OFFRAMP=anchor` is the
same code as `testanchor`, pointed at a different host.

Which withdrawal protocol is used comes from the anchor's own `stellar.toml`
(`TRANSFER_SERVER` means SEP-6, `TRANSFER_SERVER_SEP0024` means SEP-24), set by
`OFFRAMP_PROTOCOL`:

- `auto` (default) uses SEP-6 when the anchor declares it — the seller never
  leaves the dashboard — and otherwise SEP-24, where the anchor's own page opens
  for the seller to finish the withdrawal.
- `sep6` / `sep24` force one. If the anchor does not declare it, the first
  cash-out fails with `502 anchor_config_error` naming what the anchor does
  declare. The chosen protocol is logged once at boot (`event: "offramp.protocol"`).

A withdrawal keeps the protocol it started under, so changing `OFFRAMP_PROTOCOL`
never strands one in flight.

What you need from the anchor before proceeding:

- **A commercial agreement.** Production anchors do not serve anonymous traffic.
- **The corridor you actually need.** Confirm it settles to the rail your sellers
  use, and how it prices: via SEP-38 (`ANCHOR_QUOTE_SERVER` in its TOML), or, for
  the many anchors that publish no SEP-38, an indicative rate from
  `OFFRAMP_RATE_SOURCE` plus the fee in its `/info`. With neither, the adapter
  refuses to quote rather than invent a rate.
- **Its SEP-6 withdrawal types** (when it serves SEP-6). If it publishes more
  than one, set `OFFRAMP_TYPE`; otherwise the adapter refuses rather than
  guessing a rail. A SEP-24 anchor collects the rail on its own page.
- **Its KYC requirements.** SEP-12 fields are collected per seller ahead of
  time, not per transaction. If it keys requirements on a SEP-12 customer
  `type`, set `ANCHOR_KYC_TYPE` (and `ANCHOR_KYC_TYPE_ORGANIZATION` for
  organization sellers); Quay then sends it on every `/customer` call and keeps
  a separate status per type.
- **That it serves each seller as their own customer.** Every seller signs the
  anchor's SEP-10 challenge with their own wallet (dashboard → identity
  verification → *Connect to anchor*), so the anchor's customer is the seller's
  account, not Quay's. Each seller also signs the USDC transfer that funds their
  withdrawal. Nothing is sent from an account Quay controls.

`ANCHOR_URL` and `ANCHOR_HOME_DOMAIN` name the first anchor and seed the
`anchors` table on the first boot. More anchors (another corridor, or a move to
a different production anchor) are added afterwards with
`node scripts/anchors.mjs add|disable|list`, without a redeploy; see
[Switching anchors](RUNBOOK.md#switching-anchors).

Verify before writing any config:

```bash
curl -s https://<anchor-domain>/.well-known/stellar.toml
```

Confirm it advertises `WEB_AUTH_ENDPOINT` and `SIGNING_KEY`, at least one of
`TRANSFER_SERVER` (SEP-6) or `TRANSFER_SERVER_SEP0024` (SEP-24), and `KYC_SERVER`
(when absent, Quay uses the transfer server); `ANCHOR_QUOTE_SERVER` is
optional (see above). Quay treats anything the TOML does not declare as
absent, never as a guessed path. Confirm too that `NETWORK_PASSPHRASE` is
`Public Global Stellar Network ; September 2015`. An anchor whose TOML names the
testnet passphrase is a sandbox regardless of its domain.

> **Compliance is yours, not the anchor's.** Moving real customer money means
> money-transmission rules that vary by jurisdiction, and holding seller SEP-12
> identity data means data-protection obligations. Neither this document nor the
> code makes you compliant. Get advice appropriate to where you operate before
> taking a payment from a member of the public.

---

## Phase 2 — Generate secrets

```bash
pnpm secrets:mainnet
```

Prints every required secret and writes nothing to disk — these are spending
authority over real funds and identity for SEP-10 login, so they must not land
in a file the repo could pick up, in shell history, or in an agent transcript.
Copy each value straight into your platform's secret manager, then close the
terminal.

It generates `JWT_SECRET`, `KYC_ENCRYPTION_KEY`,
`WEBHOOK_SECRET_ENCRYPTION_KEY`, `METRICS_TOKEN`, and
`SERVER_SIGNING_SECRET`. It does not generate `ANCHOR_URL`,
`ANCHOR_HOME_DOMAIN`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN` or `CORS_ORIGINS` —
supply those by hand.

### Fund and prepare the accounts

There is no friendbot on pubnet. Both accounts must be funded with real XLM.

1. **Every seller's own wallet** — each merchant signs in with their wallet
   over SEP-10, and their links are paid straight to it. Each of those accounts
   needs XLM for the base reserve and a **USDC trustline** to Circle's issuer.
   Until the trustline exists that account cannot receive USDC at all, and
   `POST /links` rejects with 422 `destination_cannot_receive` plus a
   `trustlineUri` the seller can open — so this fails early and legibly rather
   than losing a payment. That includes your own wallet, if you are also a
   merchant on your own deployment.

   `DEFAULT_SELLER_WALLET` is optional and names no one's funds: set it only if
   you want `/health` to report the trustline status of one specific wallet.
2. **Signing identity** (`SERVER_SIGNING_SECRET`) — needs no funding. It signs
   SEP-10 challenges offline and is published as `SIGNING_KEY` in
   `/.well-known/stellar.toml`; the account never has to exist on-chain.

### Verify the USDC issuer

`USDC_ISSUER_PUBLIC` defaults to
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` in the templates.
**Check it against Circle's own published address** before taking a payment:
<https://developers.circle.com/stablecoins/stellar-usdc>

Minting an asset with the code `USDC` from a different issuer is trivial and it
is worth nothing. The issuer is the only thing that distinguishes real USDC.

---

## Phase 3 — Configure and deploy

`render.mainnet.yaml` ships the payments-only (`OFFRAMP=none`) configuration
described in Phase 0 — apply it as-is for that path. It creates a **second**
service, `quay-api-mainnet`, deploying from `main`, while the existing
`quay-api` stays on testnet deploying from `dev`. Two services, two databases,
two branches — see docs/RUNBOOK.md "Promotion: dev to main". The anchor variables
and `KYC_ENCRYPTION_KEY` sit commented out in one block in that file; uncomment all of them together, and set `OFFRAMP=anchor`, only
after Phase 1 has an anchor that actually agreed to onboard you.


Start from the templates rather than editing the testnet ones:

- `.env.public.example` — every variable, annotated, for local or non-Render use
- `render.mainnet.yaml` — a Render blueprint

`render.mainnet.yaml` deliberately creates a **separate** service
(`quay-api-mainnet`) instead of repointing the existing testnet one. Testnet
stays available as a staging environment, and a bad mainnet config cannot take
the testnet deploy down with it.

### Database

`DATABASE_URL=file:./local.db` is lost on every redeploy, taking the payment
ledger with it. Use a real, backed-up database (Turso), and confirm
`.github/workflows/db-backup.yml` points at the mainnet database, not the
testnet one.

### The web app

`NEXT_PUBLIC_STELLAR_NETWORK=public` **must** be set on the web deployment.

This one is easy to miss and fails opaquely: the browser signs with the
passphrase this variable selects, so leaving it unset means every wallet
signature is built for testnet and rejected by the network the API is watching —
with no error message that names the cause. Like every `NEXT_PUBLIC_*`
variable, this is baked into the client bundle **at build time** — changing
it and redeploying without rebuilding does nothing; the old value is still
what's in the bundle a visitor's browser downloads.

`NEXT_PUBLIC_API_URL` has the exact same failure shape, and it has actually
happened: a Vercel build once ran with this unset, so the code's own
`http://localhost:8787` local-dev fallback got baked into the production
bundle instead, and every visitor's browser silently tried (and failed) to
reach `localhost:8787` **on their own machine** — "Create link" just did
nothing, no error naming the cause (`docs/FIXLOG.md`, BUG-1.4). The fallback
now only applies outside a production build; a production build with this
unset fails loudly in the browser instead, at load time, rather than issuing
doomed requests — but that guard only catches "unset," not "wrong region/
wrong deployment," so still set it deliberately rather than relying on the
guard to catch a typo'd URL. Also set:

- `NEXT_PUBLIC_API_URL` / `API_URL` — the mainnet API origin
- `NEXT_PUBLIC_ENABLE_WALLET_PAY=true` — enable the lazy-loaded desktop wallet
  checkout path; leave unset/false to retain QR and deep-link fallbacks
- `NEXT_PUBLIC_OFFRAMP_MODE=anchor` — so the dashboard labels cash-out honestly
- `NEXT_PUBLIC_OFFRAMP_CURRENCY` — a currency your anchor actually quotes

And set `CORS_ORIGINS` on the API to the real web origin. No localhost.

---

## Phase 4 — Verify before announcing

Run the preflight first. It checks what the boot guards structurally cannot:
they run inside the process and can only see configuration, while these are
facts about the outside world — whether the seller account exists on pubnet,
whether it carries a Circle USDC trustline (without one the account cannot
receive USDC at all, and the payment fails rather than arriving unmatched),
whether the service answering on that URL is really the mainnet one.

```bash
# Check a configuration, before deploying it. Run this where the mainnet env
# is actually exported — the static checks read this shell.
pnpm preflight:mainnet

# Check a running deployment. If this shell has no mainnet config (the normal
# case, because render.mainnet.yaml puts every `sync: false` value in the
# Render dashboard), the static checks are skipped rather than reporting your
# laptop's empty environment as eleven mainnet failures.
pnpm preflight:mainnet --api https://<your-mainnet-api>
```

The two modes answer different questions — *is this configuration right?* and
*is the thing that is running right?* — and only the first can see values held
in a dashboard. What a live probe cannot see, it does not guess about:
`DATABASE_URL`, the secrets, and `OFFRAMP` are never exposed over HTTP, so
verify those in the Render dashboard yourself.

It exits non-zero only on blocking findings; warnings are printed but do not
fail the run. Read them anyway — `REDIS_URL` is the one that decides whether you
may run more than one instance.

With `OFFRAMP=anchor` it also fetches the anchor's
`https://$ANCHOR_HOME_DOMAIN/.well-known/stellar.toml` (SEP-1) and audits it,
because at runtime a missing or incomplete toml degrades to guessed endpoints
and only shows up when the first seller taps "Connect to anchor". These block:

| Check | Fails when |
| --- | --- |
| `anchor-toml:fetch` | the toml is unreachable or not a 200 |
| `anchor-toml:signing-key` | `SIGNING_KEY` is missing or not a `G...` public key |
| `anchor-toml:network` | `NETWORK_PASSPHRASE` is missing (the runtime lets that through silently) or is not `Public Global Stellar Network ; September 2015` |
| `anchor-toml:WEB_AUTH_ENDPOINT`, `KYC_SERVER`, `TRANSFER_SERVER`, `TRANSFER_SERVER_SEP0024` | the endpoint is missing or not `https://` (it is only a warning if its host differs from `ANCHOR_URL`). Either transfer server is enough: the toml is blocked only when it declares neither |
| `anchor-toml:ANCHOR_QUOTE_SERVER` | a warning, not a blocker, when missing (and silent when `OFFRAMP_RATE_SOURCE` is set); blocking only if declared and not `https://` |
| `anchor-toml:usdc` | `[[CURRENCIES]]` has no `code = "USDC"` entry with Circle's pubnet issuer |

`anchor-toml:withdraw-info` is a warning only: it reads `{TRANSFER_SERVER}/info` (or `{TRANSFER_SERVER_SEP0024}/info` for a SEP-24-only anchor)
and flags USDC withdraw not enabled, several withdraw types offered with
`OFFRAMP_TYPE` unset, or an `OFFRAMP_TYPE` the anchor does not offer. As a
sanity check, pointing it at the sandbox
(`STELLAR_NETWORK=public OFFRAMP=anchor ANCHOR_URL=https://testanchor.stellar.org
ANCHOR_HOME_DOMAIN=testanchor.stellar.org pnpm preflight:mainnet`) should fail
`anchor-toml:network`.

Then work down this list against the deployed mainnet service. Stop at the
first failure.

```bash
API=https://<your-mainnet-api>

# 1. It booted at all — every guardrail passed.
curl -s $API/health | jq

# 2. It is on pubnet, watching the right issuer.
curl -s $API/.well-known/stellar.toml
#    NETWORK_PASSPHRASE must be "Public Global Stellar Network ; September 2015"
#    SIGNING_KEY must be your SERVER_SIGNING_SECRET's public key, and must not
#    change across a restart.

# 3. The database is reachable, not just the process alive.
curl -s $API/ready
```

Then, by hand:

- [ ] Seller wallet holds XLM **and** a USDC trustline to the verified issuer.
- [ ] `SIGNING_KEY` in the TOML is unchanged after a deliberate service restart.
- [ ] A wallet can complete SEP-10 login from the production web origin.
- [ ] A **small real payment** — a few USDC — moves a link to `paid`.
- [ ] A **small real cash-out** through the anchor reaches `settled` and the
      money actually arrives. Do this before anyone else uses the service.
      *(Not applicable under `OFFRAMP=none` — there is no cash-out leg; the
      cash-out routes answer 501 and the dashboard hides the button.)*
- [ ] Webhook deliveries verify against the stored signing secret.
- [ ] `GET /metrics` requires `METRICS_TOKEN` and is not publicly readable.

---

## Rollback

Because mainnet is a separate service, rollback is: stop routing traffic to
`quay-api-mainnet` and point the web app's `NEXT_PUBLIC_API_URL` back at the
testnet API (with `NEXT_PUBLIC_STELLAR_NETWORK=testnet`).

Payments already settled on-chain cannot be rolled back. In-flight anchor
withdrawals continue at the anchor regardless of whether your service is
running — reconcile them through the anchor's own transaction records, not by
replaying local state.

---

## Known gaps to close

Not blockers for a first cutover, but each has a real production cost:

- **`REDIS_URL` unset.** Rate-limit counters live in an in-process `Map`, so N
  instances allow N times the configured limit. SEP-10 challenge single-use
  tracking has the same gap: without it, the same signed challenge can be
  redeemed once per instance instead of once, ever. Set it before scaling past
  one instance.
- **`apps/api/scripts/demo-seed.ts` reads `STELLAR_NETWORK` like the API does**,
  but Friendbot and the testanchor USDC dispenser only exist on testnet — on
  public network it skips both with a clear message and expects the generated
  buyer keypair to already be funded, or the payment step fails with the real
  Horizon error rather than an obscure one.
- **`.github/workflows/anchor-probe.yml` probes `testanchor.stellar.org`** and
  auto-files a GitHub issue when that sandbox is down. On a mainnet project it
  is watching the wrong host — repoint it at your anchor or disable it.
- **No server-held key signs anything for a seller (issue #207).** The unwired SEP-24
  adapter (`AnchorOffRamp`, `packages/offramp/src/anchor.ts`) used to sign the seller's send
  leg and log in to the anchor with a platform keypair; it now authenticates per seller
  through `SellerAnchorAuth` and returns the send leg as transfer instructions for the
  seller's wallet to sign, and `Sep10Client` moved to `packages/offramp/test/`.
  `TestAnchorOffRamp` (SEP-6) is the adapter that is wired in.
  `scripts/check-no-server-signing.mjs` fails CI if a server-side signing path
  reappears.
