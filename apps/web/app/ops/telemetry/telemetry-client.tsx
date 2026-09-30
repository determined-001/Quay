'use client';

import { useCallback, useState } from 'react';
import {
  CheckoutError,
  getTelemetryRows,
  getTelemetrySummary,
  type TelemetryRow,
  type TelemetrySummaryRow,
} from '../../../lib/api';

/**
 * Corridor quality, per (anchor, corridor) — the evidence an anchor
 * partnership conversation needs (issue 5.21). The TELEMETRY_TOKEN is typed
 * in, held in component state ONLY, and attached per request; it is never
 * written to localStorage/sessionStorage — a persistent JS-readable store is
 * exactly what a token must not live in, same rule as the seller session.
 * A page refresh forgets it, which is the correct trade.
 */

const ROWS_LIMIT = 20;

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(2)}%`;
}

function ms(v: number | null): string {
  if (v === null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

function ts(v: number | null): string {
  return v === null ? '—' : new Date(v).toISOString().replace('T', ' ').slice(0, 19);
}

export default function TelemetryClient() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TelemetrySummaryRow[] | null>(null);
  const [rows, setRows] = useState<TelemetryRow[]>([]);
  const [corridor, setCorridor] = useState<string>('');

  const load = useCallback(
    async (corridorFilter: string) => {
      setLoading(true);
      setError(null);
      try {
        const [s, r] = await Promise.all([
          getTelemetrySummary(token),
          getTelemetryRows(token, {
            limit: ROWS_LIMIT,
            ...(corridorFilter ? { corridor: corridorFilter } : {}),
          }),
        ]);
        setSummary(s.summary);
        setRows(r.rows);
      } catch (e) {
        setSummary(null);
        setRows([]);
        setError(
          e instanceof CheckoutError
            ? e.message
            : 'Could not reach the telemetry endpoint. Is the API up?',
        );
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  return (
    <main className="shell shell--narrow" style={{ paddingTop: 40, paddingBottom: 60 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Corridor telemetry</h1>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        Operator view of <span className="mono">offramp_telemetry</span> — anonymised: no seller,
        link, or job identifiers. The token stays in this page&apos;s memory only.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token) void load(corridor);
        }}
        className="panel"
        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 14, marginBottom: 20 }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="TELEMETRY_TOKEN"
          autoComplete="off"
          className="mono"
          style={{ flex: 1, padding: '8px 10px' }}
          aria-label="Telemetry token"
        />
        <button type="submit" className="btn btn--primary" disabled={!token || loading}>
          {loading ? 'Loading…' : summary ? 'Refresh' : 'Load'}
        </button>
      </form>

      {error && (
        <div className="err" role="alert" style={{ marginBottom: 20 }}>
          {error}
        </div>
      )}

      {summary && (
        <>
          <div className="panel" style={{ padding: 14, marginBottom: 20, overflowX: 'auto' }}>
            <h2 style={{ fontSize: 14, marginBottom: 10 }}>Per anchor × corridor</h2>
            {summary.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No telemetry rows yet — cash something out first.
              </p>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="muted" style={{ textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Anchor</th>
                    <th style={{ padding: '4px 8px' }}>Corridor</th>
                    <th style={{ padding: '4px 8px' }}>Count</th>
                    <th style={{ padding: '4px 8px' }}>Settled / failed</th>
                    <th style={{ padding: '4px 8px' }}>p50 latency</th>
                    <th style={{ padding: '4px 8px' }}>p95 latency</th>
                    <th style={{ padding: '4px 8px' }}>Mean spread</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => (
                    <tr
                      key={`${s.anchorDomain}-${s.corridor}`}
                      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => {
                        setCorridor(s.corridor);
                        void load(s.corridor);
                      }}
                      title="Show this corridor's recent rows"
                    >
                      <td className="mono" style={{ padding: '6px 8px' }}>{s.anchorDomain}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{s.corridor}</td>
                      <td style={{ padding: '6px 8px' }}>{s.count}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {s.settledCount} / {s.failedCount}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{ms(s.latencyP50Ms)}</td>
                      <td style={{ padding: '6px 8px' }}>{ms(s.latencyP95Ms)}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{pct(s.meanSpread)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel" style={{ padding: 14, overflowX: 'auto' }}>
            <h2 style={{ fontSize: 14, marginBottom: 2 }}>
              Recent rows{corridor ? <span className="mono"> · {corridor}</span> : null}
            </h2>
            <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              Last {ROWS_LIMIT}, newest first — quoted vs effective rate, both in target units per
              1 source unit.
              {corridor && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ marginLeft: 10, fontSize: 11, padding: '2px 8px' }}
                  onClick={() => {
                    setCorridor('');
                    void load('');
                  }}
                >
                  Clear filter
                </button>
              )}
            </p>
            {rows.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No rows for this filter.
              </p>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="muted" style={{ textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Quoted at</th>
                    <th style={{ padding: '4px 8px' }}>Corridor</th>
                    <th style={{ padding: '4px 8px' }}>Amount</th>
                    <th style={{ padding: '4px 8px' }}>Quoted rate</th>
                    <th style={{ padding: '4px 8px' }}>Effective rate</th>
                    <th style={{ padding: '4px 8px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.quotedAt}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="mono" style={{ padding: '6px 8px' }}>{ts(r.quotedAt)}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{r.corridor}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>
                        {r.sellAmount} {r.sellAsset}
                      </td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{r.quotedRate}</td>
                      <td className="mono" style={{ padding: '6px 8px' }}>{r.effectiveRate ?? '—'}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {r.status}
                        {r.failureReason ? (
                          <span className="muted"> — {r.failureReason}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </main>
  );
}
