"use client";

/**
 * RefundSheet — issue 5.44.
 *
 * The seller refunds one payment from their own wallet. The server prepares the
 * unsigned transaction (4.59), the wallet signs it here, and the server relays
 * it (4.60). Quay never holds a key.
 *
 * The sheet owns the safety rails the issue asks for:
 *  - full or partial amount, capped by what the payment has left;
 *  - the buyer's destination shown in full, with a required confirmation;
 *  - a required memo when the buyer's account is a SEP-29 deposit account;
 *  - a wallet that must be the link's destination (the seller's wallet);
 *  - plain-words handling of wallet rejection, expiry and Horizon refusal;
 *  - a pending state that waits for the ledger to confirm the refund.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { refundableAmount, validateRefundAmount, type AssetRef, type Refund } from "@checkout/core";
import {
  api,
  CheckoutError,
  describeError,
  type RefundPayment,
  type RefundPreflight,
} from "../../lib/api";
import { signTransaction } from "../../lib/wallet";
import { useSellerWallet } from "./SessionGate";
import { CheckIcon, CloseIcon, CopyIcon } from "./dashboard/icons";
import { useFocusTrap } from "./useFocusTrap";

const REFUND_POLL_MS = 3_000;

type Phase = "loading" | "form" | "submitting" | "pending" | "confirmed" | "failed";

export interface RefundSheetProps {
  linkId: string;
  /** The seller's wallet: the refund transaction's source and the link destination. */
  linkDestination: string;
  asset: AssetRef;
  /** Tests and the link detail page can supply the payments they already have. */
  payments?: RefundPayment[];
  refunds?: Refund[];
  /** Preselect a payment (`<txHash>:<operationId>`), e.g. from a row action. */
  initialPaymentKey?: string;
  /** Tests pass the wallet directly; the dashboard reads it from the session. */
  connectedWallet?: string | null;
  onClose: () => void;
  /** Called once the refund is confirmed on the ledger. */
  onSubmitted?: () => void;
}

