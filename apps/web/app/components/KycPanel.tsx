"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  CheckoutError,
  describeError,
  type AnchorAuthView,
  type KycView,
  type PrefillConsentView,
} from "../../lib/api";
import { useAnchorConnect } from "../../lib/anchor-session";
import { useSellerWallet } from "./SessionGate";

function humanize(field: { name: string; description?: string }): string {
  return field.description || field.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * SEP-24 prefill consent (issue 3.17).
 *
 * Off by default, one box per field, and every box is OFF on first render — a
 * seller sharing identity with a cash-out provider is a decision, not a
 * convenience we opt them into. Values are never shown or sent from here: this
 * sends field NAMES, and Quay decides what to do with them.
 */
function PrefillConsent({ anchor }: { anchor: string | null }) {
  const [consent, setConsent] = useState<PrefillConsentView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getPrefillConsent();
      setConsent(next);
      setSelected(new Set(next.fields));
    } catch (e) {
      // A deployment with no anchor wired up 404s this. Not worth an error
      // banner on the identity panel.
      if (e instanceof CheckoutError) setConsent(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: Set<string>) {
    setError(null);
    setSaving(true);
    try {
      const saved = await api.setPrefillConsent([...next]);
      setConsent(saved);
      setSelected(new Set(saved.fields));
    } catch (e) {
      setError(e instanceof CheckoutError ? describeError(e) : "Could not save your choice.");
      // Re-read so the checkboxes cannot drift from what is actually stored.
      void load();
    } finally {
      setSaving(false);
    }
  }

  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
    void save(next);
  }

  if (!consent || consent.available.length === 0) return null;

  return (
    <fieldset style={{ border: 0, padding: 0, margin: "18px 0 0" }}>
      <legend style={{ fontSize: 13, fontWeight: 600, padding: 0 }}>
        Share these with {anchor ?? consent.anchorDomain} to pre-fill its form
      </legend>
      <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12 }}>
        Optional, and off unless you tick a box. {consent.anchorDomain} already knows you from
        your wallet, so this only saves you retyping what it asks for.
      </p>
      <div style={{ display: "grid", gap: 6 }}>
        {consent.available.map((name) => (
          <label key={name} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={selected.has(name)}
              disabled={saving}
              onChange={() => toggle(name)}
            />
            {humanize({ name })}
          </label>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
    </fieldset>
  );
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

  if (anchor?.required && !anchor.connected) {
    return (
      <section className="panel">
        <h2>Identity verification</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Cash-out runs through {anchor.anchor ?? "the anchor"}, which verifies you by your wallet
          address. Sign its challenge to connect. It is never submitted, and it cannot move your funds.
        </p>
        <button className="btn btn--primary" onClick={connectAnchor} disabled={connecting || !hasWallet}>
          {connecting ? "Waiting for wallet…" : `Connect to ${anchor.anchor ?? "anchor"}`}
        </button>
        {(anchorError || error) && <div className="err">{anchorError || error}</div>}
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
        {/* Only meaningful once there is a profile to share. */}
        <PrefillConsent anchor={anchor?.anchor ?? null} />
        {error && <div className="err">{error}</div>}
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
