"use client";

import { useCallback, useEffect, useState } from "react";
import type { WithdrawTransfer } from "@checkout/core";
import { api, CheckoutError, describeError } from "../../lib/api";
import { useSellerWallet } from "./SessionGate";
import { checkPaymentPreflight, type PaymentPreflightResult } from "../../lib/payment-preflight";
import { sendAnchorTransfer, shortAddress } from "../../lib/wallet";

export interface TransferStepProps {
  transfer: WithdrawTransfer;
  onSuccess?: (hash: string) => void;
  onClose?: () => void;
  initialSentHash?: string | null;
}

export default function TransferStep({
  transfer,
  onSuccess,
  onClose,
  initialSentHash = null,
}: TransferStepProps) {
  const wallet = useSellerWallet();
  const [sending, setSending] = useState(false);
  const [sentHash, setSentHash] = useState<string | null>(initialSentHash);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PaymentPreflightResult | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);

  const runPreflight = useCallback(async () => {
    if (!transfer || !wallet) return;
    setCheckingPreflight(true);
    setTransferError(null);
    try {
      const stellar = await import("@stellar/stellar-sdk");
      const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "public" ? "public" : "testnet";
      const horizonUrl =
        process.env.NEXT_PUBLIC_HORIZON_URL ??
        (network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");
      const server = new stellar.Horizon.Server(horizonUrl);
      let account: Awaited<ReturnType<typeof server.loadAccount>> | null = null;
      try {
        account = await server.loadAccount(wallet);
      } catch {
        account = null;
      }
      const result = checkPaymentPreflight(
        account,
        {
          code: transfer.asset.code,
          issuer: transfer.asset.issuer,
        },
        transfer.amount,
        {
          connectedAddress: wallet,
          expectedAddress: wallet,
          feeStroops: BigInt(stellar.BASE_FEE),
        },
      );
      setPreflight(result);
    } catch {
      setPreflight(null);
    } finally {
      setCheckingPreflight(false);
    }
  }, [transfer, wallet]);

  useEffect(() => {
    if (transfer && wallet && !sentHash) {
      void runPreflight();
    }
  }, [transfer, wallet, sentHash, runPreflight]);

  async function handleSendTransfer() {
    if (!transfer || !wallet || sentHash) return;
    setTransferError(null);
    setSending(true);
    try {
      const hash = await sendAnchorTransfer(wallet, transfer, wallet);
      setSentHash(hash);
      if (onSuccess) {
        onSuccess(hash);
      }
    } catch (e: unknown) {
      setTransferError(
        e instanceof Error && e.message ? `The payment was not sent: ${e.message}` : "The payment was not sent.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      {sentHash ? (
        <>
          <div className="kyc-note kyc-note--ok" style={{ marginBottom: 12 }}>
            Payment sent, waiting for the anchor to see it.
          </div>
          <p className="muted mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {sentHash}
          </p>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Do not send a second payment; the anchor will credit this withdrawal once confirmed on-chain.
          </p>
          {onClose && (
            <button className="btn btn--primary btn--block" onClick={onClose} style={{ marginTop: 12 }}>
              Done
            </button>
          )}
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            The anchor is ready. Send{" "}
            <strong>
              {transfer.amount} {transfer.asset.code}
            </strong>{" "}
            from your wallet to finish the cash-out.
          </p>
          <dl className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
            <dt>To</dt>
            <dd className="mono" title={transfer.destination}>
              {shortAddress(transfer.destination)}
            </dd>
            {transfer.memo !== null && (
              <>
                <dt>Memo ({transfer.memoType ?? "text"})</dt>
                <dd className="mono">{transfer.memo}</dd>
              </>
            )}
          </dl>
          <p className="muted" style={{ fontSize: 12 }}>
            Keep this open until the payment is sent. The memo is how the anchor matches it to
            your withdrawal.
          </p>

          {checkingPreflight && (
            <p className="muted" style={{ fontSize: 12 }}>
              Checking wallet balance…
            </p>
          )}

          {preflight && !preflight.ok && (
            <div className="err" role="alert" style={{ marginBottom: 12 }}>
              {preflight.message}
            </div>
          )}

          {preflight && !preflight.ok && preflight.reason === "missing_trustline" ? (
            <button
              type="button"
              className="btn btn--block"
              onClick={() => void runPreflight()}
              disabled={checkingPreflight}
            >
              {checkingPreflight ? "Checking…" : "Check again"}
            </button>
          ) : (
            <>
              <button
                className="btn btn--primary btn--block"
                onClick={() => void handleSendTransfer()}
                disabled={sending || !wallet || checkingPreflight || (preflight !== null && !preflight.ok)}
                aria-disabled={preflight !== null && !preflight.ok}
              >
                {sending ? "Waiting for wallet…" : "Send with my wallet"}
              </button>
              {preflight && !preflight.ok && (
                <button
                  type="button"
                  className="btn btn--block"
                  style={{ marginTop: 8 }}
                  onClick={() => void runPreflight()}
                  disabled={checkingPreflight}
                >
                  {checkingPreflight ? "Checking…" : "Check again"}
                </button>
              )}
            </>
          )}
          {transferError && <div className="err" style={{ marginTop: 12 }}>{transferError}</div>}
          {onClose && (
            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={onClose}
              disabled={sending}
            >
              Close
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function PendingTransferModal({
  linkId,
  onClose,
}: {
  linkId: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<WithdrawTransfer | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPendingTransfer(linkId)
      .then((res) => {
        if (cancelled) return;
        setTransfer(res.transfer);
        if (!res.transfer) {
          setError("No pending transfer instructions found from the anchor.");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof CheckoutError
            ? describeError(e)
            : e instanceof Error
              ? e.message
              : "Failed to load transfer instructions",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send withdrawal payment"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        background: "rgba(11,15,20,0.82)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--surface-1, #121820)",
          border: "1px solid var(--border, rgba(255,255,255,0.08))",
          borderRadius: 12,
          padding: 24,
          boxShadow: "0 24px 48px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Finish Cash-Out Transfer</h2>
          <button className="btn btn--ghost" onClick={onClose} style={{ padding: "4px 8px" }}>
            ✕
          </button>
        </div>

        {loading && <p className="muted">Loading transfer instructions from anchor…</p>}
        {error && (
          <div>
            <div className="err" style={{ marginBottom: 16 }}>
              {error}
            </div>
            <button className="btn btn--block" onClick={onClose}>
              Close
            </button>
          </div>
        )}
        {!loading && !error && transfer && (
          <TransferStep transfer={transfer} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
