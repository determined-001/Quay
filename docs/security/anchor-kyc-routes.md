# Security review: `/seller/kyc` and `/seller/anchor-auth`

These two route groups handle the most sensitive data Quay has. This page is
the threat model and the checklist behind them. Every checklist line names the
test that pins it, so a regression fails CI rather than a review.

Code: `apps/api/src/routes/kyc.ts`, `apps/api/src/routes/anchor-auth.ts`,
`apps/api/src/middleware/auth.ts`, `packages/offramp/src/anchor-session.ts`.
Tests: `apps/api/test/anchor-kyc-security.test.ts`,
`apps/api/test/kyc-route-auth.test.ts`, `apps/api/test/anchor-auth-route.test.ts`,
`apps/api/test/kyc-consent.test.ts`, `packages/offramp/test/anchor-session.test.ts`.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| The seller's decrypted SEP-12 identity (`providedFields`) | `seller_kyc.fields_encrypted`, decrypted in-process | Legal name, address, ID and bank details. A leak is a reportable breach |
| The seller's anchor bearer token | `anchor_sessions.token_encrypted` | Lets the holder act as the seller at the anchor (KYC, withdrawals) |
| The signed SEP-10 challenge | In flight, browser to API to anchor | A signature from the seller's wallet; replaying it to another account must not work |

## Actors and trust boundaries

- **Seller session** (cookie or `Authorization: Bearer`): the seller, in their own browser.
- **API key** with `offramp:initiate`: a programmatic integration the seller created. Trusted to move money, **not** to read identity back.
- **A page on another origin** that makes the seller's browser send the session cookie (CSRF).
- **The anchor**: a third party. Its response text is untrusted and is never reflected to a client.
- **Another seller**: must never be able to complete, read or change this seller's session.

Quay never signs for the seller. The anchor's customer is the seller's own
account, signed in their wallet.

## Checklist

| # | Property | How it is enforced | Test |
|---|---|---|---|
| 1 | Unauthenticated callers get nothing | `buildAuthMiddleware` on every route | `kyc-route-auth.test.ts`, `anchor-auth-route.test.ts` |
| 2 | A key needs `offramp:initiate` | `requireScope("offramp:initiate")` | same files |
| 3 | **CSRF**: a cookie-authenticated state change (`PUT /seller/kyc`, `POST /seller/anchor-auth`, `POST /seller/anchor-auth/challenge`, `DELETE /seller/anchor-auth`) from a foreign or missing `Origin` is refused with 403; the same request from an allowed origin works; a bearer token is not subject to the Origin rule | Origin check in `buildAuthMiddleware` against `CORS_ORIGINS` | `anchor-kyc-security.test.ts` "CSRF" |
| 4 | **Input bounds** on `PUT /seller/kyc`: at most 50 fields, names match `^[a-z0-9_.]{1,64}$`, values at most 1,000 characters, all strings. Violations are `400 invalid_body` and nothing reaches the anchor | `submitKycSchema` in `kyc.ts` | `anchor-kyc-security.test.ts` "input bounds" |
| 5 | **PII exposure to API keys**: a session sees `providedFields`; an API key gets `providedFields: {}` (status and `requiredFields` are still returned) on both `GET` and `PUT`. Consent, disclosures and file upload already refuse keys | `toResponse(record, authKind)` | `anchor-kyc-security.test.ts` "PII exposure" |
| 6 | **Outbound amplification**: each `POST /seller/anchor-auth/challenge` and `POST /seller/anchor-auth` calls the anchor, so they share a per-seller strict budget (`anchor_auth`); `PUT /seller/kyc` has its own per-seller strict budget (`kyc_write`). One seller cannot spend another's | `anchorAuthLimit`, `kycWriteLimit` in `index.ts` | `anchor-auth-route.test.ts` (per-seller challenge limit), `anchor-kyc-security.test.ts` "rate limits" |
| 7 | **Error bodies**: a refused challenge returns fixed text per failure kind. The anchor's wording goes to the server log only. Other anchor failures are the sanitised `anchor_error` (issue 4.36) | `CHALLENGE_MESSAGES`, `anchorFailure` | `anchor-kyc-security.test.ts` "error bodies", `anchor-error-sanitization.test.ts` |
| 8 | **Cross-seller**: a challenge or token for another account is refused (`wrong_account`), and `complete` is only ever called for the caller's own `{ sellerId, account }` | `SellerAnchorAuth.verify` / `complete`, `customerOf(seller)` | `anchor-kyc-security.test.ts` "cross-seller", `anchor-session.test.ts` |
| 9 | **Caching**: every response from both groups, errors included, carries `Cache-Control: no-store` | Middleware at the top of each route group | `anchor-kyc-security.test.ts` "not cacheable" |
| 10 | **Session expiry**: an expired or missing anchor session is `403 anchor_auth_required`, never a 500, and an undecryptable stored session is dropped so the seller is asked to reconnect | `AnchorAuthRequiredError` mapping; `DrizzleAnchorSessionRepository.get` | `kyc-route-auth.test.ts`, `anchor-session-repo.test.ts` |
| 11 | **Logging**: no PII values and no tokens in logs. Field names may be logged, values and the anchor JWT may not | Structured logger; `anchor_session.undecryptable` carries ids only | `anchor-session-repo.test.ts`, `anchor-error-sanitization.test.ts` |
| 12 | Consent is session-only and covers exactly the fields the anchor currently requires | `consentApp` guard in `kyc.ts` | `kyc-consent.test.ts` |

## Decisions recorded here

- **API keys do not read identity.** An integration that automates cash-outs
  needs the KYC *status* and which fields are still required, not the values.
  If a deployment later has a real need, it should be a separate, explicitly
  named scope rather than a side effect of `offramp:initiate`.
- **The strict limiter is per seller, not per IP**, for the routes that call the
  anchor, so rotating IPs or API keys does not multiply the traffic sent to the
  anchor on one seller's behalf.
- **Bounds are deliberately generous** relative to SEP-9 (real fields are short
  and few). They exist to stop a caller using the route as a way to push large
  or arbitrary payloads at an anchor, not to validate field content.

## Known gaps

- Field *content* is not validated here (that is the anchor's job, and the web
  form validates SEP-9 types client-side).
- There is no audit trail of who read identity (tracked separately as the PII
  access log).
