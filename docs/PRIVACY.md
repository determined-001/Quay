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

**NOTICE_VERSION:** `2024.1` — increment when the notice changes materially. This version is stored in consent records (issue 4.26).

---

## 2. Data Map

The table below lists every personal data item Quay stores, where it lives, the purpose, lawful basis under NDPA, recipients, retention, and how it can be erased.

| Data | Where (table.column) | Encrypted | Purpose | Lawful Basis (NDPA) | Recipients | Retention | Erasable via |
|------|----------------------|-----------|---------|---------------------|------------|-----------|--------------|
| **Seller wallet address** | `sellers.wallet` | No (public key) | Unique identifier for the seller; destination for on-chain payments; used for SEP-10 auth | Contract (service provision); Legitimate interest (fraud prevention) | Anchor (SEP-10 auth), Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion (4.28) |
| **Seller name** | `sellers.name` | No | Display name in dashboard; included in receipts sent to buyers | Contract (service provision) | Buyers (in receipts), Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion (4.28) |
| **Profile kind** | `sellers.profile_kind` | No | Determines which SEP-9 field set to present | Contract (service provision) | Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion (4.28) |
| **Payout fields (legacy plaintext)** | `sellers.payout_fields_json` | **No (plaintext JSON)** | Reuse bank/account details on subsequent cash-outs | Contract (service provision) | Anchor (cash-out), Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion (4.28) |
| **Payout fields (encrypted)** | `sellers.payout_fields_encrypted` | **Yes (AES-256-GCM, KYC_ENCRYPTION_KEY)** | Reuse bank/account details on subsequent cash-outs | Contract (service provision) | Anchor (cash-out), Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion (4.28) |
| **KYC fields (encrypted)** | `seller_kyc.fields_encrypted` | **Yes (AES-256-GCM, KYC_ENCRYPTION_KEY)** | Satisfy anchor SEP-12 KYC requirements | Contract (service provision); Legal obligation (anchor AML) | Anchor (SEP-12), Hosting provider, DB provider | Indefinite (while KYC record exists) | Seller account deletion + KYC erasure (4.28) |
| **Anchor customer ID** | `seller_kyc.customer_id` | No | Reference to seller's record at the anchor; avoids re-creation | Contract (service provision) | Anchor, Hosting provider, DB provider | Indefinite (while KYC record exists) | Seller account deletion + KYC erasure (4.28) |
| **Anchor SEP-10 session token** | `anchor_sessions.token_encrypted` | **Yes (AES-256-GCM, WEBHOOK_SECRET_ENCRYPTION_KEY)** | Bearer token for seller's KYC/withdrawal actions at anchor | Contract (service provision) | Anchor, Hosting provider, DB provider | Until `expires_at` (typically 24h) | Auto-expiry; Seller revocation (4.26) |
| **Payer wallet address** | `link_payments.payer` | No | Correlates on-chain payment to the buyer | Legitimate interest (payment matching, fraud detection) | Hosting provider, DB provider | Indefinite (audit trail) | Not erasable (audit requirement) |
| **Webhook URLs** | `webhooks.url` | No | Deliver payment/cash-out events to seller's systems | Contract (service provision) | Hosting provider, DB provider | Indefinite (while webhook active) | Seller webhook deletion |
| **API key metadata** | `api_keys.name`, `api_keys.prefix`, `api_keys.scopes` | No (key itself never stored; only scrypt hash) | Identify and scope programmatic access | Contract (service provision) | Hosting provider, DB provider | Indefinite (while key active) | Seller API key revocation |
| **Logs (redacted)** | Application logs (stdout/file) | N/A | Debugging, monitoring, audit trail | Legitimate interest (operational stability, security) | Hosting provider, log aggregator | Per log retention policy (default 30 days) | Log rotation |
| **Database backups** | Turso/SQLite dump files | Matches source tables | Disaster recovery | Legal obligation (business continuity) | DB provider (Turso), storage provider | 30 days (configurable) | Backup expiry / manual deletion |
| **KYC consent records** | `kyc_consents` (planned, 4.26) | No | Record seller's consent to share fields with anchor | Legal obligation (NDPA consent) | Hosting provider, DB provider | Indefinite (audit trail) | Consent revocation (4.26) |
| **Seller profile (planned, 4.23)** | `seller_profile` (planned) | Yes (AES-256-GCM) | Reusable SEP-9 field set across anchors | Contract (service provision) | Anchor (on submit), Hosting provider, DB provider | Indefinite (while account exists) | Seller account deletion + profile erasure (4.28) |

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
| **Access** | Request a copy of all personal data via support email or the dashboard's "Export Data" (issue 4.27) |
| **Rectification** | Update name/profile kind in dashboard; KYC fields updated via re-submission |
| **Erasure** | Request account deletion via support; KYC erasure (4.28) removes KYC fields; wallet/payment records retained for audit |
| **Restriction** | Contact support to restrict processing of specific fields |
| **Portability** | Use "Export Data" (CSV) for payment records; KYC export (4.27) for identity data |
| **Objection** | Object to processing based on legitimate interest via support |
| **Withdraw Consent** | Revoke KYC consent for specific anchor in dashboard (issue 4.26) |

**Response Time:** We respond within 30 days as required by NDPA Section 34.

---

## 6. Retention Schedule

| Data Category | Retention Period | Trigger for Deletion |
|---------------|------------------|----------------------|
| Seller account data (wallet, name, profile kind) | Indefinite while account active | Seller account deletion request |
| KYC fields | Indefinite while KYC active | KYC erasure request or account deletion |
| Payout fields | Indefinite while account active | Account deletion request |
| Anchor session tokens | Until `expires_at` (default 24h) | Auto-expiry; manual revocation |
| Payment records (payer, amount, link) | Indefinite | N/A (audit trail) |
| Webhook URLs | Indefinite while active | Webhook deletion |
| API keys | Indefinite while active | Key revocation |
| Logs | 30 days (configurable) | Log rotation |
| Backups | 30 days (configurable) | Backup rotation |
| Consent records | Indefinite (audit trail) | N/A |

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
- **Storage limitation**: Retention schedule enforced; backups rotated

---

## 9. Contact

For questions or to exercise rights:

- **Email**: `[PRIVACY CONTACT EMAIL]`
- **Address**: `[OPERATOR ADDRESS]`

---

*Last updated: 2024. Generated from `docs/PRIVACY.md`. NOTICE_VERSION: `2024.1`.*