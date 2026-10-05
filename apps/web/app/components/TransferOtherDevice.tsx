"use client";

/**
 * "Pay from another device" for the cash-out transfer step: a SEP-7 `pay`
 * request (link + QR) for sellers whose funds are in a mobile wallet, plus a
 * plain "Copy details" block for wallets without SEP-7.
 *
 * Nothing is signed or submitted here. Success is only reported once Horizon
 * shows a payment matching the anchor's instructions.
 */

import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { WithdrawTransfer } from "@checkout/core";
import { buildTransferUri, transferDetails, transferDetailsText } from "../../lib/transfer-uri";
import { findAnchorTransfer, NETWORK_PASSPHRASE, shortAddress } from "../../lib/wallet";

interface Props {
  transfer: WithdrawTransfer;
  /** The seller's registered wallet: the anchor customer, and the only account whose payment counts. */
  wallet: string | null;
  onSent: (hash: string) => void;
}

export function TransferOtherDevice({ transfer, wallet, onSent }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const built = useMemo(() => {
    try {
      return { uri: buildTransferUri(transfer, NETWORK_PASSPHRASE), details: transferDetails(transfer), error: null };
    } catch (e: unknown) {
      return { uri: null, details: [], error: e instanceof Error ? e.message : "Could not build the payment request." };
    }
  }, [transfer]);

  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(transferDetailsText(transfer));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function checkSent() {
    if (!wallet) return;
    setChecking(true);
    setNotFound(false);
    setCheckError(null);
    try {
      const hash = await findAnchorTransfer(wallet, transfer);
      if (hash) onSent(hash);
      else setNotFound(true);
    } catch {
      setCheckError("Could not check the network right now. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        className="btn btn--block"
        aria-expanded={open}
        aria-controls="transfer-other-device"
        onClick={() => setOpen((v) => !v)}
      >
        Pay from another device
      </button>

      {open && (
        <div id="transfer-other-device" style={{ marginTop: 12 }}>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            The payment must come from your registered wallet
            {wallet ? (
              <>
                {" "}
                (<span className="mono" title={wallet}>{shortAddress(wallet)}</span>)
              </>
            ) : null}
            , the account the anchor knows you by. Include the memo exactly; without it the anchor
            cannot match the payment to your withdrawal.
          </p>

          {built.error ? (
            <div className="err" role="alert">
              {built.error}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "center", margin: "12px 0" }}>
                <QRCodeSVG value={built.uri as string} size={180} fgColor="#0b0f14" bgColor="#ffffff" level="M" />
              </div>
              <a className="btn btn--block" href={built.uri as string}>
                Open in a wallet app
              </a>
            </>
          )}

          <details style={{ marginTop: 12 }} open={Boolean(built.error)}>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>Copy details</summary>
            {built.error ? (
              <p className="muted" style={{ fontSize: 12 }}>
                The memo could not be shown safely, so no copyable payment details are offered.
              </p>
            ) : (
              <>
                <dl className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
                  {built.details.map((d) => (
                    <div key={d.label}>
                      <dt>{d.label}</dt>
                      <dd className="mono" style={{ wordBreak: "break-all" }}>
                        {d.value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <button type="button" className="btn btn--block" onClick={() => void copyDetails()}>
                  {copied ? "Copied" : "Copy details"}
                </button>
              </>
            )}
          </details>

          {!built.error && (
            <>
              <button
                type="button"
                className="btn btn--primary btn--block"
                style={{ marginTop: 12 }}
                onClick={() => void checkSent()}
                disabled={checking || !wallet}
              >
                {checking ? "Checking…" : "I have sent it"}
              </button>
              {notFound && (
                <p className="muted" role="status" style={{ fontSize: 12 }}>
                  We do not see that payment on the network yet. Finish it in your wallet, then check again.
                </p>
              )}
              {checkError && (
                <div className="err" role="alert" style={{ marginTop: 8 }}>
                  {checkError}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
