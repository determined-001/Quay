# Maintainer TODO

Working plan for the next funding-wave entry (Drips wave 7, entry ≈ **Jul 21–27, 2026**).
Everything band-moving must land **before** entry — work shipped inside the wave window
doesn't count until the following wave. Target: close the depth + surface loop
(band C ≈ $45 → band B ≈ $100, band A ≈ $200 reachable).

Hard deadline for both items below: **~Jul 20, 2026.** Then rest — burst-and-rest is fine;
resting with these unshipped is the classic mistake.

---

## 1. Real anchor adapter — close the on-chain depth gap

Replace `MockAnchorOffRamp` with an adapter implementing the same `OffRampPort`
against the public Stellar **testnet anchor** (`https://testanchor.stellar.org`),
exactly as the header of `packages/offramp/src/mock-anchor.ts` already prescribes:

- [ ] SEP-10 web auth: fetch challenge transaction, sign with the seller (or a service)
      keypair, obtain JWT.
- [ ] `quote()` → SEP-38 firm quote (rate + expiry) instead of `MOCK_RATES`.
- [ ] `initiate()` → SEP-24 interactive withdrawal (or SEP-31 send) to start the payout.
- [ ] `status()` → poll the anchor transfer to settlement.
- [ ] Wire it in `apps/api/src/services/container.ts` behind an env flag
      (e.g. `OFFRAMP=testanchor|mock`), keeping the mock for offline dev.
- [ ] Tests exercising the real flows against the live test anchor.

Why first: this is the project's native depth path (no Soroban contract needed — that
would be off-architecture). Three SEPs with tests against a live anchor is also the
strongest lever toward the A band.

## 2. Deploy — close the usable-surface gap

A stranger must be able to create a link and pay it **today**, without cloning:

- [ ] Web (`apps/web`) → Vercel.
- [ ] API + ledger watcher worker (`apps/api`) → Fly.io / Railway (one always-on process).
- [ ] `DATABASE_URL` → Turso (libSQL), instead of local SQLite file.
- [ ] Testnet config end-to-end (Horizon URL, network passphrase, testnet USDC issuer).
- [ ] Smoke-test the full stranger flow: create link → open checkout → pay from a
      testnet wallet → link flips to paid → webhook fires.

---

## ⚠️ Deploy-order warning — do not skip

Do **not** put the current mock NGN cash-out behind a public URL unlabeled.
`apps/web/app/components/Dashboard.tsx` renders mock FX rates with no "simulated"
marker. Mock data presented as live behind a demo URL is the one thing that gets a
project rejected outright (with a lasting credibility penalty).

Either ship item 1 before/with item 2, or label the cash-out UI clearly:
**"SIMULATED — testnet demo, no real payout."**

---

## Deliberately deferred (do NOT do these before the wave entry)

None of these move the band; they only cost the two weeks:

- More docs (README/API docs are already strong; docs-only changes pay nothing).
- Auth system (API keys / login) — required before real users, not before entry.
- Streaming `WatcherPort` implementation — polling is fine at this scale.
- Multi-seller scale work.
- Extra CI workflows.
- A Soroban contract for its own sake — off-architecture; the SEP path is the depth story.
- A second repo — never split the project.
