"use client";

import { useState } from "react";
import { PendingTransferModal } from "../../components/TransferStep";

export function TimelineClient({
  linkId,
  reference,
  linkStatus,
}: {
  linkId: string;
  reference: string;
  linkStatus?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);

  const receiptUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/r/${reference}`;

  async function copyLink() {
    await navigator.clipboard.writeText(receiptUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      {linkStatus === "offramp_pending" && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn--primary" onClick={() => setShowTransferModal(true)}>
            Send USDC to finish cash-out
          </button>
          {showTransferModal && (
            <PendingTransferModal
              linkId={linkId}
              onClose={() => {
                setShowTransferModal(false);
                if (typeof window !== "undefined") window.location.reload();
              }}
            />
          )}
        </div>
      )}
      <div className="tl-receipt-row">
        <code className="mono tl-receipt-url">{receiptUrl}</code>
        <button className="btn" onClick={copyLink}>
          {copied ? "Copied!" : "Copy receipt link"}
        </button>
      </div>
    </div>
  );
}

export function PendingTransferAction({ linkId }: { linkId: string }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button className="btn btn--primary" onClick={() => setShowModal(true)}>
        Send USDC to finish cash-out
      </button>
      {showModal && (
        <PendingTransferModal
          linkId={linkId}
          onClose={() => {
            setShowModal(false);
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      )}
    </>
  );
}
