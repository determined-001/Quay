"use client";

import { useEffect, useState } from "react";
import { api, CheckoutError, describeError } from "../../lib/api";

function label(name: string): string {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * "Share these with <anchor> to pre-fill its form" (issue 3.17).
 *
 * For anchors that use SEP-24, the anchor's own page collects KYC; this lets the
 * seller choose which values already on file are passed along so they need not
 * retype them. Every box starts off, only names the seller has a value for are
 * listed, and nothing is shared until they save.
 */
export default function PrefillConsent({ anchorName }: { anchorName: string }) {
  const [available, setAvailable] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getPrefillConsent()
      .then((view) => {
        if (!live || !Array.isArray(view?.available)) return;
        setAvailable(view.available);
        setSaved(view.fields ?? []);
        setChosen(new Set(view.fields ?? []));
      })
      .catch(() => {
        // No checklist is better than a broken one: the form simply is not prefilled.
      });
    return () => {
      live = false;
    };
  }, []);

  if (available.length === 0) return null;

  const dirty = chosen.size !== saved.length || saved.some((f) => !chosen.has(f));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const view = await api.setPrefillConsent([...chosen]);
      setSaved(view.fields);
      setChosen(new Set(view.fields));
      setMessage({
        kind: "ok",
        text: view.fields.length > 0 ? `Saved. ${anchorName} will receive these when you cash out.` : "Saved. Nothing will be shared.",
      });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof CheckoutError ? describeError(e) : "Could not save your choice." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset style={{ border: 0, padding: 0, margin: "20px 0 0" }}>
      <legend style={{ fontWeight: 600, padding: 0 }}>Share these with {anchorName} to pre-fill its form</legend>
      <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
        If {anchorName} asks for your details on its own page, these are filled in for you. Nothing is shared
        unless you tick it, and you can change this at any time.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {available.map((name) => (
          <li key={name} style={{ marginBottom: 4 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={chosen.has(name)}
                disabled={busy}
                onChange={(e) =>
                  setChosen((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(name);
                    else next.delete(name);
                    return next;
                  })
                }
              />
              {label(name)}
            </label>
          </li>
        ))}
      </ul>
      <button className="btn btn--secondary" style={{ marginTop: 8 }} onClick={save} disabled={busy || !dirty}>
        {busy ? "Saving…" : "Save choice"}
      </button>
      {message && (
        <div className={message.kind === "err" ? "err" : "muted"} role={message.kind === "err" ? "alert" : "status"} style={{ fontSize: 13 }}>
          {message.text}
        </div>
      )}
    </fieldset>
  );
}
