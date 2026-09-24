"use client";

import { useState } from "react";
import { api, CheckoutError, describeError, type AnchorAuthView, type KycView } from "../../lib/api";
import { signTransaction } from "../../lib/wallet";
import { useSellerWallet } from "./SessionGate";

function humanize(field: { name: string; description?: string }): string {
  return field.description || field.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function KycPanel({
  kyc,
  anchor,
  onUpdated,
  onAnchorConnected,
}: {
  kyc: KycView | null;
  anchor: AnchorAuthView | null;
  onUpdated: (kyc: KycView) => void;
  onAnchorConnected: () => void;
}) {
  const wallet = useSellerWallet();
  const [connecting, setConnecting] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  async function submit(fields: Record<string, string>) {
    setError(null);
    setMissing(new Set());
    setSubmitting(true);
    try {
      const next = await api.submitKyc(fields);
      onUpdated(next);
      setValues({});
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "kyc_required") {
        setMissing(new Set(e.missingFields ?? []));
        setError("Please fill in the required fields below.");
      } else {
        setError(e instanceof Error ? e.message : "Failed to submit identity information");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // The anchor knows you by your own wallet, so your wallet signs in to it —
  // the same kind of challenge as the dashboard login, issued by the anchor.
  async function connectAnchor() {
    if (!wallet) return;
    setError(null);
    setConnecting(true);
    try {
      const { transaction } = await api.getAnchorChallenge();
      const signed = await signTransaction(transaction, wallet);
      await api.completeAnchorAuth(signed);
      onAnchorConnected();
    } catch (e) {
      if (e instanceof CheckoutError) setError(describeError(e));
      else setError("Signing was cancelled or the wallet is unavailable.");
    } finally {
      setConnecting(false);
    }
  }

  if (anchor?.required && !anchor.connected) {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Cash-out runs through {anchor.anchor ?? "the anchor"}, which verifies you by your wallet
          address. Sign its challenge to connect. It is never submitted, and it cannot move your funds.
        </p>
        <button className="btn btn--primary" onClick={connectAnchor} disabled={connecting || !wallet}>
          {connecting ? "Waiting for wallet…" : `Connect to ${anchor.anchor ?? "anchor"}`}
        </button>
        {error && <div className="err">{error}</div>}
      </section>
    );
  }

  if (!kyc) {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <div className="muted">Loading…</div>
      </section>
    );
  }

  if (kyc.status === "ACCEPTED") {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <div className="kyc-note kyc-note--ok">Verified — you can cash out to local currency.</div>
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
          {field.choices ? (
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
            <input
              id={`kyc-${field.name}`}
              value={values[field.name] ?? kyc.providedFields[field.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
              aria-invalid={missing.has(field.name)}
              style={missing.has(field.name) ? { borderColor: "var(--red)" } : undefined}
            />
          )}
        </div>
      ))}

      <button
        className="btn btn--primary btn--block"
        onClick={() => submit(values)}
        disabled={submitting}
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
      {error && <div className="err">{error}</div>}
    </section>
  );
}
