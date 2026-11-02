"use client";

import type { ReactNode } from "react";
import type { PaymentLink } from "../../../lib/api";
import { CASHABLE_STATUSES } from "../../../lib/dashboard-metrics";
import { OFFRAMP_CURRENCY, OFFRAMP_ENABLED, OFFRAMP_IS_MOCK } from "./config";
import { PaymentRow, type RowActions } from "./PaymentsView";

interface Props extends RowActions {
  links: PaymentLink[];
  loading: boolean;
  alerts: ReactNode;
  /** Identity and consent panels, only passed when a real anchor needs them. */
  verification: ReactNode;
}

function Group({
  title,
  hint,
  links,
  actions,
  empty,
}: {
  title: string;
  hint?: string;
  links: PaymentLink[];
  actions: RowActions;
  empty: string;
}) {
  return (
    <section className="card card--flush" aria-label={title}>
      <div className="card__head card__head--pad">
        <div>
          <h2>{title}</h2>
          {hint && <p className="card__hint">{hint}</p>}
        </div>
        <span className="filter__n">{links.length}</span>
      </div>
      {links.length === 0 ? (
        <p className="group-empty">{empty}</p>
      ) : (
        <ul className="plist">
          {links.map((l) => (
            <PaymentRow key={l.id} link={l} actions={actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function CashOutView({ links, loading, alerts, verification, ...actions }: Props) {
  if (!OFFRAMP_ENABLED) {
    return (
      <>
        <header className="page-head">
          <div>
            <h1>Cash out</h1>
          </div>
        </header>
        <section className="card hero-empty">
          <h2>Cash-out isn&apos;t switched on here</h2>
          <p>
            This deployment takes payments and stops there. Your money arrives straight in your own wallet, and you can
            move it with that wallet whenever you like.
          </p>
        </section>
      </>
    );
  }

  const ready = links.filter((l) => CASHABLE_STATUSES.has(l.status));
  const inProgress = links.filter((l) => l.status === "offramp_pending");
  const done = links.filter((l) => l.status === "offramp_settled").slice(0, 10);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Cash out</h1>
          <p className="page-head__sub">Turn the USDC you have been paid into {OFFRAMP_CURRENCY} through a Stellar anchor.</p>
        </div>
      </header>

      {OFFRAMP_IS_MOCK && (
        <div className="banner banner--warn" role="note">
          <strong>Simulated.</strong> No real money moves in this environment. Cash-outs here only rehearse the flow.
        </div>
      )}

      {alerts}

      {verification}

      <Group
        title="Ready to cash out"
        hint="Paid links you have not cashed out yet."
        links={ready}
        actions={actions}
        empty={loading ? "Loading…" : "Nothing is ready. Once a link is paid it shows up here."}
      />
      {inProgress.length > 0 && (
        <Group title="In progress" links={inProgress} actions={actions} empty="" />
      )}
      {done.length > 0 && <Group title="Cashed out" links={done} actions={actions} empty="" />}
    </>
  );
}
