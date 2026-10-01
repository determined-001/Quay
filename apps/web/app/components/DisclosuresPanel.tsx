"use client";

import { SEP9_NATURAL_PERSON_FIELDS, SEP9_ORGANIZATION_FIELDS } from "@checkout/core";
import type { KycDisclosure } from "../../lib/api";

const labels = new Map(
  [...SEP9_NATURAL_PERSON_FIELDS, ...SEP9_ORGANIZATION_FIELDS]
    .flatMap((field): Array<readonly [string, string]> => [
      [field.name, field.label],
      ...(field.aliases ?? []).map((alias): readonly [string, string] => [alias, field.label]),
    ]),
);

function fieldLabel(name: string): string {
  return labels.get(name) ?? name.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sentDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(timestamp));
}

/** The view takes disclosure metadata only; saved KYC field values never enter it. */
export default function DisclosuresPanel({
  disclosures,
  loading = false,
  error = null,
  onRetry,
  onRevoke,
  onAskDelete,
  deletableAnchorDomain,
}: {
  disclosures: KycDisclosure[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onRevoke?: (anchorDomain: string) => void;
  onAskDelete?: (anchorDomain: string) => void;
  deletableAnchorDomain?: string | null;
}) {
  return (
    <section className="panel" aria-label="Identity disclosures">
      <h2>Identity disclosures</h2>
      {loading && <p className="muted">Loading disclosure history…</p>}
      {error && (
        <div className="error-banner" role="alert">
          <p className="error-banner__text">{error}</p>
          {onRetry && <button className="btn btn--ghost" onClick={onRetry}>Retry</button>}
        </div>
      )}
      {!loading && disclosures.length === 0 && !error && (
        <p className="muted">No identity disclosures recorded yet. Earlier sends may not appear here.</p>
      )}
      {disclosures.map((disclosure) => (
        <article key={disclosure.anchorDomain} style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 14 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>{disclosure.anchorDomain}</h3>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            Overall status: {disclosure.status} · Consent: {disclosure.consent?.revokedAt ? "revoked" : disclosure.consent ? "granted" : "not recorded"}
          </p>
          <ul style={{ margin: "0 0 14px", paddingLeft: 20 }}>
            {disclosure.fields.map((field) => (
              <li key={field.name} style={{ marginBottom: 8 }}>
                <strong>{fieldLabel(field.name)}</strong> · sent {sentDate(field.sentAt)} · {field.anchorStatus.toLowerCase()}
                {field.error && <span> — {field.error}</span>}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn--ghost" disabled={!onRevoke || !!disclosure.consent?.revokedAt}
              onClick={() => onRevoke?.(disclosure.anchorDomain)}>Revoke consent</button>
            <button className="btn btn--ghost" disabled={!onAskDelete || disclosure.anchorDomain !== deletableAnchorDomain}
              onClick={() => onAskDelete?.(disclosure.anchorDomain)}>Ask anchor to delete</button>
          </div>
        </article>
      ))}
    </section>
  );
}
