"use client";

/**
 * CashOutModal — #32, #260: Payout details form and firm quote confirmation
 * driven by anchor field descriptors and SEP-38 /sep38/quote.
 *
 * Flow:
 *   1. Open → fetch descriptors + saved (masked) fields from /offramp-requirements.
 *   2. Seller fills the form (pre-filled with masked saved values as placeholders).
 *   3. Client-side validation from descriptors (required fields must be non-empty).
 *   4. "Get quote" → GET /links/:id/cash-out/quote → receive gross/fee/net + rate + expiry.
 *   5. Confirmation panel shows gross / fee / net, rate and a countdown to quote expiry.
 *   6. "Confirm cash-out" → POST /links/:id/cash-out with quoteId and Idempotency-Key.
 *   7. Any unmet required field → button is disabled with explanatory text.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type CashOutQuote,
  type OfframpRequirements,
  type PayoutFieldDescriptor,
} from "../../lib/api";

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

type ModalStep = "loading" | "form" | "quote" | "submitting" | "error";

interface InitiatedJobPreview {
  jobId: string;
  sourceAmount: string;
  targetAmount: string;
  targetCurrency: string;
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

/** Format seconds as "m:ss". */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
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
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [firmQuote, setFirmQuote] = useState<CashOutQuote | null>(null);
  const [initiatedJob, setInitiatedJob] = useState<InitiatedJobPreview | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quoting, setQuoting] = useState<boolean>(false);
  // Set only when the anchor asked for an interactive flow and the popup was
  // blocked — the seller needs a link they can open themselves.
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  // ---- fetch requirements on mount ----------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .getOfframpRequirements(linkId)
      .then((r) => {
        if (cancelled) return;
        setRequirements(r);
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
  const startCountdown = useCallback((expiresAt: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    const tick = () => {
      const remaining = expiresAt - Date.now();
      setCountdown(remaining);
    };
    tick();
    countdownRef.current = setInterval(tick, 500);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

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
   * Opens the anchor's SEP-24 interactive flow.
   */
  function openInteractive(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      setInteractiveUrl(null);
      setErrorMsg("The anchor returned an unusable interactive URL. Contact support before retrying.");
      return;
    }
    if (parsed.protocol !== "https:") {
      setInteractiveUrl(null);
      setErrorMsg("The anchor returned a non-HTTPS interactive URL, which was refused.");
      return;
    }

    const popup = window.open(parsed.href, "_blank", "width=600,height=700,noopener,noreferrer");
    if (!popup) setInteractiveUrl(parsed.href);
  }

  async function handleGetQuote() {
    if (!requirements) return;
    const errs = validate(requirements.descriptors, values, requirements.savedFields);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setQuoting(true);
    setErrorMsg(null);
    try {
      const q = await api.quoteCashOut(linkId, targetCurrency);
      setFirmQuote(q);
      idempotencyKeyRef.current = null; // Fresh key on new quote
      startCountdown(q.expiresAt);
      setStep("quote");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to fetch quote");
    } finally {
      setQuoting(false);
    }
  }

  async function handleConfirmCashOut() {
    if (!firmQuote) return;
    setStep("submitting");
    setErrorMsg(null);

    // Generate idempotency key once per confirm attempt, reused on retry
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const idempotencyKey = idempotencyKeyRef.current;

    try {
      const result = await api.cashOut(
        linkId,
        targetCurrency,
        buildPayoutFields(),
        idempotencyKey,
        firmQuote.quoteId,
      );
      stopCountdown();
      if (result.interactiveUrl) {
        openInteractive(result.interactiveUrl);
      }
      const j = result.job;
      setInitiatedJob({
        jobId: j.jobId,
        sourceAmount: linkAmount,
        targetAmount: j.targetAmount,
        targetCurrency: j.targetCurrency,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Cash-out failed";
      setErrorMsg(msg);
      if (msg.includes("quote_expired")) {
        setCountdown(0);
      }
      setStep("quote");
    }
  }

  // ---- derived state -------------------------------------------------------
  const descriptors = requirements?.descriptors ?? [];
  const savedFields = requirements?.savedFields ?? null;

  // Determine which required fields are unmet to show the disabled explanation.
  const unmetRequired = descriptors.filter((d) => {
    if (d.optional) return false;
    const typed = values[d.name] ?? "";
    const hasSaved = savedFields && savedFields[d.name];
    return !typed && !hasSaved;
  });
  const canSubmit = unmetRequired.length === 0;
  const isQuoteExpired = countdown !== null && countdown <= 0;

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

        {/* Form Step */}
        {step === "form" && (
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

            {/* Dynamic fields from descriptors */}
            {descriptors.length === 0 && (
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
                disabled={quoting}
              />
            ))}

            {/* Disabled explanation */}
            {!canSubmit && (
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
            {errorMsg && (
              <div className="err" style={{ marginBottom: 14 }}>
                {errorMsg}
              </div>
            )}

            {/* Action button */}
            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={!canSubmit || quoting}
              aria-disabled={!canSubmit}
            >
              {quoting ? "Getting quote…" : "Get quote"}
            </button>

            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={onClose}
              disabled={quoting}
            >
              Cancel
            </button>
          </form>
        )}

        {/* Quote Step */}
        {(step === "quote" || step === "submitting") && firmQuote && !initiatedJob && (
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
                Firm Quote {isMock && <span style={{ color: "var(--amber)" }}>(simulated)</span>}
              </div>

              <Row label="You send" value={`${firmQuote.sourceAmount} ${assetCode}`} mono />
              <Row
                label="Gross amount"
                value={`${firmQuote.targetAmount} ${firmQuote.targetCurrency}`}
                mono
              />
              <Row
                label={
                  firmQuote.fee.source === "estimated" ? "Fee (estimated)" : "Fee"
                }
                value={`${firmQuote.fee.amount} ${firmQuote.fee.currency}`}
                mono
              />
              <Row
                label={`You receive (${firmQuote.targetCurrency})`}
                value={`${firmQuote.netTargetAmount} ${firmQuote.targetCurrency}`}
                mono
                accent
              />
              <Row label="Exchange rate" value={`1 ${assetCode} = ${firmQuote.rate} ${firmQuote.targetCurrency}`} mono />

              {countdown !== null && (
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: isQuoteExpired ? "var(--red)" : "var(--muted)",
                  }}
                  role="status"
                  aria-live="polite"
                >
                  {isQuoteExpired ? (
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

            {isQuoteExpired ? (
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => {
                  setStep("form");
                  void handleGetQuote();
                }}
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
                {step === "submitting" ? "Processing…" : "Confirm cash-out"}
              </button>
            )}

            <button
              type="button"
              className="btn btn--block"
              style={{ marginTop: 8 }}
              onClick={() => {
                stopCountdown();
                setStep("form");
              }}
              disabled={step === "submitting"}
            >
              Back
            </button>
          </div>
        )}

        {/* The anchor needs the seller in a browser and the popup was blocked */}
        {interactiveUrl && (
          <div className="banner banner--warn" style={{ marginTop: 12 }}>
            <p style={{ margin: "0 0 8px" }}>
              Your anchor needs one more step in a browser window, which this browser blocked.
            </p>
            <a
              className="btn btn--primary"
              href={interactiveUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Continue with the anchor
            </a>
          </div>
        )}

        {/* Post-initiation panel (shown after initiate succeeds) */}
        {initiatedJob && (
          <PostInitiationSummary
            job={initiatedJob}
            targetCurrency={targetCurrency}
            isMock={isMock}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PostInitiationSummary — summary without quote countdown
// ---------------------------------------------------------------------------

function PostInitiationSummary({
  job,
  targetCurrency,
  isMock,
}: {
  job: InitiatedJobPreview;
  targetCurrency: string;
  isMock: boolean;
}) {
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

      <Row label="You send" value={`${job.sourceAmount} USDC`} mono />
      <Row label={`You receive (~${targetCurrency})`} value={`${job.targetAmount} ${targetCurrency}`} mono accent />

      <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
        Job ID: <span className="mono">{job.jobId}</span>
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

