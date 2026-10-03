"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { api, CheckoutError, describeError, type AnchorAuthView, type KycView } from "../../lib/api";
import { useAnchorConnect } from "../../lib/anchor-session";
import { useSellerWallet } from "./SessionGate";
import { kycPanelStage, type KycLoadState } from "../../lib/kyc-load";
import Sep9Input from "./Sep9Input";
import { checkSep9Value, todayIso } from "../../lib/sep9-input";

function humanize(field: { name: string; description?: string }): string {
  return field.description || field.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface KycConsent {
  id: string;
  anchorDomain: string;
  fields: string[];
  grantedAt: number;
  revokedAt: number | null;
  grantedVia: string;
  noticeVersion: string;
}

export default function KycPanel({
  kyc,
  anchor,
  loadState = "ready",
  loadError = null,
  onRetry,
  onUpdated,
  onAnchorConnected,
}: {
  kyc: KycView | null;
  anchor: AnchorAuthView | null;
  loadState?: KycLoadState;
  loadError?: string | null;
  onRetry?: () => void;
  onUpdated: (kyc: KycView) => void;
  onAnchorConnected: () => void;
}) {
  const wallet = useSellerWallet();
  const {
    connecting,
    error: anchorError,
    connectAnchor,
    hasWallet,
  } = useAnchorConnect({
    wallet,
    onSuccess: onAnchorConnected,
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showConsent, setShowConsent] = useState(false);
  const [consentFields, setConsentFields] = useState<string[]>([]);
  const [consentAnchor, setConsentAnchor] = useState<string>("the anchor");
  const [consentLoading, setConsentLoading] = useState(false);
  const [existingConsents, setExistingConsents] = useState<KycConsent[]>([]);

  useEffect(() => {
    loadConsents();
  }, []);

  async function loadConsents() {
    try {
      const { consents } = await api.listKycConsents();
      setExistingConsents(consents);
    } catch {
      // Ignore errors loading consents
    }
  }

  async function handleConsentGrant() {
    setConsentLoading(true);
    setError(null);
    try {
      await api.grantKycConsent(consentAnchor, consentFields);
      setShowConsent(false);
      // Now submit the KYC fields
      await submit(values);
    } catch (e) {
      if (e instanceof CheckoutError) setError(describeError(e));
      else setError("Failed to grant consent");
    } finally {
      setConsentLoading(false);
    }
  }

  function setFieldError(name: string, message: string | null) {
    setFieldErrors((prev) => {
      if ((prev[name] ?? null) === message) return prev;
      const next = { ...prev };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  }

  /** Validate the visible fields with the shared SEP-9 rules; returns true when submit may proceed. */
  function validateAll(fields: Record<string, string>): boolean {
    const errors: Record<string, string> = {};
    const today = todayIso();
    for (const [name, value] of Object.entries(fields)) {
      const r = checkSep9Value(name, value, today);
      if (!r.ok) errors[name] = r.reason ?? "invalid value";
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError("Fix the highlighted fields before submitting.");
      return false;
    }
    return true;
  }

  async function submit(fields: Record<string, string>) {
    if (!validateAll(fields)) return;
    setError(null);
    setMissing(new Set());
    setSubmitting(true);
    try {
      let next: KycView;
      const textFields = { ...fields };
      if (Object.keys(textFields).length > 0 || Object.keys(files).length === 0) {
        next = await api.submitKyc(textFields);
      } else {
        next = kyc!;
      }
      if (Object.keys(files).length > 0) {
        const formData = new FormData();
        for (const [name, file] of Object.entries(files)) {
          formData.append(name, file);
        }
        next = await api.submitKycFiles(formData);
      }
      onUpdated(next);
      setValues({});
      await loadConsents();
      setFiles({});
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "kyc_required") {
        setMissing(new Set(e.missingFields ?? []));
        setError("Please fill in the required fields below.");
      } else if (e instanceof CheckoutError && e.code === "consent_required") {
        // Show consent dialog for the missing fields
        setConsentFields(e.details.fields as string[]);
        setConsentAnchor(e.details.anchorDomain as string);
        setShowConsent(true);
      } else {
        setError(e instanceof Error ? e.message : "Failed to submit identity information");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const stage = kycPanelStage({
    anchorNeedsConnect: Boolean(anchor?.required && !anchor.connected),
    state: loadState,
    hasKyc: kyc !== null,
  });

  if (stage === "connect") {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Cash-out runs through {anchor?.anchor ?? "the anchor"}, which verifies you by your wallet
          address. Sign its challenge to connect. It is never submitted, and it cannot move your funds.
        </p>
        <button className="btn btn--primary" onClick={connectAnchor} disabled={connecting || !hasWallet}>
          {connecting ? "Waiting for wallet…" : `Connect to ${anchor?.anchor ?? "anchor"}`}
        </button>
        {(anchorError || error) && <div className="err">{anchorError || error}</div>}
      </section>
    );
  }

  if (stage === "error") {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <div className="err" role="alert">
          {loadError ?? "Could not load identity verification."}
        </div>
        {onRetry && (
          <button className="btn btn--secondary" style={{ marginTop: 12 }} onClick={onRetry}>
            Try again
          </button>
        )}
      </section>
    );
  }

  if (stage === "loading" || !kyc) {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <div className="muted" role="status" aria-busy="true">
          Loading…
        </div>
      </section>
    );
  }

  if (kyc.status === "ACCEPTED") {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <div className="kyc-note kyc-note--ok">Verified — you can cash out to local currency.</div>
        {existingConsents.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer", color: "var(--blue)" }}>Consent history</summary>
            <ul style={{ marginTop: 8, fontSize: 13 }}>
              {existingConsents.map((c) => (
                <li key={c.id}>
                  <strong>{c.anchorDomain}</strong> — {c.fields.join(", ")} —
                  {c.revokedAt ? "revoked" : "active"} — {new Date(c.grantedAt).toLocaleDateString()}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    );
  }

  // Nothing discovered yet: kick off SEP-12 discovery with an empty submission.
  // The anchor's response tells us what it actually needs — we never guess.
  if (kyc.status === "unsubmitted" && kyc.requiredFields.length === 0) {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          The anchor requires identity verification (SEP-12 KYC) before it will pay out to local
          currency. Start verification to see what it needs from you.
        </p>
        <button className="btn btn--primary" onClick={() => submit({})} disabled={submitting}>
          {submitting ? "Starting…" : "Start verification"}
        </button>
        {error && <div className="err">{error}</div>}
      </section>
    );
  }

  // Consent dialog
  if (showConsent) {
    return (
      <section className="panel">
        <h2>Share identity with {consentAnchor}?</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          The anchor requires the following fields to process your cash-out. You must consent
          before they can be shared.
        </p>
        <ul style={{ marginTop: 8, marginBottom: 16 }}>
          {consentFields.map((field) => (
            <li key={field} style={{ marginBottom: 4 }}>
              <label>
                <input type="checkbox" checked readOnly />
                {humanize({ name: field })}
              </label>
            </li>
          ))}
        </ul>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn--primary" onClick={handleConsentGrant} disabled={consentLoading}>
            {consentLoading ? "Granting…" : "Share these fields"}
          </button>
          <button className="btn btn--secondary" onClick={() => setShowConsent(false)} disabled={consentLoading}>
            Cancel
          </button>
        </div>
        {error && <div className="err">{error}</div>}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Identity verification</h2>

      {kyc.status === "PROCESSING" && (
        <div className="kyc-note kyc-note--pending">Submitted — the anchor is reviewing it.</div>
      )}
      {kyc.status === "REJECTED" && (
        <div className="kyc-note kyc-note--rejected">
          Rejected{kyc.message ? `: ${kyc.message}` : ""}. Correct the fields below and resubmit.
        </div>
      )}
      {kyc.status === "NEEDS_INFO" && (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          The anchor still needs the following before it will pay out to local currency.
        </p>
      )}

      {kyc.requiredFields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`kyc-${field.name}`}>
            {humanize(field)}
            {!field.optional && " *"}
          </label>
          {field.type === "binary" ? (
            <div>
              <input
                type="file"
                id={`kyc-${field.name}`}
                accept="image/jpeg,image/png,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setFiles((f) => ({ ...f, [field.name]: file }));
                  } else {
                    setFiles((f) => {
                      const next = { ...f };
                      delete next[field.name];
                      return next;
                    });
                  }
                }}
                aria-invalid={missing.has(field.name)}
                style={missing.has(field.name) ? { borderColor: "var(--red)" } : undefined}
              />
              <small style={{ color: "var(--muted)", fontSize: 11, display: "block", marginTop: 4 }}>
                sent to {anchor?.anchor ?? "anchor"}, not stored by Quay
              </small>
            </div>
          ) : field.choices ? (
            <select
              id={`kyc-${field.name}`}
              value={values[field.name] ?? kyc.providedFields[field.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            >
              <option value="" disabled>
                Select…
              </option>
              {field.choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <Sep9Input
              id={`kyc-${field.name}`}
              name={field.name}
              value={values[field.name] ?? kyc.providedFields[field.name] ?? ""}
              onChange={(v) => setValues((cur) => ({ ...cur, [field.name]: v }))}
              onValidity={setFieldError}
              invalid={missing.has(field.name) || field.name in fieldErrors}
            />
          )}
        </div>
      ))}

      <button
        className="btn btn--primary btn--block"
        onClick={() => submit(values)}
        disabled={submitting || Object.keys(fieldErrors).length > 0}
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
      {error && <div className="err">{error}</div>}
      <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-2, #6b7280)", textAlign: "center" }}>
        By submitting, you consent to share the above fields with the anchor. See our
        <Link href="/privacy" style={{ color: "var(--blue)" }}>Privacy Notice</Link>
        for details on how your data is processed and your rights.
      </p>

      {existingConsents.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", color: "var(--blue)" }}>Consent history</summary>
          <ul style={{ marginTop: 8, fontSize: 13 }}>
            {existingConsents.map((c) => (
              <li key={c.id}>
                <strong>{c.anchorDomain}</strong> — {c.fields.join(", ")} —
                {c.revokedAt ? "revoked" : "active"} — {new Date(c.grantedAt).toLocaleDateString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}