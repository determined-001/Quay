import Link from "next/link";

export interface PublicErrorPanelProps {
  isUnreachable?: boolean;
  isEmbed?: boolean;
  refreshHref?: string;
  title?: string;
  message?: string;
}

export function PublicErrorPanel({
  isUnreachable = false,
  isEmbed = false,
  refreshHref,
  title,
  message,
}: PublicErrorPanelProps) {
  return (
    <main className={isEmbed ? "shell shell--embed" : "shell shell--narrow"}>
      <div className="panel checkout">
        {isUnreachable ? (
          <>
            <div className="error-icon" aria-hidden>
              ⚡
            </div>
            <p className="title">{title ?? "Unable to load this payment link"}</p>
            <p className="muted">
              {message ??
                "We can't reach the payment service right now. Please refresh the page or try again in a moment."}
            </p>
          </>
        ) : (
          <>
            <p className="title">{title ?? "Payment link not found"}</p>
            <p className="muted">
              {message ?? "This link may have been removed, or the id is wrong."}
            </p>
          </>
        )}
        <div style={{ marginTop: 20, display: "flex", gap: 12, justifyContent: "center" }}>
          {refreshHref && (
            <Link className="btn btn--ghost" href={refreshHref}>
              Refresh
            </Link>
          )}
          <Link className="btn btn--ghost" href="/">
            Go to Quay
          </Link>
        </div>
      </div>
    </main>
  );
}
