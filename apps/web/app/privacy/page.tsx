"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export const NOTICE_VERSION = "2024.1";

export default function PrivacyPage() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(true);
  }, []);

  if (!loaded) {
    return (
      <main style={{ padding: 32, maxWidth: 800, margin: "0 auto" }}>
        <div className="skeleton skeleton--w100" style={{ height: 24, marginBottom: 16 }} />
        <div className="skeleton skeleton--w80" style={{ height: 16, marginBottom: 24 }} />
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skeleton skeleton--w100" style={{ height: 16, marginBottom: 12 }} />
        ))}
      </main>
    );
  }

  return (
    <main style={{ padding: 32, maxWidth: 800, margin: "0 auto" }}>
      <header style={{ marginBottom: 32, borderBottom: "1px solid var(--border)", paddingBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Privacy Notice</h1>
        <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
          Last updated: 2024 | Notice version: {NOTICE_VERSION}
        </p>
        <p className="muted" style={{ marginTop: 8, fontSize: 14, fontStyle: "italic" }}>
          <strong>This document is a template. It is not legal advice.</strong> Deployers must review and adapt it with qualified counsel before use.
        </p>
      </header>

      <nav style={{ marginBottom: 24, padding: 12, background: "var(--surface-2, #f3f4f6)", borderRadius: 8 }}>
        <strong>Jump to:</strong>
        <ul style={{ margin: "8 0 0", paddingLeft: 20, columns: 2, columnGap: 16 }}>
          <li><a href="#controller" style={{ color: "var(--blue)" }}>1. Data Controller</a></li>
          <li><a href="#data-map" style={{ color: "var(--blue)" }}>2. Data Map</a></li>
          <li><a href="#recipients" style={{ color: "var(--blue)" }}>3. Recipients</a></li>
          <li><a href="#transfers" style={{ color: "var(--blue)" }}>4. International Transfers</a></li>
          <li><a href="#rights" style={{ color: "var(--blue)" }}>5. Your Rights</a></li>
          <li><a href="#retention" style={{ color: "var(--blue)" }}>6. Retention</a></li>
          <li><a href="#breach" style={{ color: "var(--blue)" }}>7. Breach Handling</a></li>
          <li><a href="#design" style={{ color: "var(--blue)" }}>8. Protection by Design</a></li>
          <li><a href="#contact" style={{ color: "var(--blue)" }}>9. Contact</a></li>
        </ul>
      </nav>

      <section id="controller" style={{ marginBottom: 32 }}>
        <h2>1. Data Controller</h2>
        <p>
          The operator of this Stellar Checkout (Quay) deployment is the data controller responsible for your personal data under the Nigeria Data Protection Act 2023 (NDPA).
        </p>
        <p className="muted" style={{ fontSize: 14 }}>
          <strong>Legal Name:</strong> [OPERATOR LEGAL NAME]<br />
          <strong>Address:</strong> [OPERATOR ADDRESS]<br />
          <strong>Contact Email:</strong> [DPO OR PRIVACY CONTACT EMAIL]<br />
          <strong>Data Protection Officer:</strong> [DPO NAME AND CONTACT]<br />
          <strong>NDPA Registration:</strong> [NDPC REGISTRATION NUMBER, IF APPLICABLE]
        </p>
        <p className="muted" style={{ fontSize: 13, fontStyle: "italic", marginTop: 8 }}>
          This document is a template. The deployer must fill in the bracketed fields with their legal details before going live.
        </p>
      </section>

      <section id="data-map" style={{ marginBottom: 32 }}>
        <h2>2. What Personal Data We Collect and Why</h2>
        <p>
          Quay collects only the personal data necessary to provide non-custodial payment links and seller-initiated cash-outs through the Stellar anchor network.
        </p>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface-2, #f3f4f6)", textAlign: "left" }}>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Data</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Where Stored</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Encrypted</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Purpose</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Lawful Basis</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Recipients</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Retention</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Erasable Via</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Seller wallet address</td>
              <td style={{ padding: 8 }}><code>sellers.wallet</code></td>
              <td style={{ padding: 8 }}>No (public key)</td>
              <td style={{ padding: 8 }}>Unique ID; payment destination; SEP-10 auth</td>
              <td style={{ padding: 8 }}>Contract; Legitimate interest</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Account deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Seller name</td>
              <td style={{ padding: 8 }}><code>sellers.name</code></td>
              <td style={{ padding: 8 }}>No</td>
              <td style={{ padding: 8 }}>Display in dashboard; receipts to buyers</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Buyers, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Account deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Payout fields (legacy)</td>
              <td style={{ padding: 8 }}><code>sellers.payout_fields_json</code></td>
              <td style={{ padding: 8 }}>No (plaintext)</td>
              <td style={{ padding: 8 }}>Reuse bank details on cash-out</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Account deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Payout fields (encrypted)</td>
              <td style={{ padding: 8 }}><code>sellers.payout_fields_encrypted</code></td>
              <td style={{ padding: 8 }}>Yes (AES-256-GCM)</td>
              <td style={{ padding: 8 }}>Reuse bank details on cash-out</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Account deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>KYC fields</td>
              <td style={{ padding: 8 }}><code>seller_kyc.fields_encrypted</code></td>
              <td style={{ padding: 8 }}>Yes (AES-256-GCM)</td>
              <td style={{ padding: 8 }}>Anchor SEP-12 KYC compliance</td>
              <td style={{ padding: 8 }}>Contract; Legal obligation</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>KYC erasure (4.28)</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Anchor customer ID</td>
              <td style={{ padding: 8 }}><code>seller_kyc.customer_id</code></td>
              <td style={{ padding: 8 }}>No</td>
              <td style={{ padding: 8 }}>Reference to anchor's record</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>KYC erasure (4.28)</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Anchor SEP-10 session token</td>
              <td style={{ padding: 8 }}><code>anchor_sessions.token_encrypted</code></td>
              <td style={{ padding: 8 }}>Yes (AES-256-GCM)</td>
              <td style={{ padding: 8 }}>KYC/withdrawal actions at anchor</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Anchor, Host, DB</td>
              <td style={{ padding: 8 }}>Until expiry (~24h)</td>
              <td style={{ padding: 8 }}>Auto-expiry; revocation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Payer wallet address</td>
              <td style={{ padding: 8 }}><code>link_payments.payer</code></td>
              <td style={{ padding: 8 }}>No</td>
              <td style={{ padding: 8 }}>Payment matching; fraud detection</td>
              <td style={{ padding: 8 }}>Legitimate interest</td>
              <td style={{ padding: 8 }}>Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite (audit)</td>
              <td style={{ padding: 8 }}>Not erasable (audit)</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Webhook URLs</td>
              <td style={{ padding: 8 }}><code>webhooks.url</code></td>
              <td style={{ padding: 8 }}>No</td>
              <td style={{ padding: 8 }}>Deliver payment events</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Webhook deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>API key metadata</td>
              <td style={{ padding: 8 }}><code>api_keys.name, prefix, scopes</code></td>
              <td style={{ padding: 8 }}>Key itself never stored</td>
              <td style={{ padding: 8 }}>Programmatic access</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Host, DB</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>Key revocation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Logs (redacted)</td>
              <td style={{ padding: 8 }}>Application logs</td>
              <td style={{ padding: 8 }}>N/A</td>
              <td style={{ padding: 8 }}>Debugging, monitoring, audit</td>
              <td style={{ padding: 8 }}>Legitimate interest</td>
              <td style={{ padding: 8 }}>Host, log aggregator</td>
              <td style={{ padding: 8 }}>30 days</td>
              <td style={{ padding: 8 }}>Log rotation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Database backups</td>
              <td style={{ padding: 8 }}>Turso/SQLite dump</td>
              <td style={{ padding: 8 }}>Matches source</td>
              <td style={{ padding: 8 }}>Disaster recovery</td>
              <td style={{ padding: 8 }}>Legal obligation</td>
              <td style={{ padding: 8 }}>DB provider, storage</td>
              <td style={{ padding: 8 }}>30 days</td>
              <td style={{ padding: 8 }}>Backup expiry</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="recipients" style={{ marginBottom: 32 }}>
        <h2>3. Who We Share Data With</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface-2, #f3f4f6)", textAlign: "left" }}>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Recipient</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Data Categories</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Legal Basis</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Safeguards</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Anchor (e.g., <code>testanchor.stellar.org</code>)</td>
              <td style={{ padding: 8 }}>KYC fields, payout fields, wallet address, SEP-10 token</td>
              <td style={{ padding: 8 }}>Contract; Legal obligation (AML/KYC)</td>
              <td style={{ padding: 8 }}>Anchor's NDPA compliance; HTTPS; SEP-10 JWT scope limited</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Hosting Provider (Render)</td>
              <td style={{ padding: 8 }}>All data in DB, logs, backups</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Render DPA; ISO 27001; data residency</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>DB Provider (Turso/libSQL)</td>
              <td style={{ padding: 8 }}>All data in DB, backups</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Turso DPA; encryption at rest; SOC 2</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Buyer (receipt)</td>
              <td style={{ padding: 8 }}>Seller name, wallet, amount, asset, status</td>
              <td style={{ padding: 8 }}>Contract</td>
              <td style={{ padding: 8 }}>Only data seller chose to display</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Law Enforcement / Regulator</td>
              <td style={{ padding: 8 }}>Any data subject to lawful request</td>
              <td style={{ padding: 8 }}>Legal obligation</td>
              <td style={{ padding: 8 }}>Only on valid legal process; documented</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="transfers" style={{ marginBottom: 32 }}>
        <h2>4. International Transfers</h2>
        <p>
          Quay deployments on Render may use US-based infrastructure. Data may be processed in the United States.
          The deployer must ensure appropriate transfer mechanisms (e.g., Standard Contractual Clauses) are in place
          if personal data leaves Nigeria.
        </p>
      </section>

      <section id="rights" style={{ marginBottom: 32 }}>
        <h2>5. Your Rights Under NDPA</h2>
        <p>As a data subject, you have the following rights:</p>
        <ul>
          <li><strong>Access</strong> — Request a copy of all personal data via support email or the dashboard's "Export Data" (issue 4.27).</li>
          <li><strong>Rectification</strong> — Update name/profile kind in dashboard; KYC fields updated via re-submission.</li>
          <li><strong>Erasure</strong> — Request account deletion via support; KYC erasure (issue 4.28) removes KYC fields; wallet/payment records retained for audit.</li>
          <li><strong>Restriction</strong> — Contact support to restrict processing of specific fields.</li>
          <li><strong>Portability</strong> — Use "Export Data" (CSV) for payment records; KYC export (issue 4.27) for identity data.</li>
          <li><strong>Objection</strong> — Object to processing based on legitimate interest via support.</li>
          <li><strong>Withdraw Consent</strong> — Revoke KYC consent for specific anchor in dashboard (issue 4.26).</li>
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>
          We respond within 30 days as required by NDPA Section 34.
        </p>
      </section>

      <section id="retention" style={{ marginBottom: 32 }}>
        <h2>6. Retention Schedule</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface-2, #f3f4f6)", textAlign: "left" }}>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Data Category</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Retention</th>
              <th style={{ padding: "8 4", borderBottom: "2px solid var(--border)" }}>Deletion Trigger</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Seller account data (wallet, name, profile kind)</td>
              <td style={{ padding: 8 }}>Indefinite while active</td>
              <td style={{ padding: 8 }}>Seller account deletion request</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>KYC fields</td>
              <td style={{ padding: 8 }}>Indefinite while active</td>
              <td style={{ padding: 8 }}>KYC erasure request or account deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Payout fields</td>
              <td style={{ padding: 8 }}>Indefinite while active</td>
              <td style={{ padding: 8 }}>Account deletion request</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Anchor session tokens</td>
              <td style={{ padding: 8 }}>Until expiry (~24h)</td>
              <td style={{ padding: 8 }}>Auto-expiry; manual revocation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Payment records (payer, amount, link)</td>
              <td style={{ padding: 8 }}>Indefinite</td>
              <td style={{ padding: 8 }}>N/A (audit trail)</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Webhook URLs</td>
              <td style={{ padding: 8 }}>Indefinite while active</td>
              <td style={{ padding: 8 }}>Webhook deletion</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>API keys</td>
              <td style={{ padding: 8 }}>Indefinite while active</td>
              <td style={{ padding: 8 }}>Key revocation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Logs</td>
              <td style={{ padding: 8 }}>30 days</td>
              <td style={{ padding: 8 }}>Log rotation</td>
            </tr>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: 8 }}>Backups</td>
              <td style={{ padding: 8 }}>30 days</td>
              <td style={{ padding: 8 }}>Backup rotation</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="breach" style={{ marginBottom: 32 }}>
        <h2>7. Data Breach Notification (NDPA 72-Hour Duty)</h2>
        <p>In the event of a personal data breach, we follow this process:</p>
        <ol>
          <li><strong>Detect & Contain (immediate)</strong> — Rotate <code>KYC_ENCRYPTION_KEY</code>, revoke anchor sessions, assess scope.</li>
          <li><strong>Assess Risk (within 24 hours)</strong> — Likelihood of harm, types of data involved (KYC fields = high risk).</li>
          <li><strong>Notify (within 72 hours)</strong> — NDPC via <a href="https://ndpc.gov.ng" target="_blank" rel="noopener noreferrer">ndpc.gov.ng</a> breach portal; affected sellers by email; anchor(s) if involved; hosting/DB providers per DPA.</li>
          <li><strong>Document</strong> — Record in incident log; update this notice if material changes.</li>
        </ol>
        <p className="muted" style={{ fontSize: 13 }}>
          See <a href="/runbook" style={{ color: "var(--blue)" }}>docs/RUNBOOK.md</a> "PII Breach" section for operational steps.
        </p>
      </section>

      <section id="design" style={{ marginBottom: 32 }}>
        <h2>8. Data Protection by Design</h2>
        <ul>
          <li><strong>Encryption at rest:</strong> KYC fields and payout fields encrypted with AES-256-GCM (<code>KYC_ENCRYPTION_KEY</code>).</li>
          <li><strong>Encryption in transit:</strong> All API/anchor traffic over HTTPS.</li>
          <li><strong>Pseudonymization:</strong> Seller wallet is a pseudonymous identifier; no email/phone stored.</li>
          <li><strong>Data minimisation:</strong> <code>selectFieldsForAnchor</code> (issue 4.25) sends only fields the anchor requests.</li>
          <li><strong>Purpose limitation:</strong> Each data item collected for a specific, documented purpose.</li>
          <li><strong>Storage limitation:</strong> Retention schedule enforced; backups rotated.</li>
        </ul>
      </section>

      <section id="contact" style={{ marginBottom: 32 }}>
        <h2>9. Contact</h2>
        <p>For questions or to exercise your rights:</p>
        <ul>
          <li><strong>Email:</strong> <a href="mailto:[PRIVACY CONTACT EMAIL]">[PRIVACY CONTACT EMAIL]</a></li>
          <li><strong>Address:</strong> [OPERATOR ADDRESS]</li>
        </ul>
      </section>

      <hr style={{ margin: "32 0", borderColor: "var(--border)" }} />
      <footer style={{ fontSize: 13, color: "var(--text-2, #6b7280)" }}>
        <p>
          <strong>NOTICE_VERSION:</strong> {NOTICE_VERSION} — This version is stored in consent records (issue 4.26).<br />
          <strong>This document is a template. It is not legal advice.</strong> Deployers must review and adapt it with qualified counsel before use.
        </p>
      </footer>
    </main>
  );
}