function paymentKey(payment: Pick<RefundPayment, "txHash" | "operationId">): string {
  return `${payment.txHash}:${payment.operationId ?? ""}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function paymentLabel(payment: RefundPayment, asset: AssetRef): string {
  return `${payment.amount} ${asset.code} from ${shortAddress(payment.payer)}`;
}

function isMemoRequired(err: unknown): boolean {
  return (
    err instanceof CheckoutError &&
    err.code === "refund_destination_cannot_receive" &&
    err.details.reason === "memo_required"
  );
}

function preflightMessage(err: unknown): string {
  if (err instanceof CheckoutError) return describeError(err);
  return "Could not check the buyer's account. Try again.";
}

function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") return uuid.call(globalThis.crypto);
  return `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function RefundSheet({
  linkId,
  linkDestination,
  asset,
  payments: paymentsProp,
  refunds: refundsProp,
  initialPaymentKey,
  connectedWallet,
  onClose,
  onSubmitted,
}: RefundSheetProps) {
  const sessionWallet = useSellerWallet();
  const wallet = connectedWallet ?? sessionWallet;

  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [payments, setPayments] = useState<RefundPayment[]>(paymentsProp ?? []);
  const [refunds, setRefunds] = useState<Refund[]>(refundsProp ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paymentKeyValue, setPaymentKeyValue] = useState<string>(initialPaymentKey ?? "");
  const [mode, setMode] = useState<"full" | "part">("full");
  const [partAmount, setPartAmount] = useState("");
  const [confirmedDestination, setConfirmedDestination] = useState(false);
  const [memo, setMemo] = useState("");
  const [memoRequired, setMemoRequired] = useState(false);
  const [preflight, setPreflight] = useState<RefundPreflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [submittedRefundId, setSubmittedRefundId] = useState<string | null>(null);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);

  // The props are the initial data; a later parent render must not refetch.
  const initialPayments = useRef(paymentsProp);
  const initialRefunds = useRef(refundsProp);

  const onSubmittedRef = useRef(onSubmitted);
  onSubmittedRef.current = onSubmitted;

  const submitInFlight = phase === "submitting";
  useFocusTrap(dialogRef, true, () => {
    if (!submitInFlight) onClose();
  });

  // A step change can unmount the focused control. Park focus on the heading.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) headingRef.current?.focus();
  }, [phase]);

  // Load the payments and refunds the sheet needs, unless the caller supplied them.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const suppliedPayments = initialPayments.current;
        const suppliedRefunds = initialRefunds.current;
        const [paymentResult, refundResult] = await Promise.all([
          suppliedPayments
            ? Promise.resolve({ payments: suppliedPayments })
            : api.listRefundPayments(linkId),
          suppliedRefunds
            ? Promise.resolve({ refunds: suppliedRefunds })
            : api.listRefunds(linkId).then((result) => ({ refunds: result.refunds })),
        ]);
        if (cancelled) return;
        setPayments(paymentResult.payments.filter((payment) => payment.operationId !== null));
        setRefunds(refundResult.refunds);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof CheckoutError
            ? describeError(e)
            : "Could not load this link's payments. Close the sheet and try again.",
        );
      } finally {
        if (!cancelled) setPhase("form");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  const refundsFor = useCallback(
    (payment: RefundPayment) =>
      refunds.filter(
        (refund) =>
          refund.paymentTxHash === payment.txHash && refund.paymentOperationId === payment.operationId,
      ),
    [refunds],
  );

  const refundableFor = useCallback(
    (payment: RefundPayment) => refundableAmount(payment.amount, refundsFor(payment)),
    [refundsFor],
  );

  const selected = useMemo(
    () => payments.find((payment) => paymentKey(payment) === paymentKeyValue) ?? null,
    [payments, paymentKeyValue],
  );
  const refundable = selected ? refundableFor(selected) : "0";

  // Pick a payment once the list is known: the caller's choice, else the first
  // one that still has something to refund.
  useEffect(() => {
    if (paymentKeyValue || payments.length === 0) return;
    const wanted = initialPaymentKey
      ? payments.find((payment) => paymentKey(payment) === initialPaymentKey)
      : undefined;
    const first = wanted ?? payments.find((payment) => refundableFor(payment) !== "0") ?? payments[0];
    if (first) setPaymentKeyValue(paymentKey(first));
  }, [payments, paymentKeyValue, initialPaymentKey, refundableFor]);

  // Preflight the full refundable amount when the sheet opens and whenever the
  // chosen payment changes. A part amount is preflighted again on confirm.
  useEffect(() => {
    setMemoRequired(false);
    setPreflight(null);
    setPreflightError(null);
    if (!selected || refundable === "0") return;
    let cancelled = false;
    api
      .refundPreflight(linkId, paymentKey(selected), refundable)
      .then((result) => {
        if (cancelled) return;
        setPreflight(result);
        setMemoRequired(result.memoRequired);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isMemoRequired(e)) {
          // The account needs a memo; the seller can still complete the form.
          setMemoRequired(true);
          setPreflightError(null);
          return;
        }
        setPreflightError(preflightMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [linkId, selected, refundable]);

  const destination = preflight?.destination ?? selected?.payer ?? "";
  const walletMatches = wallet !== null && wallet === linkDestination;
  const walletProblem = !wallet
    ? "Connect the seller's wallet to refund."
    : !walletMatches
      ? `The connected wallet must match the link destination. Connected ${shortAddress(wallet)}, but this link pays to ${shortAddress(linkDestination)}.`
      : null;

  const amountProblem = useMemo(() => {
    if (!selected) return "Choose a payment to refund.";
    if (refundable === "0") return "This payment has nothing left to refund.";
    if (mode === "full") return null;
    const value = partAmount.trim();
    if (!value) return "Enter the amount to refund.";
    const check = validateRefundAmount(value, refundable);
    if (check.ok) return null;
    switch (check.reason) {
      case "invalid_amount":
        return "Enter a valid amount, for example 4.50.";
      case "not_positive":
        return "Enter an amount greater than zero.";
      case "too_many_decimals":
        return "Use at most 7 decimal places.";
      case "exceeds_refundable":
        return `That is more than the ${refundable} ${asset.code} still refundable for this payment.`;
    }
  }, [selected, refundable, mode, partAmount, asset.code]);

  const memoProblem = memoRequired && !memo.trim() ? "Add the buyer's deposit memo." : null;
  const checkboxProblem = !confirmedDestination
    ? "Confirm that this is where the buyer wants the money back."
    : null;
  const canSubmit =
    phase === "form" &&
    !loadError &&
    Boolean(selected) &&
    !amountProblem &&
    !memoProblem &&
    !checkboxProblem &&
    !walletProblem;

  const chosenAmount = mode === "full" ? refundable : partAmount.trim();

  async function copyDestination() {
    if (!destination) return;
    try {
      await navigator.clipboard.writeText(destination);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // The address stays selectable when the browser refuses clipboard access.
    }
  }

  function startAgain() {
    setExpired(false);
    setError(null);
    setSubmittedRefundId(null);
    setSubmittedTxHash(null);
    setPhase("form");
  }

  function handleSubmitError(e: unknown) {
    setPhase("form");
    if (e instanceof CheckoutError) {
      if (e.code === "refund_expired") {
        setExpired(true);
        setError("That prepared refund expired before it was signed. Start again to prepare a new one.");
        return;
      }
      if (e.code === "payment_rejected") {
        const reason = typeof e.details.reason === "string" ? e.details.reason : null;
        const detail = typeof e.details.detail === "string" ? e.details.detail : null;
        setError(
          `Horizon rejected the refund${reason ? ` (${reason.replace(/_/g, " ")})` : ""}${
            detail ? `: ${detail}` : "."
          }`,
        );
        return;
      }
      setError(describeError(e));
      return;
    }
    setError(e instanceof Error ? e.message : "The refund could not be sent. Please try again.");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setExpired(false);
    // The full-amount check may have failed while this smaller amount can still
    // be received. The confirm path checks the amount being sent, so clear the
    // old message and let that check decide.
    setPreflightError(null);

    if (!selected) return setError("Choose a payment to refund.");
    if (amountProblem) return setError(amountProblem);
    if (checkboxProblem) return setError(checkboxProblem);
    if (memoProblem) return setError(memoProblem);
    if (walletProblem || !wallet) return setError(walletProblem ?? "Connect the seller's wallet to refund.");

    setPhase("submitting");
    try {
      // The preflight on open used the full amount. A partial refund is checked
      // against its own amount before anything is prepared.
      let requiresMemo = memoRequired;
      try {
        const result = await api.refundPreflight(linkId, paymentKey(selected), chosenAmount);
        setPreflight(result);
        setPreflightError(null);
        requiresMemo = result.memoRequired;
        setMemoRequired(result.memoRequired);
        if (result.memoRequired && !memo.trim()) {
          setPhase("form");
          setError("Add the buyer's deposit memo.");
          return;
        }
      } catch (preflightFailure) {
        if (isMemoRequired(preflightFailure)) {
          requiresMemo = true;
          setMemoRequired(true);
          if (!memo.trim()) {
            setPhase("form");
            setError("Add the buyer's deposit memo.");
            return;
          }
        } else {
          throw preflightFailure;
        }
      }

      const prepared = await api.prepareRefund(
        linkId,
        {
          payment: paymentKey(selected),
          amount: chosenAmount,
          ...(requiresMemo && memo.trim() ? { memo: memo.trim(), memoType: "text" as const } : {}),
        },
        newIdempotencyKey(),
      );

      let signed: string;
      try {
        signed = await signTransaction(prepared.xdr, wallet);
      } catch {
        setPhase("form");
        setError("The wallet request was cancelled. Nothing was sent.");
        return;
      }

      const { txHash } = await api.submitRefund(linkId, prepared.refundId, signed);
      setSubmittedRefundId(prepared.refundId);
      setSubmittedTxHash(txHash);
      setPhase("pending");
    } catch (failure) {
      handleSubmitError(failure);
    }
  }

  // Wait for the ledger to confirm (5.45). A failed poll keeps waiting: the
  // server-side poller still owns the transition, and a transient error is not
  // evidence the refund failed.
  useEffect(() => {
    if (phase !== "pending" || !submittedRefundId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const { refunds: rows } = await api.listRefunds(linkId);
        if (cancelled) return;
        const row = rows.find((refund) => refund.id === submittedRefundId);
        if (row?.status === "confirmed") {
          setPhase("confirmed");
          onSubmittedRef.current?.();
          return;
        }
        if (row?.status === "failed") {
          setPhase("failed");
          setError(
            `The refund failed on the network${row.failureReason ? `: ${row.failureReason.replace(/_/g, " ")}` : "."}`,
          );
          return;
        }
      } catch {
        // Try again on the next tick.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), REFUND_POLL_MS);
    }

    timer = setTimeout(() => void poll(), REFUND_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, submittedRefundId, linkId]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !submitInFlight && onClose()}>
      <div ref={dialogRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <button type="button" className="sheet__close" onClick={onClose} aria-label="Close" disabled={submitInFlight}>
          <CloseIcon />
        </button>

        <h2 id={headingId} ref={headingRef} tabIndex={-1} data-autofocus>
          {phase === "pending"
            ? "Refund sent, waiting for the network"
            : phase === "confirmed"
              ? "Refund confirmed"
              : "Refund this payment"}
        </h2>

        {phase === "loading" && <p className="card__hint">Loading this link&apos;s payments…</p>}

        {phase === "form" && (
          <form onSubmit={handleSubmit} noValidate>
            <p className="card__hint">
              The money goes back from your wallet to the buyer. You will sign one transaction; Quay never holds your
              key.
            </p>

            {loadError && (
              <div className="err" role="alert">
                {loadError}
              </div>
            )}

            {!loadError && payments.length === 0 && (
              <div className="err" role="alert">
                No recorded payments were found for this link, so there is nothing to refund yet.
              </div>
            )}

            {payments.length > 1 && (
              <div className="field">
                <label htmlFor="rf-payment">Which payment</label>
                <select
                  id="rf-payment"
                  value={paymentKeyValue}
                  onChange={(e) => {
                    setPaymentKeyValue(e.target.value);
                    setMode("full");
                    setPartAmount("");
                    setConfirmedDestination(false);
                  }}
                >
                  {payments.map((payment) => (
                    <option key={paymentKey(payment)} value={paymentKey(payment)}>
                      {paymentLabel(payment, asset)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selected && (
              <>
                <fieldset className="refund-choice">
                  <legend>Amount</legend>
                  <label>
                    <input
                      type="radio"
                      name="rf-mode"
                      value="full"
                      checked={mode === "full"}
                      onChange={() => setMode("full")}
                    />
                    Full — {refundable} {asset.code}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="rf-mode"
                      value="part"
                      checked={mode === "part"}
                      onChange={() => setMode("part")}
                    />
                    Part
                  </label>
                </fieldset>

                {mode === "part" && (
                  <div className="field">
                    <label htmlFor="rf-amount">Amount to refund</label>
                    <input
                      id="rf-amount"
                      className="mono"
                      inputMode="decimal"
                      placeholder={refundable}
                      value={partAmount}
                      onChange={(e) => setPartAmount(e.target.value)}
                      aria-invalid={Boolean(partAmount.trim() && amountProblem)}
                      aria-describedby={amountProblem ? "rf-amount-error" : undefined}
                      autoComplete="off"
                    />
                    <p className="card__hint">
                      Up to {refundable} {asset.code} is still refundable for this payment.
                    </p>
                    {partAmount.trim() && amountProblem && (
                      <p id="rf-amount-error" className="field__error" role="alert">
                        {amountProblem}
                      </p>
                    )}
                  </div>
                )}

                <div className="refund-dest">
                  <span className="refund-dest__label">Refund goes to</span>
                  <code>{destination || "Checking the buyer's account…"}</code>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => void copyDestination()}
                    aria-label="Copy destination address"
                    disabled={!destination}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>

                {preflightError && (
                  <div className="err" role="alert">
                    {preflightError}
                  </div>
                )}

                <label className="refund-check">
                  <input
                    type="checkbox"
                    checked={confirmedDestination}
                    onChange={(e) => setConfirmedDestination(e.target.checked)}
                  />
                  <span>I&apos;ve checked this is where the buyer wants the money back</span>
                </label>

                {memoRequired && (
                  <div className="field">
                    <label htmlFor="rf-memo">Buyer&apos;s deposit memo</label>
                    <input
                      id="rf-memo"
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      aria-required="true"
                      autoComplete="off"
                    />
                    <p className="card__hint refund-memo-hint">
                      This account needs a memo to credit the refund. Exchanges use it to find the right deposit —
                      ask the buyer for the memo shown on their deposit address.
                    </p>
                    {memo.trim() === "" && (
                      <p className="field__error" role="alert">
                        Add the buyer&apos;s deposit memo before sending.
                      </p>
                    )}
                  </div>
                )}

                {walletProblem && (
                  <div className="err" role="alert">
                    {walletProblem}
                  </div>
                )}

                {error && (
                  <div className="err" role="alert">
                    {error}
                    {expired && (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={startAgain} style={{ marginTop: 10 }}>
                        Start again
                      </button>
                    )}
                  </div>
                )}

                <div className="sheet__actions">
                  <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitInFlight}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
                    {`Refund ${chosenAmount || ""} ${asset.code}`.trim()}
                  </button>
                </div>
              </>
            )}

            {!selected && !loadError && payments.length > 0 && (
              <div className="err" role="alert">
                Choose a payment with something left to refund.
              </div>
            )}

            {!selected && (
              <div className="sheet__actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitInFlight}>
                  Close
                </button>
              </div>
            )}
          </form>
        )}

        {phase === "submitting" && (
          <div role="status">
            <p className="card__hint">Preparing the refund and waiting for your wallet…</p>
          </div>
        )}

        {phase === "pending" && (
          <div role="status">
            <p className="refund-pending">Refund sent, waiting for the network</p>
            <p className="card__hint">
              The transaction was accepted. Quay is watching the ledger and will mark the refund confirmed when it
              settles. You can close this window; nothing else is needed from your wallet.
            </p>
            {submittedTxHash && (
              <div className="refund-dest">
                <span className="refund-dest__label">Transaction</span>
                <code>{submittedTxHash}</code>
              </div>
            )}
            <div className="sheet__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {phase === "confirmed" && (
          <div>
            <span className="sheet__done" aria-hidden>
              <CheckIcon />
            </span>
            <p className="refund-pending">Refund confirmed on the ledger.</p>
            {submittedTxHash && (
              <div className="refund-dest">
                <span className="refund-dest__label">Transaction</span>
                <code>{submittedTxHash}</code>
              </div>
            )}
            <div className="sheet__actions">
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div>
            <div className="err" role="alert">
              {error ?? "The refund failed on the network."}
            </div>
            <div className="sheet__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn--primary" onClick={startAgain}>
                Start again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

