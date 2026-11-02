"use client";

import type { UsdcTrustlineStatus } from "../../../lib/api";

export interface ReconnectBanner {
  show: boolean;
  isExpired: boolean;
  anchorName: string;
  affectedCount: number;
}

/**
 * Things the seller has to act on before money can move: a wallet that cannot
 * hold USDC, or an anchor session that expired under a cash-out in flight. They
 * sit at the top of every page that shows money, in plain words.
 */
export default function Alerts({
  trustline,
  reconnect,
  reconnectError,
  reconnecting,
  onReconnect,
}: {
  trustline: UsdcTrustlineStatus | null;
  reconnect: ReconnectBanner;
  reconnectError: string | null;
  reconnecting: boolean;
  onReconnect: () => void;
}) {
  const trustlineBad = trustline && !trustline.ok;
  if (!trustlineBad && !reconnect.show) return null;

  return (
    <div className="alerts">
      {trustlineBad && (
        <div className="banner banner--warn" role="status">
          <strong>Your wallet can&apos;t receive USDC right now.</strong> {trustline.message}
          {trustline.trustlineUri && (
            <>
              {" "}
              <a className="linkbtn" href={trustline.trustlineUri}>
                Add USDC trustline
              </a>
            </>
          )}
        </div>
      )}

      {reconnect.show && (
        <div className="banner banner--warn banner--row" role="status">
          <div>
            <strong>
              {reconnect.isExpired
                ? `Your session with ${reconnect.anchorName} expired.`
                : `Your session with ${reconnect.anchorName} expires soon.`}
            </strong>{" "}
            {reconnect.isExpired
              ? `Reconnect to keep tracking ${reconnect.affectedCount} cash-out${reconnect.affectedCount > 1 ? "s" : ""}.`
              : `Renew to keep tracking ${reconnect.affectedCount} cash-out${reconnect.affectedCount > 1 ? "s" : ""}.`}
            {reconnectError && <div className="err">{reconnectError}</div>}
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={onReconnect} disabled={reconnecting}>
            {reconnecting
              ? "Waiting for wallet…"
              : reconnect.isExpired
                ? `Reconnect to ${reconnect.anchorName}`
                : "Renew now"}
          </button>
        </div>
      )}
    </div>
  );
}
