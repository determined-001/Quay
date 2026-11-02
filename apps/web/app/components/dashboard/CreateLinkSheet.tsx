"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import type { PaymentLink } from "../../../lib/api";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon } from "./icons";
import { useFocusTrap } from "../useFocusTrap";

export interface NewLink {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
}

/**
 * A small dialog for making a payment link, so the dashboard does not carry a
 * form on every visit. Once the link exists it becomes the "here it is" screen:
 * the URL to share, a copy button, and a way to make another.
 */
export default function CreateLinkSheet({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  /** Resolves with the new link, or throws an Error whose message is shown as is. */
  onSubmit: (values: NewLink) => Promise<PaymentLink>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">("USDC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PaymentLink | null>(null);
  const [copied, setCopied] = useState(false);

  // Escape closes the sheet unless a request is in flight.
  useFocusTrap(ref, true, () => {
    if (!busy) onClose();
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !amount.trim()) {
      setError("Add a title and an amount.");
      return;
    }
    setBusy(true);
    try {
      setCreated(await onSubmit({ title: title.trim(), amount: amount.trim(), assetCode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the payment link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const url = created && typeof window !== "undefined" ? `${window.location.origin}/pay/${created.id}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The link stays visible and selectable if the browser refuses clipboard access.
    }
  }

  function another() {
    setCreated(null);
    setTitle("");
    setAmount("");
    setCopied(false);
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close" disabled={busy}>
          <CloseIcon />
        </button>

        {!created ? (
          <form onSubmit={submit} noValidate>
            <h2 id={headingId}>New payment link</h2>
            <p className="card__hint">Tell your customer what they are paying for. They pay from their own wallet and it lands in yours.</p>

            <div className="field">
              <label htmlFor="nl-title">What is this for</label>
              <input
                id="nl-title"
                data-autofocus
                placeholder="2 ceramic mugs, invoice 1024"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor="nl-amount">Amount</label>
                <input
                  id="nl-amount"
                  className="mono"
                  inputMode="decimal"
                  placeholder="25.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="nl-asset">Currency</label>
                <select id="nl-asset" value={assetCode} onChange={(e) => setAssetCode(e.target.value as "USDC" | "XLM")}>
                  <option value="USDC">USDC</option>
                  <option value="XLM">XLM</option>
                </select>
              </div>
            </div>

            {error && (
              <div className="err" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? "Creating…" : "Create link"}
            </button>
          </form>
        ) : (
          <div>
            <span className="sheet__done" aria-hidden>
              <CheckIcon />
            </span>
            <h2 id={headingId}>Your link is ready</h2>
            <p className="card__hint">Send this to your customer. You will see the payment on Home as soon as it arrives.</p>

            <div className="sharebox">
              <code>{url}</code>
              <button type="button" className="chip chip--solid" onClick={copy}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>

            <div className="sheet__actions">
              <Link href={`/pay/${created.id}`} className="btn" target="_blank" rel="noopener noreferrer">
                Preview checkout <ExternalIcon />
              </Link>
              <button type="button" className="btn btn--ghost" onClick={another}>
                Create another
              </button>
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
