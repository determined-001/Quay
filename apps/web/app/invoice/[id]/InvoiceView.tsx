import Link from "next/link";
import type { LinkWithRequest, PublicInvoice } from "../../../lib/api";
import CheckoutClient from "../../components/CheckoutClient";
import Logo from "../../components/Logo";
import ThemeToggle from "../../components/ThemeToggle";
import { InvoiceActions } from "./InvoiceActions";

export function formatInvoiceDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  const timestamp = ms < 1e11 ? ms * 1000 : ms;
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function lineItemTotal(qty: number, unitPrice: string): string {
  try {
    const [whole, frac = ""] = unitPrice.split(".");
    const fracPadded = (frac + "0000000").slice(0, 7);
    const stroops = BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded);
    const totalStroops = BigInt(qty) * stroops;
    const wholePart = totalStroops / 10_000_000n;
    const fracPart = totalStroops % 10_000_000n;
    if (fracPart === 0n) return wholePart.toString();
    const fracStr = fracPart.toString().padStart(7, "0").replace(/0+$/, "");
    return `${wholePart}.${fracStr}`;
  } catch {
    return unitPrice;
  }
}

export interface InvoiceViewProps {
  invoice: PublicInvoice;
  linkData: LinkWithRequest | null;
  isTestnet?: boolean;
}

export function InvoiceView({ invoice, linkData, isTestnet = false }: InvoiceViewProps) {
  const seller = invoice.sellerName ?? invoice.sellerDisplayName ?? invoice.seller ?? "Seller";
  const status = invoice.status;
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  const assetCode =
    typeof invoice.asset === "string"
      ? invoice.asset
      : (invoice.asset?.code ?? invoice.assetCode ?? "USDC");
  const reference = invoice.reference ?? linkData?.link.reference;

  return (
    <main className="shell shell--invoice">
      <header className="masthead">
        <Logo />
        <span className="masthead__right">
          <span className="net mono">{assetCode}</span>
          <ThemeToggle />
        </span>
      </header>

      {isTestnet && (
        <div className="banner banner--warn invoice-testnet-note" style={{ marginBottom: 20 }}>
          <strong>Testnet — no real money.</strong>
        </div>
      )}

      <section className="panel invoice">
        <div className="invoice-header">
          <div>
            <span className="invoice-party-label">Invoice</span>
            <h1 className="invoice-number mono">{invoice.number}</h1>
          </div>
          <span className={`pill pill--${status}`}>{statusLabel}</span>
        </div>

        <div className="invoice-parties">
          <div className="invoice-party">
            <div className="invoice-party-label">From</div>
            <div className="invoice-party-name">{seller}</div>
          </div>
          <div className="invoice-party">
            <div className="invoice-party-label">Bill to</div>
            <div className="invoice-party-name">{invoice.clientName}</div>
          </div>
        </div>

        <div className="invoice-dates">
          <div className="invoice-date">
            <span style={{ color: "var(--muted)", marginRight: 6 }}>Issued:</span>
            <span>{formatInvoiceDate(invoice.issuedAt ?? invoice.createdAt)}</span>
          </div>
          <div className="invoice-date">
            <span style={{ color: "var(--muted)", marginRight: 6 }}>Due:</span>
            <span>{formatInvoiceDate(invoice.dueAt)}</span>
          </div>
        </div>

        <table className="invoice-table">
          <thead>
            <tr>
              <th>Description</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Unit price</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((item, idx) => (
              <tr key={idx}>
                <td>{item.description}</td>
                <td style={{ textAlign: "right" }} className="mono">
                  {item.quantity}
                </td>
                <td style={{ textAlign: "right" }} className="mono">
                  {item.unitPrice} {assetCode}
                </td>
                <td style={{ textAlign: "right" }} className="mono">
                  {lineItemTotal(item.quantity, item.unitPrice)} {assetCode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="invoice-total-row">
          <span>Total</span>
          <span className="mono">
            {invoice.total} {assetCode}
          </span>
        </div>

        {invoice.notes && (
          <div className="invoice-notes">
            <div className="invoice-notes-label">Notes</div>
            <p className="muted" style={{ margin: 0 }}>
              {invoice.notes}
            </p>
          </div>
        )}
      </section>

      {/* Pay / Status Section */}
      {(status === "open" || status === "overdue") && linkData && (
        <section className="panel invoice-pay">
          <CheckoutClient initial={linkData} />
        </section>
      )}

      {status === "paid" && (
        <section className="panel invoice-paid-panel" style={{ marginTop: 24, textAlign: "center" }}>
          <p className="title" style={{ color: "var(--accent)", marginBottom: 8 }}>
            Paid
          </p>
          <p className="muted" style={{ margin: 0 }}>
            This invoice has been paid.
          </p>
          {reference && (
            <div style={{ marginTop: 16 }}>
              <Link className="btn btn--primary" href={`/r/${reference}`}>
                View receipt
              </Link>
            </div>
          )}
        </section>
      )}

      {status === "void" && (
        <section className="panel invoice-void-panel" style={{ marginTop: 24, textAlign: "center" }}>
          <p className="title" style={{ marginBottom: 8 }}>
            This invoice was cancelled
          </p>
          <p className="muted" style={{ margin: 0 }}>
            The seller cancelled this invoice. No payment can be made.
          </p>
        </section>
      )}

      <InvoiceActions />

      <footer className="invoice-footer" style={{ textAlign: "center", marginTop: 32 }}>
        <p className="muted" style={{ fontSize: 12 }}>
          Powered by Quay — Non-custodial stablecoin checkout on Stellar
        </p>
      </footer>
    </main>
  );
}
