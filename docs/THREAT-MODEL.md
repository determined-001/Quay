# Threat model: seller-signed anchor authentication and withdrawals

Scope: the current seller-initiated SEP-10 → SEP-12 → SEP-38 → SEP-6 flow. The [architecture cash-out sequence](ARCHITECTURE.md#L152-L214) is the happy path; the SEP-24 adapter is not wired into the API. This is a code-level model, not an assurance about an anchor's operations or the safety of a seller's wallet. [Active adapter wiring](../apps/api/src/services/container.ts#L385-L444) · [Stellar SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md) · [Stellar SEP-6](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md)

## Assets and authority

| Asset | Owner / consequence if lost | Current boundary |
| --- | --- | --- |
| Seller USDC and wallet signing authority | Seller owns funds. A malicious payment signature can transfer them. | The browser asks the seller's wallet to sign the anchor challenge and later the withdrawal transfer. The active API adapter has no seller signing key when `DEFAULT_SELLER_SECRET` is unset. [Wallet](../apps/web/lib/wallet.ts#L131-L184) · [Wiring](../apps/api/src/services/container.ts#L385-L444) |
| Anchor SEP-10 JWT | Bearer authority to read/update the seller's SEP-12 record and request an SEP-6 withdrawal; stolen JWT can expose or change identity data and start a withdrawal, but cannot itself sign the on-chain funding transfer. | `anchor_sessions.token_encrypted` uses `WEBHOOK_SECRET_ENCRYPTION_KEY`; Quay decrypts it to call the anchor. [Port](../packages/core/src/ports/index.ts#L447-L472) · [Repository](../apps/api/src/repos/index.ts#L858-L893) · [Adapter](../packages/offramp/src/testanchor.ts#L238-L298) |
| SEP-12 identity fields | Seller PII; disclosure or cross-seller overwrite harms privacy and KYC integrity. | `seller_kyc.fields_encrypted` uses `KYC_ENCRYPTION_KEY`. Account, customer ID, status, field requirements and message are stored separately without field encryption. [Schema](../apps/api/src/db/schema.ts#L166-L182) · [Repository](../apps/api/src/repos/index.ts#L810-L851) |
| `KYC_ENCRYPTION_KEY` | Decrypts the submitted SEP-12 field values if an attacker also has a database copy. | Parsed as a 32-byte key; AES-256-GCM protects each stored blob. [Key parsing and encryption](../apps/api/src/crypto/pii.ts#L3-L39) · [Repository](../apps/api/src/repos/index.ts#L814-L851) |
| Saved payout fields | Bank destination and related details; disclosure can expose financial information. | `sellers.payout_fields_json` is **plaintext JSON** despite dashboard masking. Treat a DB leak as disclosure of these fields. [Schema](../apps/api/src/db/schema.ts#L3-L15) · [Write](../apps/api/src/repos/index.ts#L316-L321) |
| `SERVER_SIGNING_SECRET` | Quay's own SEP-10 login identity. Theft lets an attacker sign a challenge as Quay if they can present it to wallets; it does not mint Quay sessions without `JWT_SECRET` and is not a seller payment key. | Used by `ChallengeService`, not `SellerAnchorAuth`. [Container](../apps/api/src/services/container.ts#L167-L190) · [Challenge](../apps/api/src/services/challenge.ts#L65-L84) |
| `JWT_SECRET` | Signs Quay seller sessions; theft permits forged Quay API authentication until rotation. | It is separate from seller wallet signatures and anchor-issued JWTs. [Session issuer](../apps/api/src/services/session.ts#L24-L55) · [Container](../apps/api/src/services/container.ts#L188-L190) |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Decrypts stored anchor JWTs as well as webhook signing secrets. Theft together with DB access widens the incident from metadata to bearer credentials. | Required at production boot; AES-256-GCM protects the stored values. [Key loading](../apps/api/src/services/secret-crypto.ts#L29-L68) · [Encryption](../apps/api/src/services/secret-crypto.ts#L72-L91) |

## Actors and trust boundaries

1. **Seller and wallet → browser.** Quay's UI can prepare XDR, but only the selected wallet can authorize a signature. A compromised browser or malicious wallet extension can alter what is presented for signing; the wallet confirmation remains a separate trust boundary. [Wallet signing](../apps/web/lib/wallet.ts#L131-L184)
2. **Browser / API-key integrator → Quay API.** Seller sessions or scoped API keys authenticate requests; `offramp:initiate` gates anchor auth and cash-out. A stolen scoped API key is meaningful authority even without the wallet key. The cash-out route checks link ownership. [Auth middleware](../apps/api/src/middleware/auth.ts#L153-L221) · [Anchor route](../apps/api/src/routes/anchor-auth.ts#L19-L34) · [Cash-out route](../apps/api/src/routes/links.ts#L247-L265)
3. **Quay API ↔ Quay DB.** The API decrypts anchor JWTs and KYC fields in process. DB-only access exposes other plaintext seller, payout and transaction metadata; key compromise exposes protected values too. [Repositories](../apps/api/src/repos/index.ts#L810-L893) · [Schema](../apps/api/src/db/schema.ts#L3-L191)
4. **Quay API ↔ anchor.** The anchor controls SEP-1 discovery, SEP-10 challenge/JWT issuance, KYC responses, quotes, withdrawal destination and memo. Quay verifies the challenge but must still trust the anchor's operational integrity and the deposit instructions it returns. [Discovery and verification](../packages/offramp/src/anchor-session.ts#L124-L249) · [Withdrawal response](../packages/offramp/src/testanchor.ts#L258-L298)
5. **Browser / Quay API ↔ Horizon.** Horizon supplies account and payment state; the browser submits a seller-signed withdrawal transaction there. A wrong network, destination or memo can leave funds at the wrong place or uncredited by the anchor. [Wallet transfer](../apps/web/lib/wallet.ts#L151-L184) · [Network discovery](../packages/offramp/src/sep1.ts#L121-L145)

## Threats, controls and remaining exposure

The categories are a compact STRIDE-style checklist. “Control” means implemented in the linked code; a link to a follow-up issue means the gap is still open.

| Threat | Current control and evidence | Remaining exposure |
| --- | --- | --- |
| **Tampering: a malicious or compromised anchor serves a payment disguised as a SEP-10 challenge.** | Before sending XDR to the wallet, `SellerAnchorAuth` requires discovered `SIGNING_KEY` and calls `WebAuth.readChallengeTx` with the expected network, home domain and endpoint host. It re-verifies the signed XDR before relaying it. Failed discovery or missing signing key is rejected. [Challenge](../packages/offramp/src/anchor-session.ts#L124-L145) · [Verification](../packages/offramp/src/anchor-session.ts#L215-L249) · [Test](../packages/offramp/test/anchor-session.test.ts#L154-L160) | A compromised trusted anchor can still give harmful *withdrawal deposit instructions* after authentication. The seller must review the wallet's payment prompt. [Transfer](../apps/web/lib/wallet.ts#L151-L184) |
| **Spoofing: challenge is for another account, or JWT is issued to another seller.** | The decoded challenge account must equal the authenticated seller wallet. A present JWT `sub` with a different account is rejected; sessions are keyed by seller and anchor. [Checks](../packages/offramp/src/anchor-session.ts#L154-L185) · [Challenge account](../packages/offramp/src/anchor-session.ts#L231-L249) · [Tests](../packages/offramp/test/anchor-session.test.ts#L161-L185) | `sub` is not required to be present; JWT signature, issuer and other claims are not validated locally before storage. [#208: stronger JWT validation](https://github.com/determined-001/Quay/issues/208) |
| **Elevation of privilege: one seller reads or overwrites another seller's KYC or withdraws their link.** | Anchor auth uses the seller's wallet, KYC only reuses a `customer_id` for the same account, and cash-out checks link ownership. API keys need `offramp:initiate` for KYC, anchor auth and cash-out. [KYC account check](../packages/offramp/src/kyc.ts#L117-L137) · [KYC scope](../apps/api/src/routes/kyc.ts#L42-L56) · [Route ownership](../apps/api/src/routes/links.ts#L247-L265) · [Cross-seller test](../packages/offramp/test/anchor-session.test.ts#L187-L226) | Theft of a seller session or sufficiently scoped API key permits actions in that seller's scope. Protect and revoke those credentials. [Auth scopes](../apps/api/src/middleware/auth.ts#L153-L221) |
| **Information disclosure: Quay DB is copied.** | Anchor JWT and submitted KYC values use separate AES-256-GCM keys; raw values are decrypted in the API process. [Token encryption](../apps/api/src/repos/index.ts#L863-L893) · [PII encryption](../apps/api/src/repos/index.ts#L814-L851) | Wallet/account IDs, KYC metadata, and saved payout fields are plaintext. If the attacker also obtains either encryption key, encrypted values are exposed. Expired anchor-session rows are not swept. [Schema](../apps/api/src/db/schema.ts#L3-L191) · [#231: expiry sweep](https://github.com/determined-001/Quay/issues/231) |
| **Repudiation: sensitive KYC reads cannot be tied to a specific operator action.** | The API uses structured logs with request context and redacts common PII/secret-shaped fields. [Logger](../apps/api/src/logger.ts#L3-L81) · [Request context](../apps/api/src/request-context.ts#L1-L35) | There is no dedicated audit event for each PII decrypt, so a DB/key or server compromise may be hard to reconstruct. [Repository decrypt](../apps/api/src/repos/index.ts#L814-L831) · [#280: PII access audit](https://github.com/determined-001/Quay/issues/280) |
| **Elevation of privilege: Quay server or secret store is compromised.** | In the active SEP-6 path the server holds the seller JWT, not the seller wallet key; it cannot sign a seller transfer or anchor challenge. `SERVER_SIGNING_SECRET` signs Quay login challenges. [Composition](../apps/api/src/services/container.ts#L167-L190) · [Anchor wiring](../apps/api/src/services/container.ts#L385-L444) | A server compromise can read decrypted tokens/PII and initiate withdrawals. `DEFAULT_SELLER_SECRET` can still be configured and loaded, exposing that configured seller's signing key; the unexported SEP-24 adapter still has server-key signing code. [Resolver](../apps/api/src/services/seller-wallet.ts#L47-L77) · [#278: reject server seller key](https://github.com/determined-001/Quay/issues/278) · [#207: remove dormant signing path](https://github.com/determined-001/Quay/issues/207) |
| **Tampering / loss: wrong asset, destination or memo on the withdrawal payment.** | The SEP-6 adapter returns the asset/amount it quoted and the anchor's destination and memo; the browser builds the transaction with those instructions and asks the seller wallet to sign. It does not invent a memo type. [Adapter](../packages/offramp/src/testanchor.ts#L258-L298) · [Wallet](../apps/web/lib/wallet.ts#L159-L184) · [Test](../packages/offramp/test/anchor-session.test.ts#L235-L260) | The destination/memo are supplied by the anchor; no independent allowlist or out-of-band confirmation exists. A wrong or late memo can strand funds at the anchor. [Wallet warning](../apps/web/lib/wallet.ts#L171-L178) |
| **Denial of service: anchor JWT expires during an in-flight withdrawal.** | `SellerAnchorAuth.token()` refuses absent, changed-wallet or near-expiry sessions with a 60-second skew; a new cash-out fails with `anchor_auth_required` rather than silently using another seller's JWT. [Session check](../packages/offramp/src/anchor-session.ts#L191-L212) · [API mapping](../apps/api/src/services/link-service.ts#L1288-L1296) | The pending-job poller catches and retries errors with in-memory backoff; it does not pause for seller reconnection or distinguish expiry. Sellers may need to reconnect while a funded withdrawal is pending. [Poller](../apps/api/src/services/link-service.ts#L1039-L1093) · [#227: expired-session handling](https://github.com/determined-001/Quay/issues/227) |
| **Spoofing / stale authorization: seller logs out or changes wallet.** | A stored anchor session is only used if its account matches the current seller wallet; the anchor-auth disconnect route deletes its row. [Account check](../packages/offramp/src/anchor-session.ts#L203-L212) · [Disconnect](../apps/api/src/routes/anchor-auth.ts#L72-L76) · [Test](../packages/offramp/test/anchor-session.test.ts#L178-L185) | Quay logout and wallet change do not automatically revoke the anchor's JWT at the anchor or delete its stored row. [#230: revoke on logout/wallet change](https://github.com/determined-001/Quay/issues/230) |
| **SSRF / disclosure: anchor advertises an unexpected endpoint.** | SEP-1 discovery itself uses HTTPS, public-network `ANCHOR_URL` must begin with HTTPS, network mismatch is rejected, and auth refuses guessed discovery or a missing signing key. [SEP-1](../packages/offramp/src/sep1.ts#L102-L165) · [URL guard](../apps/api/src/env.ts#L137-L143) · [Auth guard](../packages/offramp/src/anchor-session.ts#L215-L228) | The advertised SEP endpoint URLs are used without a per-endpoint scheme, host or private-address check. Verify an anchor's TOML and endpoint allowlist before production; do not equate the webhook SSRF guard with anchor URL protection. [Endpoint use](../packages/offramp/src/anchor-session.ts#L124-L145) · [#286: mainnet TOML preflight](https://github.com/determined-001/Quay/issues/286) |
| **Denial of service: challenge-route abuse.** | A global IP limiter covers the API, and `/auth` has an additional strict limiter. Anchor auth requires a seller session or API key with `offramp:initiate`. [Global/strict wiring](../apps/api/src/index.ts#L58-L79) · [Auth route](../apps/api/src/index.ts#L153-L173) · [Anchor auth](../apps/api/src/routes/anchor-auth.ts#L19-L34) | `/seller/anchor-auth/challenge` has no dedicated per-seller limiter; an authorized client can repeatedly trigger anchor requests. [#232: per-seller challenge limit](https://github.com/determined-001/Quay/issues/232) |

## Unhappy paths

```mermaid
sequenceDiagram
  participant Seller as Seller and wallet
  participant UI as CashOutModal
  participant API as Quay API
  participant Auth as SellerAnchorAuth
  participant Anchor as Anchor
  participant Horizon

  Seller->>API: Request anchor challenge
  API->>Auth: challenge(seller account)
  Auth->>Anchor: GET SEP-10 challenge
  alt Invalid signing key, network, domain or account
    Auth-->>API: AnchorChallengeError
    API-->>Seller: 502 challenge_rejected; no wallet prompt
  else Verified challenge
    API-->>Seller: Verified XDR
    Seller->>Seller: Wallet signs challenge
    Seller->>API: POST signed XDR
    alt Signed challenge for another account
      API-->>Seller: 400 challenge_rejected
    else Signed challenge valid
      Auth->>Anchor: POST signed XDR
      Anchor-->>Auth: Seller JWT
      alt JWT subject names another account
        Auth-->>API: AnchorChallengeError
        API-->>Seller: 400 challenge_rejected
      else Token accepted
        Auth-->>API: Encrypted session saved
      end
    end
  end

  Seller->>UI: Start cash-out
  UI->>API: POST cash-out
  alt No live seller anchor session
    API-->>UI: 403 anchor_auth_required
    UI-->>Seller: Reconnect wallet to anchor
  else Live session
    API->>Anchor: SEP-6 withdraw with seller JWT
    alt Deposit instructions not yet returned
      Anchor-->>API: Withdrawal id only
      API-->>UI: Pending job without transfer
      Note over UI,Anchor: Later instructions are not surfaced yet; issue 3.9
    else Deposit instructions returned
      Anchor-->>API: Destination, asset, amount, memo
      API-->>UI: Transfer instructions
      alt Seller closes modal before sending
        Note over Seller,UI: Instructions held only in modal state; issue 5.13
      else Seller confirms wallet payment
        UI->>Seller: Request payment signature
        Seller->>Horizon: Submit signed withdrawal transfer
      end
    end
  end
```

Challenge and JWT failures follow the [anchor-auth route](../apps/api/src/routes/anchor-auth.ts#L46-L69). Missing sessions map to [HTTP 403](../apps/api/src/services/link-service.ts#L1288-L1296). The SEP-6 adapter can return only a pending job when no deposit account is provided [yet](../packages/offramp/src/testanchor.ts#L285-L298), while the modal retains transfer instructions only in component state and can close before sending them [here](../apps/web/app/components/CashOutModal.tsx#L130-L133) and [here](../apps/web/app/components/CashOutModal.tsx#L250-L259). These gaps are tracked in [#206](https://github.com/determined-001/Quay/issues/206) and [#250](https://github.com/determined-001/Quay/issues/250).

## Review triggers and open work

Revisit this model whenever an adapter, JWT validator, anchor URL parser, session lifecycle, wallet signing path or API-key scope changes. In particular, track [#207 dormant server signing](https://github.com/determined-001/Quay/issues/207), [#208 JWT claims](https://github.com/determined-001/Quay/issues/208), [#227 poller expiry](https://github.com/determined-001/Quay/issues/227), [#230 logout/wallet change](https://github.com/determined-001/Quay/issues/230), [#231 expired-row sweep](https://github.com/determined-001/Quay/issues/231), [#232 challenge rate limit](https://github.com/determined-001/Quay/issues/232), and [#278 public-network seller key](https://github.com/determined-001/Quay/issues/278). The wallet signature and anchor's operational controls remain trust assumptions even after these items land. [Wallet signing](../apps/web/lib/wallet.ts#L131-L184) · [Anchor response](../packages/offramp/src/testanchor.ts#L258-L298)
