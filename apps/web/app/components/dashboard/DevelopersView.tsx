"use client";

import { useState } from "react";
import { api } from "../../../lib/api";
import ApiKeys from "../ApiKeys";
import ExportPanel from "../ExportPanel";
import WebhooksPanel from "../WebhooksPanel";

type DevTab = "api-keys" | "webhooks" | "exports";

const TABS: { id: DevTab; label: string }[] = [
  { id: "api-keys", label: "API keys" },
  { id: "webhooks", label: "Webhooks" },
  { id: "exports", label: "Exports" },
];

/**
 * The tools for wiring Quay into your own site and books. They live here, not on
 * the page a business owner opens every day.
 *
 * Panels are mounted the first time their tab opens and then kept (only hidden),
 * because an API key is shown exactly once on creation: unmounting the panel
 * when someone glances at another tab would throw the key away.
 */
export default function DevelopersView() {
  const [tab, setTab] = useState<DevTab>("api-keys");
  const [opened, setOpened] = useState<Record<DevTab, boolean>>({
    "api-keys": true,
    webhooks: false,
    exports: false,
  });

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  function open(next: DevTab) {
    setTab(next);
    setOpened((o) => (o[next] ? o : { ...o, [next]: true }));
  }

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await api.exportCsv(from || undefined, to || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quay-links-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Developers</h1>
          <p className="page-head__sub">Connect Quay to your own site, server and accounting.</p>
        </div>
      </header>

      <div className="subtabs" role="tablist" aria-label="Developer tools">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`devtab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`devpanel-${t.id}`}
            className="subtab"
            onClick={() => open(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {opened["api-keys"] && (
        <div id="devpanel-api-keys" role="tabpanel" aria-labelledby="devtab-api-keys" hidden={tab !== "api-keys"}>
          <ApiKeys />
        </div>
      )}

      {opened.webhooks && (
        <div id="devpanel-webhooks" role="tabpanel" aria-labelledby="devtab-webhooks" hidden={tab !== "webhooks"}>
          <WebhooksPanel />
        </div>
      )}

      {opened.exports && (
        <div id="devpanel-exports" role="tabpanel" aria-labelledby="devtab-exports" hidden={tab !== "exports"}>
          <section className="panel">
            <h2>Export your payment links</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Download your links as a CSV for your accounting. Add dates to narrow it down.
            </p>
            <div className="csv-export-row">
              <div className="field csv-field">
                <label htmlFor="csv-from">From</label>
                <input id="csv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="field csv-field">
                <label htmlFor="csv-to">To</label>
                <input id="csv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <button type="button" className="btn" onClick={exportCsv} disabled={exporting}>
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            </div>
            {exportError && <div className="err">{exportError}</div>}
          </section>
          <ExportPanel />
        </div>
      )}
    </>
  );
}
