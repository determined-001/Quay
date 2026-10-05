"use client";

import { useState } from "react";
import { api, type ErasureResult } from "../../lib/api";
import { useSellerWallet } from "./SessionGate";

/** Shown before confirming; mirrors what the API reports as retained. */
export const RETAINED_BEFORE_ERASE = [
  { what: "Payment history", why: "public on the Stellar ledger" },
  { what: "Links and payment records", why: "kept for your own accounting" },
  { what: "Your seller account", why: "your wallet is your login; deleting the account is a separate decision" },
  { what: "Database backups", why: "expire after the backup retention window" },
];

const ANCHOR_RESULTS: Record<string, string> = {
  erased: "Erased at the anchor",
  not_held: "The anchor held nothing",
  "not_attempted:no_session": "Not attempted: connect to the anchor first, then erase again to remove data it holds",
};

function anchorResultText(result: string): string {
  if (ANCHOR_RESULTS[result]) return ANCHOR_RESULTS[result]!;
  if (result.startsWith("refused:")) return `The anchor refused (${result.slice(8)}); it may be required to retain this data`;
  return result;
}

export default function ErasePanel() {
  const wallet = useSellerWallet();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ErasureResult | null>(null);

  const matches = !!wallet && typed.trim() === wallet;

  async function erase() {
    if (!wallet || !matches) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.eraseProfile(wallet));
      setOpen(false);
      setTyped("");
    } catch {
      setError("We couldn't erase your data. Nothing was changed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Erase my identity data">
      <h2>Erase my identity data</h2>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Removes your saved profile, KYC records, consents, anchor sessions and saved payout details from Quay, and asks
        your anchor to erase what it holds. This cannot be undone.
      </p>

      {result && (
        <div role="status" style={{ marginBottom: 12 }}>
          <p>Your identity data was erased from Quay.</p>
          <ul style={{ paddingLeft: 20 }}>
            {result.anchors.map((a) => (
              <li key={a.anchorDomain}>
                <strong>{a.anchorDomain}</strong>: {anchorResultText(a.result)}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 13 }}>
            Still retained: {result.retained.map((r) => `${r.what} (${r.why})`).join("; ")}.
          </p>
        </div>
      )}

      {!open ? (
        <button className="btn btn--ghost" onClick={() => { setOpen(true); setResult(null); }}>
          Erase my identity data
        </button>
      ) : (
        <div>
          <p style={{ fontSize: 13, marginBottom: 6 }}>Not erasable here, and kept:</p>
          <ul style={{ paddingLeft: 20, fontSize: 13, marginBottom: 12 }} aria-label="Retained data">
            {RETAINED_BEFORE_ERASE.map((r) => (
              <li key={r.what}>
                <strong>{r.what}</strong>: {r.why}
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="erase-confirm">Type your wallet address to confirm</label>
            <input
              id="erase-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={wallet ?? ""}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {error && <p className="error-banner__text" role="alert">{error}</p>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={erase} disabled={!matches || busy}>
              {busy ? "Erasing…" : "Erase permanently"}
            </button>
            <button className="btn btn--ghost" onClick={() => { setOpen(false); setTyped(""); setError(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
