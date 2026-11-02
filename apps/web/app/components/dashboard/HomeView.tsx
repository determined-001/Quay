"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type KycView, type PaymentLink, type UsdcTrustlineStatus } from "../../../lib/api";
import {
  awaitingPayment,
  dailySeries,
  formatDollars,
  formatFiat,
  formatLinkAmount,
  humanStatus,
  RANGE_LABEL,
  rangeStart,
  readyToCashOut,
  relativeTime,
  setupSteps,
  totalReceived,
  CASHABLE_STATUSES,
  PAID_STATUSES,
  type PaymentFilter,
  type RangeKey,
} from "../../../lib/dashboard-metrics";
import { OFFRAMP_CURRENCY, OFFRAMP_ENABLED, OFFRAMP_IS_MOCK } from "./config";
import { ArrowIcon, CheckIcon, PlusIcon } from "./icons";
import type { View } from "./Shell";

interface Props {
  links: PaymentLink[];
  loading: boolean;
  fetchError: string | null;
  onRetry: () => void;
  trustline: UsdcTrustlineStatus | null;
  kyc: KycView | null;
  now: number;
  alerts: ReactNode;
  onNavigate: (v: View) => void;
  onOpenPayments: (f: PaymentFilter) => void;
  onCreate: () => void;
}

const RANGES: RangeKey[] = ["7d", "30d", "all"];

/**
 * A rough naira (or other) figure for what is ready to cash out, from the same
 * indicative price the cash-out form shows. It is a market reference taken
 * before the anchor's fee, never a promise, and it disappears if the preview
 * cannot be fetched rather than guessing.
 */
function useIndicativeRate(links: PaymentLink[]): number | null {
  const sampleId = useMemo(
    () => links.find((l) => CASHABLE_STATUSES.has(l.status) && l.asset.code === "USDC")?.id ?? null,
    [links],
  );
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (!OFFRAMP_ENABLED || !sampleId) {
      setRate(null);
      return;
    }
    let cancelled = false;
    api
      .getOfframpPreview(sampleId, OFFRAMP_CURRENCY)
      .then((preview) => {
        if (cancelled) return;
        const price = Number(preview.prices.find((p) => p.targetCurrency === OFFRAMP_CURRENCY)?.price);
        setRate(Number.isFinite(price) && price > 0 ? price : null);
      })
      .catch(() => {
        if (!cancelled) setRate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sampleId]);

  return rate;
}

