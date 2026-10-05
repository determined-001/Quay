"use client";

import { useState } from "react";
import { api, CheckoutError } from "../../lib/api";

/** What the file holds, shown before downloading; mirrors the API's export sections. */
const EXPORT_CONTENTS =
  "your profile, KYC records, consents and disclosure history, anchor connections, saved payout details, " +
  "links, payments and cash-outs, webhook URLs and API key names. It never contains passwords, tokens, secrets or key hashes.";

function exportErrorText(e: unknown): string {
  if (e instanceof CheckoutError && e.status === 429) {
    return "You can download your data up to 5 times an hour. Please try again later.";
  }
  return "We couldn't prepare your data. Please try again.";
}

export default function ExportPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function download() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const blob = await api.exportMyData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quay-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e) {
      setError(exportErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Download my data">
      <h2>Download my data</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Get a copy of the personal data Quay holds about you, as a JSON file. It includes {EXPORT_CONTENTS}
      </p>
      {done && (
        <p role="status" style={{ fontSize: 13, marginBottom: 12 }}>
          Your data was downloaded. Keep the file somewhere safe: it contains personal details.
        </p>
      )}
      {error && <p className="error-banner__text" role="alert">{error}</p>}
      <button className="btn btn--ghost" onClick={download} disabled={busy}>
        {busy ? "Preparing…" : "Download my data"}
      </button>
    </section>
  );
}
