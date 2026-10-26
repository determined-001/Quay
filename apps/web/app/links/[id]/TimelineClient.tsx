"use client";

import { useState, useEffect } from "react";
import { PendingTransferModal } from "../../components/TransferStep";

export function TimelineClient({
  linkId,
  reference,
}: {
  linkId: string;
  reference: string;
}) {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  const receiptUrl = origin ? `${origin}/r/${reference}` : `/r/${reference}`;

  async function copyLink() {
    const fullUrl = origin
      ? `${origin}/r/${reference}`
      : typeof window !== "undefined"
        ? `${window.location.origin}/r/${reference}`
        : `/r/${reference}`;
    await navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="tl-receipt-row">
      <code className="mono tl-receipt-url">{receiptUrl}</code>
      <button className="btn" onClick={copyLink}>
        {copied ? "Copied!" : "Copy receipt link"}
      </button>
    </div>
  );
}

/**
 * Resume an unsent withdrawal transfer from the link page. Signing happens in
 * the browser, so this must be a client component. The instructions are read
 * from the anchor only when the seller clicks.
 */
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
