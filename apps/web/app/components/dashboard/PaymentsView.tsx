"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { api, type AnchorAuthView, type PaymentLink } from "../../../lib/api";
import { shouldShowReconnectHint } from "../../../lib/anchor-session";
import {
  FILTER_LABEL,
  filterCounts,
  formatFiat,
  formatLinkAmount,
  humanStatus,
  matchesFilter,
  relativeTime,
  type PaymentFilter,
} from "../../../lib/dashboard-metrics";
import { CASH_OUT_LABEL, OFFRAMP_CURRENCY, OFFRAMP_ENABLED, OFFRAMP_IS_MOCK } from "./config";
import { CheckIcon, CopyIcon, PlusIcon } from "./icons";

export interface RowActions {
  copied: string | null;
  onCopy: (id: string) => void;
  onCashOut: (id: string) => void;
  onPendingTransfer: (id: string) => void;
  cashOutBlocked: boolean;
  anchorAuth: AnchorAuthView | null;
  now: number;
}

/**
 * "About ₦40,000" beside a paid link: the indicative price for the link's own
 * amount, fetched once and always labelled indicative. No firm quote is used up
 * by looking. The price from the API is per one unit of the paid asset.
 */
function IndicativeValue({ link }: { link: PaymentLink }) {
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getOfframpPreview(link.id, OFFRAMP_CURRENCY)
      .then((preview) => {
        if (cancelled) return;
        const price = Number(preview.prices.find((p) => p.targetCurrency === OFFRAMP_CURRENCY)?.price);
        const units = Number(link.paidAmount ?? link.amount);
        setValue(Number.isFinite(price) && Number.isFinite(units) ? price * units : null);
      })
      .catch(() => {
        // The preview is best effort. Say nothing rather than guess.
      });
    return () => {
      cancelled = true;
    };
  }, [link.id, link.paidAmount, link.amount]);

  if (value === null) return null;
  return (
    <span className="prow__fiat" title="Indicative market rate before the anchor's fee. No firm quote is used.">
      About {formatFiat(value, OFFRAMP_CURRENCY)}
      <span> · indicative{OFFRAMP_IS_MOCK ? ", simulated" : ""}</span>
    </span>
  );
}

export function StatusBadge({ link, reconnect }: { link: PaymentLink; reconnect?: boolean }) {
  if (reconnect) {
    return (
      <span
        className="badge badge--wait"
        title="Your session with the anchor expired. Reconnect to keep tracking this cash-out."
      >
        Reconnect to track
      </span>
    );
  }
  const st = humanStatus(link);
  return <span className={`badge badge--${st.tone}`}>{st.label}</span>;
}

export function PaymentRow({ link, actions }: { link: PaymentLink; actions: RowActions }) {
  const { copied, onCopy, onCashOut, onPendingTransfer, cashOutBlocked, anchorAuth, now } = actions;
  const reconnect = shouldShowReconnectHint(link, anchorAuth, {
    offrampEnabled: OFFRAMP_ENABLED,
    isMock: OFFRAMP_IS_MOCK,
  });
  const canCashOut = OFFRAMP_ENABLED && (link.status === "paid" || link.status === "offramp_failed");
  const resumable =
    OFFRAMP_ENABLED && !OFFRAMP_IS_MOCK && link.status === "offramp_pending" && link.offrampStatus === "awaiting_transfer";

  return (
    <li className="prow">
      <div className="prow__main">
        <Link href={`/links/${link.id}`} className="prow__title">
          {link.title}
        </Link>
        {link.isDemo && (
          <span className="badge badge--idle" title="Created by the demo seed script">
            Demo
          </span>
        )}
        <span className="prow__sub">{relativeTime(link.updatedAt, now)}</span>
      </div>

      <div className="prow__amount">
        <span className="prow__amt">{formatLinkAmount(link)}</span>
        {OFFRAMP_ENABLED && link.status === "paid" && <IndicativeValue link={link} />}
      </div>

      <div className="prow__status">
        <StatusBadge link={link} reconnect={reconnect} />
      </div>

      <div className="prow__actions">
        <button type="button" className="chip" onClick={() => onCopy(link.id)}>
          {copied === link.id ? <CheckIcon /> : <CopyIcon />}
          {copied === link.id ? "Copied" : "Copy link"}
        </button>
        {canCashOut &&
          (cashOutBlocked ? (
            <span className="prow__note" title="Complete identity verification first">
              Verify identity to cash out
            </span>
          ) : (
            <button type="button" className="chip chip--solid" onClick={() => onCashOut(link.id)}>
              {link.status === "offramp_failed" ? "Retry cash-out" : CASH_OUT_LABEL}
            </button>
          ))}
        {resumable && (
          <button type="button" className="chip chip--solid" onClick={() => onPendingTransfer(link.id)}>
            Send USDC to finish
          </button>
        )}
      </div>
    </li>
  );
}

interface Props extends RowActions {
  links: PaymentLink[];
  loading: boolean;
  fetchError: string | null;
  onRetry: () => void;
  filter: PaymentFilter;
  onFilter: (f: PaymentFilter) => void;
  alerts: ReactNode;
  onCreate: () => void;
}

const FILTERS: PaymentFilter[] = ["all", "waiting", "paid", "cashout", "closed"];

export default function PaymentsView(props: Props) {
  const { links, loading, fetchError, onRetry, filter, onFilter, alerts, onCreate, ...actions } = props;
  const counts = filterCounts(links);
  // Cash-out is irrelevant on a payments-only deployment, so its chip is too.
  const filters = OFFRAMP_ENABLED ? FILTERS : FILTERS.filter((f) => f !== "cashout");
  const shown = links.filter((l) => matchesFilter(l, filter));

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="page-head__sub">Every payment link you have made, and where it stands.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          <PlusIcon /> Create payment link
        </button>
      </header>

      {alerts}

      <div className="filters" role="group" aria-label="Filter payments">
        {filters.map((f) => (
          <button key={f} type="button" className="filter" aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {FILTER_LABEL[f]}
            <span className="filter__n">{counts[f]}</span>
          </button>
        ))}
      </div>

      <section className="card card--flush" aria-label="Payments">
        {loading && links.length === 0 && (
          <ul className="plist" aria-hidden>
            {[1, 2, 3].map((i) => (
              <li key={i} className="prow prow--skel">
                <span className="skeleton skeleton--w140" />
                <span className="skeleton skeleton--w80" />
                <span className="skeleton skeleton--w60" />
                <span className="skeleton skeleton--w90" />
              </li>
            ))}
          </ul>
        )}

        {fetchError && (
          <div className="error-banner" role="alert" style={{ margin: 16 }}>
            <p className="error-banner__text">{fetchError}</p>
            <button type="button" className="btn btn--ghost" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}

        {!loading && !fetchError && links.length === 0 && (
          <div className="empty empty--rich">
            <strong>No payment links yet</strong>
            <p>
              Create one: a title and an amount are enough. You get a checkout page, a QR code and a snippet for your
              own site.
            </p>
            <button type="button" className="btn btn--primary" onClick={onCreate}>
              <PlusIcon /> Create payment link
            </button>
          </div>
        )}

        {links.length > 0 && shown.length === 0 && (
          <div className="empty empty--rich">
            <strong>Nothing here</strong>
            <p>No payments match this filter.</p>
          </div>
        )}

        {shown.length > 0 && (
          <ul className="plist">
            {shown.map((l) => (
              <PaymentRow key={l.id} link={l} actions={actions} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
