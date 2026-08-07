# `quay-attest` — on-chain settlement attestations

## Deployment

| | |
|---|---|
| **Network** | Stellar testnet |
| **Contract ID** | `CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3` |
| **Wasm hash** | `89cdaecabd001ec377e13ce9398a1881dd0d9f3e9444ac8ec4fbe73e7a54c9d5` |
| **Deploy tx** | [`404af243…`](https://stellar.expert/explorer/testnet/tx/404af243b9f4007b58fee6cc7d1c3061aa1a8db145eff1f9b4bb1abdfd87bf00) |
| **Explorer** | [lab.stellar.org](https://lab.stellar.org/r/testnet/contract/CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3) |
| **Deployed** | 2026-08-06 |
| **Size** | 4,670 bytes |

## Why this contract exists

Quay is non-custodial: the buyer pays USDC straight to the seller's own wallet,
and a watcher matches that payment to a link and marks it paid. The weak point
is the last step — "marked paid" lives in Quay's database, so a receipt is only
as trustworthy as whoever is running the API.

This contract removes that. On settlement the watcher writes an attestation, and
anyone can verify a receipt against the ledger without asking Quay anything.

**It never holds, moves, or has authority over funds.** Quay's regulatory
position rests on value never passing through it (`docs/PROPOSAL.md` §6), so an
escrow-shaped contract would undo the property this codebase is organised
around. This is an append-only registry of facts about payments that already
settled on the classic ledger.

## Interface

```rust
attest(attester, ref_hash, tx_hash, amount, asset_code, asset_issuer, ledger)
verify(ref_hash) -> Option<Receipt>
attested(ref_hash) -> bool
```

Three properties worth knowing:

- **Keyed by `sha256(reference)`, never the reference.** A reference is the
  Stellar memo and is effectively an invoice id, so publishing them would leak a
  seller's invoice volume and sequence to any ledger observer. Hashing keeps the
  registry verifiable by anyone *given* a reference while revealing nothing to
  someone merely reading contract storage.
- **Append-only.** The first attestation for a reference wins; a second returns
  `AlreadyAttested` (contract error `#1`). If an attester could overwrite a
  receipt, a verifier would be trusting them at verification time rather than at
  attestation time — which is the trust this is meant to remove. Verified
  on-chain, not just in unit tests.
- **The contract does not decide who may attest.** Each receipt records its
  attester and requires their signature. A verifier decides whether it trusts a
  given attester, the same way it decides whether to trust an asset issuer. What
  the contract guarantees is that an attestation cannot be forged in someone
  else's name.

## Working on it

```bash
cd contracts
cargo test                  # 8 unit tests, no network
stellar contract build      # -> target/wasm32v1-none/release/quay_attest.wasm
```

`Cargo.lock` is committed and matters: `soroban-env-host` 23.x declares
`ed25519-dalek = ">=2.0.0"`, and cargo otherwise resolves that to 3.0.0, whose
`CryptoRng` bound is `rand_core` 0.9 while the surrounding code uses 0.6. The
two don't unify and the *test* profile fails to compile — the contract itself
builds fine either way, which makes it an easy trap to fall into. The lock pins
2.2.0.

## Redeploying

```bash
stellar keys generate quay-deployer --network testnet --fund
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/quay_attest.wasm \
  --source quay-deployer --network testnet
```

Then update the contract ID in the table above, and in the API's
`ATTESTATION_CONTRACT_ID` environment variable.

The attester identity used by the API is its SEP-10 signing keypair
(`SERVER_SIGNING_SECRET`), which **must be funded on testnet** to pay invocation
fees. An unfunded attester makes attestation fail; it does not affect
settlement, which never blocks on this contract.

## How the API uses it

Wired in issue 9.2. The path, end to end:

1. The watcher matches a payment and `LinkService.applyMatch` moves the link to
   `paid` and persists it.
2. **After** that, `attestSettlement` is fired without being awaited. A slow,
   down, or unfunded registry costs the watcher tick nothing — the payment
   settled on the classic ledger, and no failure here may call that into
   question.
3. On success the contract id, transaction, ledger and timestamp are written to
   four nullable columns on `links`, and `GET /r/:reference` publishes them
   alongside `refHash` so a holder can look the receipt up themselves.
4. `startAttestationSweeper` retries anything still unattested every
   `ATTESTATION_SWEEP_MS`. A duplicate write returns `AlreadyAttested`, which
   the adapter treats as success — so the retry converges instead of thrashing.

Configure with `ATTESTATION_CONTRACT_ID` and `SOROBAN_RPC_URL`. Leave either
unset and attestation is simply off: receipts render without the block rather
than claiming a verifiability they don't have.

## Verifying a receipt yourself

```bash
REF=pl_29r3eixyibf0
REFHASH=$(node -e "console.log(require('crypto').createHash('sha256').update('$REF').digest('hex'))")

stellar contract invoke \
  --id CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3 \
  --source <any-funded-account> --network testnet --send=no \
  -- verify --ref_hash $REFHASH
```

The reference above is a live attestation written during deployment
verification, so that command returns a real receipt today.
