# Privacy Notice & Data Map

**This document is a template. It is not legal advice. Deployers must review and adapt it with qualified counsel before use.**

This privacy notice describes the personal data Stellar Checkout (Quay) processes, why it processes it, with whom it shares it, how long it retains it, and the rights available to data subjects under the Nigeria Data Protection Act 2023 (NDPA).

---

## 1. Data Controller

The operator of this Quay deployment is the data controller. The deployer must fill in their legal details below before going live.

| Field | Value |
|-------|-------|
| **Legal Name** | `[OPERATOR LEGAL NAME]` |
| **Registered Address** | `[OPERATOR ADDRESS]` |
| **Contact Email** | `[DPO OR PRIVACY CONTACT EMAIL]` |
| **Data Protection Officer** | `[DPO NAME AND CONTACT]` |
| **NDPA Registration Number** | `[NDPC REGISTRATION NUMBER, IF APPLICABLE]` |

**NOTICE_VERSION:** `2026.1` — the version of this notice (`NOTICE_VERSION` in `apps/web/app/privacy/page.tsx`); increment it when the notice changes materially. It is not yet what consent records store: `POST /seller/kyc/consent` currently writes a fixed `notice_version` of `1.0` into `kyc_consents` (issue 4.26), which is what `GET /seller/profile/export` and `docs/API.md` show.

---

## 2. Data Map

The table below lists every personal data item Quay stores, where it lives, the purpose, lawful basis under NDPA, recipients, retention, and how it can be erased.

| Data | Where (table.column) | Encrypted | Purpose | Lawful Basis (NDPA) | Recipients | Retention | Erasable via |
|------|----------------------|-----------|---------|---------------------|------------|-----------|--------------|
| **Seller wallet address** | `sellers.wallet` | No (public key) | Unique identifier for the seller; destination for on-chain payments; used for SEP-10 auth | Contract (service provision); Legitimate interest (fraud prevention) | Anchor (SEP-10 auth), Hosting provider, DB provider | Indefinite (the `sellers` row is kept by erasure and by the sweep) | Not erased by `DELETE /seller/profile`; deleting the account is a separate decision made with the operator |
| **Seller name** | `sellers.name` | No | Display name in dashboard; included in receipts sent to buyers | Contract (service provision) | Buyers (in receipts), Hosting provider, DB provider | Indefinite (the `sellers` row is kept by erasure and by the sweep) | Not erased by `DELETE /seller/profile`; deleting the account is a separate decision made with the operator |
| **Profile kind** | `sellers.profile_kind` | No | Determines which SEP-9 field set to present | Contract (service provision) | Hosting provider, DB provider | Indefinite (the `sellers` row is kept by erasure and by the sweep) | Not erased by `DELETE /seller/profile`; deleting the account is a separate decision made with the operator |
| **Payout fields (legacy plaintext)** | `sellers.payout_fields_json` | **No (plaintext JSON)** | Reuse bank/account details on subsequent cash-outs | Contract (service provision) | Anchor (cash-out), Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep |
| **Payout fields (encrypted)** | `sellers.payout_fields_encrypted` | **Yes (AES-256-GCM, KYC_ENCRYPTION_KEY)** | Reuse bank/account details on subsequent cash-outs | Contract (service provision) | Anchor (cash-out), Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep |
| **KYC fields (encrypted)** | `seller_kyc.fields_encrypted` | **Yes (AES-256-GCM, KYC_ENCRYPTION_KEY)** | Satisfy anchor SEP-12 KYC requirements | Contract (service provision); Legal obligation (anchor AML) | Anchor (SEP-12), Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep; the same call also asks the anchor to erase its copy |
| **Anchor customer ID** | `seller_kyc.customer_id` | No | Reference to seller's record at the anchor; avoids re-creation | Contract (service provision) | Anchor, Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep |
| **Anchor SEP-10 session token** | `anchor_sessions.token_encrypted` | **Yes (AES-256-GCM, WEBHOOK_SECRET_ENCRYPTION_KEY)** | Bearer token for seller's KYC/withdrawal actions at anchor | Contract (service provision) | Anchor, Hosting provider, DB provider | Until `expires_at` (set by the anchor, capped by Quay at 7 days); an hourly sweep then deletes the row once it has been expired for 24 hours; also removed by the inactivity sweep | Seller disconnect (`DELETE /seller/anchor-auth`); `DELETE /seller/profile`; auto-expiry sweep |
| **Payer wallet address** | `link_payments.payer` | No | Correlates on-chain payment to the buyer | Legitimate interest (payment matching, fraud detection) | Hosting provider, DB provider | Indefinite (audit trail) | Not erasable (audit requirement) |
| **Webhook URLs** | `webhooks.url` | No | Deliver payment/cash-out events to seller's systems | Contract (service provision) | Hosting provider, DB provider | Indefinite (while webhook active) | Seller webhook deletion |
| **API key metadata** | `api_keys.name`, `api_keys.prefix`, `api_keys.scopes` | No (key itself never stored; only scrypt hash) | Identify and scope programmatic access | Contract (service provision) | Hosting provider, DB provider | Indefinite (while key active) | Seller API key revocation |
| **Logs (redacted)** | Application logs (stdout/file) | N/A | Debugging, monitoring, audit trail | Legitimate interest (operational stability, security) | Hosting provider, log aggregator | Per log retention policy (default 30 days) | Log rotation |
| **Database backups** | Turso/SQLite dump files | Matches source tables | Disaster recovery | Legal obligation (business continuity) | DB provider (Turso), storage provider | 30 days (configurable) | Backup expiry / manual deletion |
| **KYC consent records** | `kyc_consents` (4.26) | No | Record seller's consent to share fields with anchor | Legal obligation (NDPA consent) | Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days); revoking consent keeps the row with `revoked_at` set | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep. Revocation (`DELETE /seller/kyc/consent/:anchorDomain`) stops future sends but does not delete the row |
| **SEP-24 prefill consent** | `prefill_consents` | No (field names only, never values) | Record which SEP-9 fields the seller agreed to put in an anchor's SEP-24 form prefill (`/seller/kyc/prefill-consent`) | Consent (NDPA) | Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep; consent can be withdrawn with an empty `PUT /seller/kyc/prefill-consent` |
| **PII access log** | `pii_audit` | No (seller id, actor, action, field names and request id; never values) | Show who read or wrote a seller's identity data, for breach assessment | Legal obligation (NDPA security and breach duties); Legitimate interest (security) | Hosting provider, DB provider | 2 years, then deleted by a daily sweep; not removed by erasure | Daily sweep only; deliberately kept when the seller erases their data |
| **KYC disclosure history** | `kyc_disclosure_fields` | No (field names and send times only, never values) | Show the seller which fields were sent to which anchor and when | Legal obligation (NDPA transparency) | Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep |
| **Seller profile (4.23)** | `seller_profile` | Yes (AES-256-GCM, KYC_ENCRYPTION_KEY) | Reusable SEP-9 field set across anchors | Contract (service provision) | Anchor (on submit), Hosting provider, DB provider | Until erased, or until the inactivity sweep (`KYC_RETENTION_DAYS`, default 730 days) | `DELETE /seller/profile` (dashboard "Erase my identity data"); inactivity sweep |

