"use client";

/**
 * CashOutModal — #32: Payout details form driven by anchor field descriptors.
 *
 * Flow:
 *   1. Open → fetch descriptors + saved (masked) fields from /offramp-requirements.
 *   2. Seller fills the form (pre-filled with masked saved values as placeholders).
 *   3. Client-side validation from descriptors (required fields must be non-empty).
 *   4. "Get quote" → GET /links/:id/cash-out/quote → gross / fee / net + rate + expiry.
 *      Nothing is started at the anchor yet.
 *   5. Confirmation panel shows gross / fee / net, the rate and a countdown to quote expiry.
 *   6. "Confirm cash-out" → POST /cash-out with the quoteId (so the API initiates against
 *      exactly the quote the seller saw) and an Idempotency-Key reused across retries.
 *   7. Any unmet required field → cash-out button is disabled with explanatory text.
 *   8. Anchor interactive flow (SEP-24) → "interactive" step: the seller opens
 *      the anchor's page from a real click, and the modal polls
 *      GET /links/:id/detail until the link settles/fails or is dismissed.
 *      The modal never auto-closes on a (possibly blocked) popup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WithdrawTransfer } from "@checkout/core";
import {
  api,
  CheckoutError,
  describeError,
  serverNow,
  type OffRampQuote,
  type OfframpRequirements,
  type PayoutFieldDescriptor,
} from "../../lib/api";
import { fmtCountdown, quoteMsRemaining } from "../../lib/quote-countdown";
import { sendAnchorTransfer, shortAddress } from "../../lib/wallet";
import {
  anchorLabelForUrl,
  describeInteractiveStatus,
  interactivePollDelayMs,
  isInteractiveTerminalStatus,
  parseInteractiveUrl,
} from "../../lib/interactive-cashout";
import {
  checkPaymentPreflight,
  type PaymentPreflightResult,
} from "../../lib/payment-preflight";
import { useSellerWallet } from "./SessionGate";
import { TransferOtherDevice } from "./TransferOtherDevice";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  linkId: string;
  linkAmount: string;
  assetCode: string;
  targetCurrency: string;
  isMock: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// "confirming" = fetching the quote; "quote" = seller reviewing it; "submitting" = initiating.
type ModalStep =
  | "loading"
  | "form"
  | "confirming"
  | "quote"
  | "submitting"
  | "transfer"
  | "interactive"
  | "error";

interface QuotePreview {
  jobId: string;
  sourceAmount: string;
  targetAmount: string;
  targetCurrency: string;
  /** epoch ms when this quote expires on the anchor side */
  expiresAt?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the value looks like a masked placeholder ("****1234"). */
function isMasked(v: string): boolean {
  return /^\*+\d{1,4}$/.test(v);
}

/** Build validation errors from the descriptor list and current field values. */
function validate(
  descriptors: PayoutFieldDescriptor[],
  values: Record<string, string>,
  savedFields: Record<string, string> | null,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const d of descriptors) {
    if (d.optional) continue;
    const v = values[d.name] ?? "";
    const hasSaved = savedFields && savedFields[d.name];
    // OK if: non-empty typed value, OR a masked placeholder (will reuse saved), OR has saved
    if (!v && !hasSaved) {
      errs[d.name] = `${d.label} is required`;
    }
    if (d.choices && d.choices.length > 0 && v && !d.choices.includes(v)) {
      errs[d.name] = `Select one of: ${d.choices.join(", ")}`;
    }
  }
  return errs;
}

/** Mask a string for display (last 4 visible, rest stars). */
function mask(v: string): string {
  if (v.length <= 4) return "****";
  return `${"*".repeat(v.length - 4)}${v.slice(-4)}`;
}

// Countdown math lives in lib/quote-countdown.ts (issue 5.22), where the
// node-environment tests can reach it.

/** Human labels for the SEP-6 withdrawal types we know; anything else shows
 *  the anchor's raw name rather than pretending to know what it means. */