function RangePicker({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div className="seg" role="group" aria-label="Time range">
      {RANGES.map((r) => (
        <button key={r} type="button" className="seg__btn" aria-pressed={value === r} onClick={() => onChange(r)}>
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

function BarChart({ buckets, label }: { buckets: { key: string; start: number; total: number }[]; label: string }) {
  const max = Math.max(...buckets.map((b) => b.total), 0);
  const first = new Date(buckets[0]?.start ?? 0);
  const last = new Date(buckets[buckets.length - 1]?.start ?? 0);
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <div className="chart">
      <div className="chart__bars" role="img" aria-label={label}>
        {buckets.map((b, i) => {
          const pct = max > 0 ? Math.max((b.total / max) * 100, b.total > 0 ? 6 : 0) : 0;
          return (
            <div
              key={b.key}
              className="chart__col"
              title={`${new Date(b.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: ${formatDollars(b.total)}`}
            >
              <span
                className={i === buckets.length - 1 ? "chart__bar chart__bar--today" : "chart__bar"}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="chart__axis" aria-hidden>
        <span>{fmt(first)}</span>
        <span>Today</span>
        <span className="visually-hidden">{fmt(last)}</span>
      </div>
    </div>
  );
}

function Skeleton({ lines = 1, tall = false }: { lines?: number; tall?: boolean }) {
  return (
    <div className="skel" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={tall ? "skeleton skel__tall" : "skeleton skel__line"} />
      ))}
    </div>
  );
}

function SetupCard({ links, trustline, kyc, onCreate }: Pick<Props, "links" | "trustline" | "kyc" | "onCreate">) {
  const steps = setupSteps({
    links,
    canReceiveUsdc: trustline ? trustline.ok : null,
    ...(OFFRAMP_ENABLED && !OFFRAMP_IS_MOCK ? { verification: { accepted: kyc?.status === "ACCEPTED" } } : {}),
  });
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card setup" aria-labelledby="setup-h">
      <div className="setup__head">
        <h2 id="setup-h">Get set up</h2>
        <span className="setup__count">
          {done} of {steps.length} done
        </span>
      </div>
      <div className="setup__bar" aria-hidden>
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ul className="setup__list">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? "is-done" : undefined}>
            <span className="setup__tick" aria-hidden>
              {s.done ? <CheckIcon /> : null}
            </span>
            <span>{s.label}</span>
            <span className="visually-hidden">{s.done ? " (done)" : " (to do)"}</span>
            {s.id === "link" && !s.done && (
              <button type="button" className="linkbtn" onClick={onCreate}>
                Create one
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentList({ links, now, onOpenAll }: { links: PaymentLink[]; now: number; onOpenAll: () => void }) {
  const recent = [...links].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  return (
    <section className="card" aria-labelledby="recent-h">
      <div className="card__head">
        <h2 id="recent-h">Recent payments</h2>
        <button type="button" className="linkbtn" onClick={onOpenAll}>
          View all
        </button>
      </div>
      <ul className="rows">
        {recent.map((l) => {
          const st = humanStatus(l);
          return (
            <li key={l.id}>
              <Link href={`/links/${l.id}`} className="row-link">
                <span className={`dotmark dotmark--${st.tone}`} aria-hidden />
                <span className="row-link__main">
                  <span className="row-link__title">{l.title}</span>
                  <span className="row-link__sub">
                    {st.label} · {relativeTime(l.updatedAt, now)}
                  </span>
                </span>
                <span className="row-link__amt">{formatLinkAmount(l)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function HomeView(props: Props) {
  const { links, loading, fetchError, onRetry, trustline, kyc, now, alerts, onNavigate, onOpenPayments, onCreate } = props;
  const [range, setRange] = useState<RangeKey>("30d");
  const rate = useIndicativeRate(links);

  const since = rangeStart(range, now);
  const received = totalReceived(links, since);
  const paidInRange = links.filter(
    (l) => PAID_STATUSES.has(l.status) && l.asset.code === "USDC" && (since === undefined || l.updatedAt >= since),
  ).length;
  const days = range === "7d" ? 7 : 30;
  const series = useMemo(() => dailySeries(links, days, now), [links, days, now]);
  const ready = readyToCashOut(links);
  const waiting = awaitingPayment(links);
  const allTime = totalReceived(links);

  const hasLinks = links.length > 0;
  const firstLoad = loading && !hasLinks;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Home</h1>
          <p className="page-head__sub">How your business is doing.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          <PlusIcon /> Create payment link
        </button>
      </header>

      {alerts}

      {fetchError && (
        <div className="error-banner" role="alert">
          <p className="error-banner__text">{fetchError}</p>
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {!firstLoad && !hasLinks && !fetchError && (
        <section className="card hero-empty">
          <h2>Take your first payment</h2>
          <p>
            Make a payment link, share it, and the money goes straight to your wallet. Quay never holds it. You will
            see every payment here as it arrives.
          </p>
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            <PlusIcon /> Create payment link
          </button>
        </section>
      )}

      {(hasLinks || firstLoad) && (
        <div className="grid">
          <section className="card card--hero" aria-labelledby="received-h">
            <div className="card__head">
              <h2 id="received-h">Received</h2>
              <RangePicker value={range} onChange={setRange} />
            </div>
            {firstLoad ? (
              <Skeleton lines={2} tall />
            ) : (
              <>
                <p className="figure">{formatDollars(received)}</p>
                <p className="figure__sub">
                  {paidInRange === 1 ? "1 payment" : `${paidInRange} payments`} · {RANGE_LABEL[range].toLowerCase()}
                </p>
                <BarChart
                  buckets={series}
                  label={`Received each day over the last ${days} days. ${formatDollars(received)} in the selected range.`}
                />
                <p className="fine">Days follow when each payment last changed.</p>
              </>
            )}
          </section>

          <div className="stack">
            <section className="card" aria-labelledby="ready-h">
              <h2 id="ready-h">{OFFRAMP_ENABLED ? "Ready to cash out" : "In your wallet"}</h2>
              {firstLoad ? (
                <Skeleton lines={1} tall />
              ) : OFFRAMP_ENABLED ? (
                <>
                  <p className="figure figure--md">{formatDollars(ready.amount)}</p>
                  <p className="figure__sub">
                    {rate && ready.amount > 0
                      ? `About ${formatFiat(ready.amount * rate, OFFRAMP_CURRENCY)}, indicative and before fees${OFFRAMP_IS_MOCK ? " (simulated rate)" : ""}`
                      : ready.count === 0
                        ? "Nothing waiting. Paid links appear here."
                        : `${ready.count} paid ${ready.count === 1 ? "link" : "links"}`}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onNavigate("cashout")}
                    disabled={ready.count === 0}
                  >
                    Cash out <ArrowIcon />
                  </button>
                </>
              ) : (
                <>
                  <p className="figure figure--md">{formatDollars(allTime)}</p>
                  <p className="figure__sub">
                    Paid straight to your own wallet, all time. Quay never holds your money.
                  </p>
                </>
              )}
            </section>

            <section className="card" aria-labelledby="wait-h">
              <h2 id="wait-h">Waiting for payment</h2>
              {firstLoad ? (
                <Skeleton lines={1} tall />
              ) : (
                <>
                  <p className="figure figure--md">{waiting.count}</p>
                  <p className="figure__sub">
                    {waiting.count === 0
                      ? "No open links."
                      : `${formatDollars(waiting.amount)} still to come in`}
                  </p>
                  {waiting.count > 0 && (
                    <button type="button" className="btn" onClick={() => onOpenPayments("waiting")}>
                      See open links
                    </button>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      )}

      {!firstLoad && hasLinks && <SetupCard links={links} trustline={trustline} kyc={kyc} onCreate={onCreate} />}

      {hasLinks && <RecentList links={links} now={now} onOpenAll={() => onOpenPayments("all")} />}
    </>
  );
}