The **inactivity sweep** runs daily when `KYC_RETENTION_DAYS` is greater than 0 (default 730; `0` disables it). A seller's activity is their last wallet login, link creation or KYC submission; creation time is used if they have none. For a seller inactive for longer than the period it deletes, in one transaction, the reusable profile, KYC records, disclosure history, consent records and anchor sessions, and clears the saved payout fields. It skips any seller with a link in `offramp_pending`, never contacts the anchor, and never touches the `sellers` row, links, payments or cash-out jobs. See `docs/RUNBOOK.md` ("KYC and Identity Data Retention Policy").

---

## 3. Recipients (Third Parties)

| Recipient | Data Categories | Legal Basis | Safeguards |
|-----------|----------------|-------------|------------|
| **Anchor** (e.g., `testanchor.stellar.org` on testnet) | KYC fields, payout fields, wallet address, SEP-10 session token | Contract (service provision); Legal obligation (anchor AML/KYC) | Anchor's own NDPA compliance; HTTPS; SEP-10 JWT scope limited to KYC/withdrawal |
| **Hosting Provider** (Render) | All data in database, logs, backups | Contract (service provision) | Render's DPA; ISO 27001; data residency in selected region |
| **Database Provider** (Turso/libSQL) | All data in database, backups | Contract (service provision) | Turso's DPA; encryption at rest; SOC 2 |
| **Payment Sender (Buyer's Wallet)** | Seller wallet address, link reference, amount, asset | Contract (service provision) | On-chain; no additional data shared |
| **Buyer** (receipt) | Seller name, wallet address, amount, asset, status | Contract (service provision) | Only data seller chose to display |
| **Law Enforcement / Regulator** | Any data subject to lawful request | Legal obligation | Only on valid legal process; documented |

---

## 4. International Transfers

Quay deployments on Render may use US-based infrastructure. Data may be processed in the United States. The deployer must ensure appropriate transfer mechanisms (e.g., Standard Contractual Clauses) are in place if personal data leaves Nigeria.

---

## 5. Data Subject Rights (NDPA)

Data subjects (sellers) have the following rights:

| Right | How to Exercise |
|-------|-----------------|
| **Access** | Dashboard "Download my data" (`GET /seller/profile/export`, issue 4.27): a JSON file of your profile, KYC records, consents, disclosure history, anchor connections, saved payout details, links, payments, cash-outs, webhook URLs and API key names. Session login only (API keys are refused) and limited to 5 downloads per hour. It never contains tokens, secrets or key hashes. |
| **Rectification** | Update name/profile kind in dashboard; KYC fields updated via re-submission |
| **Erasure** | Dashboard "Erase my identity data" (`DELETE /seller/profile`, issue 4.28): you type your wallet address to confirm, Quay asks the anchor to erase its copy first, then deletes your profile, KYC records, consents, disclosure history and anchor sessions and clears saved payout fields. **Retained:** payment history (public on the Stellar ledger), links and payment records (your accounting), your seller account (your wallet login; deleting the account is a separate decision, contact the operator) and database backups (until they expire). |
| **Restriction** | Contact support to restrict processing of specific fields |
| **Portability** | "Download my data" (JSON) for identity and account data; "Export CSV" on the dashboard (`GET /links/export/csv`) for payment records |
| **Objection** | Object to processing based on legitimate interest via support |
| **Withdraw Consent** | Revoke KYC consent for specific anchor (`DELETE /seller/kyc/consent/:anchorDomain`, issue 4.26) |

**Response Time:** We respond within 30 days as required by NDPA Section 34.

---

## 6. Retention Schedule

| Data Category | Retention Period | Trigger for Deletion |
|---------------|------------------|----------------------|
| Seller account data (wallet, name, profile kind) | Indefinite | Not removed by erasure or by the inactivity sweep; account deletion is a separate decision made with the operator |
| KYC fields, anchor customer ID, reusable profile, disclosure history | Until erased, or until the seller has been inactive for `KYC_RETENTION_DAYS` (default 730 days; `0` disables) | `DELETE /seller/profile`; daily inactivity sweep (skips sellers with a cash-out in progress) |
| Payout fields | Until erased, or until the same inactivity period | `DELETE /seller/profile`; daily inactivity sweep |
| Anchor session tokens | Until `expires_at` (set by the anchor, capped at 7 days), deleted by an hourly sweep 24 hours after expiry | Auto-expiry sweep; disconnect; `DELETE /seller/profile`; inactivity sweep |
| Payment records (payer, amount, link) | Indefinite | N/A (audit trail) |
| Webhook URLs | Indefinite while active | Webhook deletion |
| API keys | Indefinite while active | Key revocation |
| Logs | 30 days (configurable) | Log rotation |
| Backups | 30 days (configurable) | Backup rotation |
| PII access log (who read which identity field names, when; never values) | 2 years, then deleted by a daily sweep. Not removed by erasure, so a breach can still be assessed after a seller erases their data | Daily sweep |
| Consent records | Until erased, or until the same inactivity period; revocation keeps the row with `revoked_at` set | `DELETE /seller/profile`; daily inactivity sweep |

---

## 7. Breach Handling (NDPA 72-Hour Notification)

In the event of a personal data breach:

1. **Detect & Contain** (immediate)
   - Rotate `KYC_ENCRYPTION_KEY` (see issue 4.31)
   - Revoke all `anchor_sessions` (issue 4.26 revocation)
   - Assess scope: which tables, how many sellers, what data exposed

2. **Assess Risk** (within 24 hours)
   - Likelihood of harm to data subjects
   - Types of data involved (KYC fields = high risk)

3. **Notify** (within 72 hours of awareness)
   - **NDPC** (Nigeria Data Protection Commission): via [ndpc.gov.ng](https://ndpc.gov.ng) breach portal
   - **Affected Sellers**: email with description, likely consequences, measures taken, contact for more info
   - **Anchor(s)**: if their data was involved
   - **Hosting/DB Providers**: per DPA obligations

4. **Document**
   - Record in incident log (date, scope, root cause, actions, notifications sent)
   - Update this notice if material changes

**See `docs/RUNBOOK.md` "PII Breach" section for operational steps.**

---

## 8. Data Protection by Design

- **Encryption at rest**: KYC fields and payout fields encrypted with AES-256-GCM (`KYC_ENCRYPTION_KEY`)
- **Encryption in transit**: All API/anchor traffic over HTTPS
- **Pseudonymization**: Seller wallet is pseudonymous identifier; no email/phone stored
- **Data minimisation**: `selectFieldsForAnchor` (issue 4.25) sends only fields the anchor requests
- **Purpose limitation**: Each data item collected for a specific, documented purpose
- **Access audit**: every read of a seller's identity data through an API route or a system path (such as the cash-out KYC gate) is recorded with the actor and request id, field names only. Operators query it with `GET /telemetry/pii-audit?sellerId=...` to answer "whose data was read, by what, and when" during a breach assessment; sellers see their own entries in the data export
- **Storage limitation**: Retention schedule enforced (daily inactivity sweep for identity data, hourly anchor session sweep); backups rotated

---

## 9. Contact

For questions or to exercise rights:

- **Email**: `[PRIVACY CONTACT EMAIL]`
- **Address**: `[OPERATOR ADDRESS]`

---

*Last updated: 2026. Generated from `docs/PRIVACY.md`. NOTICE_VERSION: `2026.1`.*