function withdrawTypeLabel(name: string): string {
  switch (name) {
    case "bank_account":
      return "Bank transfer";
    case "cash":
      return "Cash pickup";
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CashOutModal({
  linkId,
  linkAmount,
  assetCode,
  targetCurrency,
  isMock,
  onClose,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<ModalStep>("loading");
  const [requirements, setRequirements] = useState<OfframpRequirements | null>(null);
  // The seller's chosen SEP-6 withdrawal rail (issue 5.24). Preselected from
  // the API's defaultType; null when the anchor offers several and the
  // operator set no default — then choosing is part of the form.
  const [withdrawType, setWithdrawType] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  // The firm quote the seller is reviewing, and the key that makes confirming
  // it idempotent across a dropped response.
  const [firmQuote, setFirmQuote] = useState<OffRampQuote | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Set when the anchor asked for an interactive flow — the seller opens it
  // from the "interactive" step's click-to-open button, never from a popup
  // fired after `await` (browsers block those outside the click gesture).
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null);
  // Plain-words rendering of the anchor-reported status while polling.
  const [interactiveStatus, setInteractiveStatus] = useState<string | null>(null);
  const interactivePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactiveOpenedAtRef = useRef<number>(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set when the anchor is waiting for the asset. Only the seller's wallet can
  // send it; the payout does not start until they do.
  const wallet = useSellerWallet();
  const [transfer, setTransfer] = useState<WithdrawTransfer | null>(null);
  const [sending, setSending] = useState(false);
  const [sentHash, setSentHash] = useState<string | null>(null);
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
    if (step === "transfer" && transfer && wallet) {
      void runPreflight();
    }
  }, [step, transfer, wallet, runPreflight]);

  // ---- fetch requirements on mount ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .getOfframpRequirements(linkId)
      .then((r) => {
        if (cancelled) return;
        setRequirements(r);
        setWithdrawType(r.defaultType);
        setStep("form");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : "Failed to load payout requirements");
        setStep("error");
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  // ---- countdown tick ------------------------------------------------------
  // `expiresAt` is the anchor's own TTL as a SERVER timestamp, so the clock it
  // is measured against is serverNow(), not the phone's. `unknown` because an
  // absent or malformed expiry must mean "no countdown", never a guessed one
  // (issue 5.22).
  const startCountdown = useCallback((expiresAt: unknown) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (quoteMsRemaining(expiresAt, serverNow()) === null) {
      setCountdown(null);
      return;
    }
    const tick = () => setCountdown(quoteMsRemaining(expiresAt, serverNow()));
    tick();
    countdownRef.current = setInterval(tick, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  // ---- interactive polling -------------------------------------------------
  // While the interactive step is open, poll the link detail for the
  // anchor-reported status. Steady 5 s cadence, backing off to 30 s after
  // 2 minutes. Closes with onSuccess() only on terminal offrampStatus —
  // completion is detected by polling, never by watching a popup (noopener
  // popups are unobservable by design).
  useEffect(() => {
    if (step !== "interactive") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const detail = await api.getDetail(linkId);
        if (cancelled) return;
        setInteractiveStatus(describeInteractiveStatus(detail.offrampExternalStatus));
        if (isInteractiveTerminalStatus(detail.link.offrampStatus)) {
          onSuccess();
          return;
        }
      } catch {
        // A failed poll must not close the step or strand the seller — the
        // next tick retries, and the server-side poller settles the link.
      }
      if (cancelled) return;
      const delay = interactivePollDelayMs(Date.now() - interactiveOpenedAtRef.current);
      interactivePollRef.current = setTimeout(() => void poll(), delay);
    };
    interactivePollRef.current = setTimeout(() => void poll(), interactivePollDelayMs(0));
    return () => {
      cancelled = true;
      if (interactivePollRef.current) clearTimeout(interactivePollRef.current);
    };
  }, [step, linkId, onSuccess]);

  // ---- form interactions ---------------------------------------------------
  function handleChange(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  // Build the payoutFields to submit: omit blank values (API will merge saved).
  function buildPayoutFields(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      // Don't submit masked placeholders or blank strings; server merges saved.
      if (v && !isMasked(v)) out[k] = v;
    }
    return out;
  }

  /**
   * Opens the anchor's SEP-24 interactive flow from a real click, inside the
   * user gesture — popups fired after `await api.cashOut(...)` land outside
   * the gesture window and browsers routinely block them.
   *
   * Best-effort only: per the HTML spec `window.open` with `noopener` always
   * returns null, so opened vs. blocked cannot be told apart and the return
   * value is ignored entirely. The plain link below the button is the real
   * fallback, and status polling (not popup watching) detects completion.
   * `noopener` also keeps the anchor's page from reaching back through
   * window.opener to navigate this one.
   */
  function handleContinueClick(): void {
    if (!interactiveUrl) return;
    try {
      window.open(interactiveUrl, "_blank", "width=600,height=700,noopener,noreferrer");
    } catch {
      // A throwing opener changes nothing — the plain link stays usable.
    }
  }

  async function handleGetQuote() {
    if (!requirements) return;
    if (types.length > 1 && !withdrawType) return; // the picker gates submit
    const errs = validate(descriptors, values, requirements.savedFields);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setStep("confirming");
    setErrorMsg(null);
    try {
      const q = await api.quoteCashOut(linkId, targetCurrency, withdrawType ?? undefined);
      setFirmQuote(q);
      // A new quote is a new decision: it must not reuse the previous key.
      idempotencyKeyRef.current = null;
      startCountdown(q.expiresAt);
      setStep("quote");
    } catch (e: unknown) {
      setErrorMsg(e instanceof CheckoutError ? describeError(e) : e instanceof Error ? e.message : "Failed to fetch quote");
      setStep("form");
    }
  }

  async function handleConfirmCashOut() {
    if (!firmQuote) return;
    setStep("submitting");
    setErrorMsg(null);
    // One key per confirmed quote, reused if the seller retries after a dropped response.
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    try {
      const result = await api.cashOut(
        linkId,
        targetCurrency,
        buildPayoutFields(),
        idempotencyKeyRef.current,
        firmQuote.quoteId,
        withdrawType ?? undefined,
      );
      const j = result.job;
      const preview: QuotePreview = {
        jobId: j.jobId,
        sourceAmount: linkAmount,
        targetAmount: j.targetAmount,
        targetCurrency: j.targetCurrency,
      };
      setQuote(preview);
      setFirmQuote(null);
      // The anchor's real quote expiry, straight from the response. When the
      // API sends none, startCountdown shows no countdown at all.
      startCountdown(j.quoteExpiresAt);
      // Cash-out is initiated at this point (the seller already confirmed the quote). An interactive anchor URL is a modal state, not a
      // success: the seller must finish in the anchor's window, and the modal
      // must stay open (a blocked-popup fallback rendered after onSuccess
      // would unmount with the modal in the same tick). If the anchor now
      // needs the asset, keep the modal open for the seller to send it;
      // otherwise go straight to success.
      if (result.interactiveUrl) {
        const parsed = parseInteractiveUrl(result.interactiveUrl);
        if (!parsed.ok) {
          setInteractiveUrl(null);
          setErrorMsg(parsed.error);
          setStep("form");
          return;
        }
        setInteractiveUrl(parsed.href);
        setInteractiveStatus(null);
        interactiveOpenedAtRef.current = Date.now();
        setStep("interactive");
      } else if (result.transfer) {
        setTransfer(result.transfer);
        setStep("transfer");
      } else {
        onSuccess();
      }
    } catch (e: unknown) {
      const msg = e instanceof CheckoutError ? describeError(e) : e instanceof Error ? e.message : "Cash-out failed";
      setErrorMsg(msg);
      // An expired or mismatched quote cannot be confirmed; the countdown is
      // forced to zero so the panel offers a fresh quote instead.
      if (/quote_expired|quote_mismatch/.test(msg)) setCountdown(0);
      setStep("quote");
    }
  }

  async function handleSendTransfer() {
    if (!transfer || !wallet) return;
    setTransferError(null);
    setSending(true);
    try {
      setSentHash(await sendAnchorTransfer(wallet, transfer, wallet));
    } catch (e: unknown) {
      setTransferError(
        e instanceof Error && e.message ? `The payment was not sent: ${e.message}` : "The payment was not sent.",
      );
    } finally {
      setSending(false);
    }
  }

  // ---- derived state -------------------------------------------------------
  const types = requirements?.types ?? [];
  // Descriptors follow the chosen rail: each SEP-6 type carries its own field
  // set (issue 5.24), so switching the radio re-renders the form.
  const descriptors = types.find((t) => t.name === withdrawType)?.descriptors ?? [];
  const savedFields = requirements?.savedFields ?? null;
  const needsTypeChoice = types.length > 1 && !withdrawType;

  // Determine which required fields are unmet to show the disabled explanation.
  const unmetRequired = descriptors.filter((d) => {
    if (d.optional) return false;
    const typed = values[d.name] ?? "";
    const hasSaved = savedFields && savedFields[d.name];
    return !typed && !hasSaved;
  });
  const canSubmit = unmetRequired.length === 0 && !needsTypeChoice;
  const quoteExpired = countdown !== null && countdown <= 0;

  // ---- render --------------------------------------------------------------
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cash out to local currency"
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
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "24px",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            Cash out to {targetCurrency}
            {isMock && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: "var(--amber)",
                  fontWeight: 400,
                  fontFamily: "var(--mono)",
                }}
              >
                (simulated)
              </span>
            )}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: "0 0 0 8px",
            }}
          >
            ×
          </button>
        </div>

        {/* Loading */}
        {step === "loading" && (
          <div style={{ textAlign: "center", padding: "32px 0", color: "var(--muted)" }}>
            <div className="spinner" style={{ margin: "0 auto 12px" }} />
            Loading payout requirements…
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div>
            <div className="err" style={{ marginBottom: 16 }}>
              {errorMsg}
            </div>
            <button className="btn btn--block" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {/* Form */}
        {(step === "form" || step === "confirming") && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleGetQuote();
            }}
          >
            {/* Amount summary */}
            <div
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "12px 14px",
                marginBottom: 20,
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              Cashing out{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {linkAmount} {assetCode}
              </span>{" "}
              → {targetCurrency}
            </div>

            {/* Rail picker: which SEP-6 withdrawal type the money leaves on is
                the seller's choice, not the operator's (issue 5.24). Only
                rendered when the anchor actually offers more than one. */}
            {types.length > 1 && (
              <fieldset
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "10px 14px 12px",
                  marginBottom: 16,
                }}
              >
                <legend style={{ fontSize: 12, color: "var(--muted)", padding: "0 6px" }}>
                  How should the money arrive?
                </legend>
                {types.map((t) => (
                  <label
                    key={t.name}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 14, cursor: "pointer" }}
                  >
                    <input
                      type="radio"
                      name="withdrawType"
                      value={t.name}
                      checked={withdrawType === t.name}
                      onChange={() => {
                        setWithdrawType(t.name);
                        // The new rail has its own fields; stale per-field
                        // errors from the old one would point at inputs that
                        // no longer exist.
                        setFieldErrors({});
                      }}
                      disabled={step === "confirming"}
                    />
                    {withdrawTypeLabel(t.name)}
                  </label>
                ))}
                {needsTypeChoice && (
                  <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>
                    Choose one to see the details this payout needs.
                  </p>
                )}
              </fieldset>
            )}

            {/* Dynamic fields from descriptors */}
            {descriptors.length === 0 && !needsTypeChoice && (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>
                No payout fields required by this anchor.
              </p>
            )}
            {descriptors.map((d) => (
              <FieldInput
                key={d.name}
                descriptor={d}
                value={values[d.name] ?? ""}
                savedMasked={savedFields?.[d.name] ?? null}
                error={fieldErrors[d.name] ?? null}
                onChange={(v) => handleChange(d.name, v)}
                disabled={step === "confirming"}
              />
            ))}

            {/* Disabled explanation */}
            {unmetRequired.length > 0 && step === "form" && (
              <div
                role="status"
                style={{
                  fontSize: 12,
                  color: "var(--amber)",
                  marginBottom: 14,
                  padding: "8px 12px",
                  background: "rgba(232,184,75,0.08)",
                  borderRadius: 6,
                  border: "1px solid rgba(232,184,75,0.2)",
                }}
              >
                Cash-out is disabled until you fill in:{" "}
                {unmetRequired.map((d) => d.label).join(", ")}.
              </div>
            )}

            {/* General error */}
            {errorMsg && step === "form" && (
              <div className="err" style={{ marginBottom: 14 }}>
                {errorMsg}
              </div>
            )}

            {/* Action button */}
            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={!canSubmit || step === "confirming"}
              aria-disabled={!canSubmit}
            >
              {step === "confirming" ? "Getting quote…" : "Get quote"}
            </button>

            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={onClose}
              disabled={step === "confirming"}
            >
              Cancel
            </button>
          </form>
        )}

        {/* Firm quote — nothing has been started at the anchor yet. */}
        {(step === "quote" || step === "submitting") && firmQuote && (
          <div>
            <div
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "14px 16px",
                fontSize: 13,
                marginBottom: 20,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--muted)",
                  marginBottom: 10,
                }}
              >
                Firm quote {isMock && <span style={{ color: "var(--amber)" }}>(simulated)</span>}
              </div>
              <Row label="You send" value={`${firmQuote.sourceAmount} ${assetCode}`} mono />
              <Row label="Gross amount" value={`${firmQuote.targetAmount} ${firmQuote.targetCurrency}`} mono />
              <Row
                label={firmQuote.fee.source === "estimated" ? "Fee (estimated)" : "Fee"}
                value={`${firmQuote.fee.amount} ${firmQuote.fee.currency}`}
                mono
              />
              <Row
                label={`You receive (${firmQuote.targetCurrency})`}
                value={`${firmQuote.netTargetAmount} ${firmQuote.targetCurrency}`}
                mono
                accent
              />
              <Row
                label="Exchange rate"
                value={`1 ${assetCode} = ${firmQuote.rate} ${firmQuote.targetCurrency}`}
                mono
              />
              {countdown !== null && (
                <div
                  style={{ marginTop: 12, fontSize: 12, color: quoteExpired ? "var(--red)" : "var(--muted)" }}
                  role="status"
                  aria-live="polite"
                >
                  {quoteExpired ? (
                    "Quote expired — please request a new quote."
                  ) : (
                    <>
                      Quote valid for{" "}
                      <span className="mono" style={{ color: "var(--amber)" }}>
                        {fmtCountdown(countdown)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {errorMsg && (
              <div className="err" style={{ marginBottom: 14 }}>
                {errorMsg}
              </div>
            )}

            {quoteExpired ? (
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void handleGetQuote()}
              >
                Get a new quote
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void handleConfirmCashOut()}
                disabled={step === "submitting"}
              >
                {step === "submitting" ? "Submitting…" : "Confirm cash-out"}
              </button>
            )}

            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={() => {
                if (countdownRef.current) clearInterval(countdownRef.current);
                setCountdown(null);
                setErrorMsg(null);
                setStep("form");
              }}
              disabled={step === "submitting"}
            >
              Back
            </button>
          </div>
        )}

        {/* The anchor is waiting for the asset. The seller's wallet sends it
            straight to the anchor; nothing passes through Quay. */}
        {step === "transfer" && transfer && (
          <div>
            {sentHash ? (
              <>
                <div className="kyc-note kyc-note--ok" style={{ marginBottom: 12 }}>
                  Sent. The anchor pays out once it sees the payment on the ledger.
                </div>
                <p className="muted mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {sentHash}
                </p>
                <button className="btn btn--primary btn--block" onClick={onSuccess}>
                  Done
                </button>
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
                <TransferOtherDevice transfer={transfer} wallet={wallet} onSent={setSentHash} />
              </>
            )}
          </div>
        )}

        {/* The anchor needs the seller in its own window. Opened from a real
            click (inside the user gesture); the plain link below covers
            blocked popups. Completion is detected by polling, never by
            watching the popup. */}
        {step === "interactive" && interactiveUrl && (
          <div>
            <p style={{ marginTop: 0 }}>
              Your anchor needs one more step in its own window. Continue there, then come back —
              this closes itself once the payout settles.
            </p>
            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={handleContinueClick}
            >
              Continue with {anchorLabelForUrl(interactiveUrl)}
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Popup blocked?{" "}
              <a href={interactiveUrl} target="_blank" rel="noopener noreferrer">
                Open the anchor page directly
              </a>
            </p>
            <p className="muted" style={{ fontSize: 12 }} role="status" aria-live="polite">
              {interactiveStatus ?? "Waiting for the anchor…"}
            </p>
            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={onClose}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Quote confirmation panel (shown after initiate succeeds) */}
        {quote && (
          <QuoteSummary
            quote={quote}
            targetCurrency={targetCurrency}
            countdown={countdown}
            isMock={isMock}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldInput — renders one descriptor as an appropriate input element
// ---------------------------------------------------------------------------

function FieldInput({
  descriptor,
  value,
  savedMasked,
  error,
  onChange,
  disabled,
}: {
  descriptor: PayoutFieldDescriptor;
  value: string;
  savedMasked: string | null;
  error: string | null;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const { name, label, description, optional, choices } = descriptor;
  const inputId = `payout-${name}`;
  const hasSaved = savedMasked !== null;

  return (
    <div className="field">
      <label htmlFor={inputId}>
        {label}
        {optional && (
          <span style={{ color: "var(--muted)", marginLeft: 4, fontWeight: 400 }}>
            (optional)
          </span>
        )}
        {hasSaved && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              color: "var(--accent)",
              fontFamily: "var(--mono)",
              letterSpacing: "0.04em",
            }}
          >
            on file
          </span>
        )}
      </label>

      {choices && choices.length > 0 ? (
        <select
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={!optional}
          aria-required={!optional}
          aria-describedby={description ? `${inputId}-desc` : undefined}
          aria-invalid={error ? "true" : undefined}
        >
          <option value="">— select —</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type={name.includes("email") ? "email" : "text"}
          inputMode={
            name === "dest" || name.includes("account") || name.includes("number")
              ? "numeric"
              : undefined
          }
          value={value}
          placeholder={hasSaved ? `${savedMasked} (leave blank to reuse)` : undefined}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={!optional && !hasSaved}
          aria-required={!optional && !hasSaved}
          aria-describedby={
            [description ? `${inputId}-desc` : null, hasSaved ? `${inputId}-saved` : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
          aria-invalid={error ? "true" : undefined}
          autoComplete={
            name.includes("email")
              ? "email"
              : name === "first_name"
                ? "given-name"
                : name === "last_name"
                  ? "family-name"
                  : "off"
          }
        />
      )}

      {description && (
        <span
          id={`${inputId}-desc`}
          style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 4 }}
        >
          {description}
        </span>
      )}
      {hasSaved && !value && (
        <span
          id={`${inputId}-saved`}
          style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 2 }}
        >
          Saved: {savedMasked}
        </span>
      )}
      {error && (
        <span
          role="alert"
          style={{ fontSize: 11, color: "var(--red)", display: "block", marginTop: 4 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuoteSummary — gross / fee / net + countdown
// ---------------------------------------------------------------------------

function QuoteSummary({
  quote,
  targetCurrency,
  countdown,
  isMock,
}: {
  quote: QuotePreview;
  targetCurrency: string;
  countdown: number | null;
  isMock: boolean;
}) {
  // The post-initiate receipt: the job's net amount. The fee breakdown the seller
  // agreed to was shown in the firm-quote panel before confirming.
  const expired = countdown !== null && countdown <= 0;

  return (
    <div
      style={{
        marginTop: 20,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "14px 16px",
        fontSize: 13,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--muted)",
          marginBottom: 10,
        }}
      >
        Cash-out initiated {isMock && <span style={{ color: "var(--amber)" }}>(simulated)</span>}
      </div>

      <Row label="You send" value={`${quote.sourceAmount} USDC`} mono />
      <Row label={`You receive (~${targetCurrency})`} value={`${quote.targetAmount} ${targetCurrency}`} mono accent />

      {countdown !== null && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: expired ? "var(--red)" : "var(--muted)",
          }}
          role="status"
          aria-live="polite"
        >
          {expired ? (
            "Quote expired — the payout was already submitted."
          ) : (
            <>
              Quote valid for{" "}
              <span className="mono" style={{ color: "var(--amber)" }}>
                {fmtCountdown(countdown)}
              </span>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
        Job ID: <span className="mono">{quote.jobId}</span>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{ color: accent ? "var(--accent)" : "var(--text)" }}
      >
        {value}
      </span>
    </div>
  );
}
