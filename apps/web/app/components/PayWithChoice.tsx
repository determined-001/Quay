"use client";

import { useEffect, useRef, useState } from "react";
import { serverNow, type PayOption } from "../../lib/api";
import { fmtCountdown, quoteMsRemaining } from "../../lib/quote-countdown";

/** Same asset means same code AND same issuer — "USDC" on its own is ambiguous. */
export function sameAsset(
  a: { code: string; issuer: string | null },
  b: { code: string; issuer: string | null },
): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
}

/** "about 24.12 XLM, at most 24.36 XLM" — the quote's own figures (issue 5.47). */
export function formatPayOption(option: PayOption): string {
  const code = option.sourceAsset.code;
  // Amount and code are glued with a no-break space: on a 375px screen the
  // option wraps, and a plain space leaves the asset code alone on line two
  // ("…at most 24.36" / "XLM"). Wrapping before the amount reads as a pair.
  return `about ${option.sourceAmount}\u00A0${code}, at most ${option.sendMax}\u00A0${code}`;
}

/**
 * What the live region may say at this remaining time, or null for "say
 * nothing new".
 *
 * The visible countdown ticks every second. Announcing that would read a clock
 * aloud sixty times a minute, so only the thresholds a buyer can act on are
 * spoken — and only once each, because an unchanged string is not re-announced.
 */
export function countdownMilestone(ms: number): string | null {
  if (ms <= 0) return "Quote expired — getting a new price.";
  if (ms <= 10_000) return "Quote expires in under 10 seconds.";
  if (ms <= 30_000) return "Quote expires in under 30 seconds.";
  if (ms <= 60_000) return "Quote expires in under a minute.";
  return null;
}

interface Props {
  /** What the buyer owes in the link asset, exactly as the builder uses it. */
  linkAmount: string;
  linkAssetCode: string;
  /** Other assets on offer; the link asset is always listed first. */
  options: PayOption[];
  /** The chosen path option, or null for the link asset. */
  selected: PayOption | null;
  onSelect: (option: PayOption | null) => void;
  /** Fired once per expired quote; the parent re-fetches the options. */
  onExpired: () => void;
}

/**
 * Asset choice for a wallet payment (issue 5.47). Sits between "wallet
 * connected" and "transaction built": nothing is signed until the buyer has
 * picked, and the SEP-7 QR flow above is deliberately untouched.
 */
export default function PayWithChoice({
  linkAmount,
  linkAssetCode,
  options,
  selected,
  onSelect,
  onExpired,
}: Props) {
  const expiresAt = selected?.expiresAt ?? null;
  const [now, setNow] = useState(() => serverNow());
  const firstRadio = useRef<HTMLInputElement | null>(null);

  // The group appears in response to a click; without moving focus it stays on
  // a button that is no longer the next thing to do.
  useEffect(() => {
    firstRadio.current?.focus();
  }, []);

  // One tick a second is enough for the visible countdown; the value itself is
  // derived from the server clock, so a skew correction lands on the next tick.
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), 1_000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const remaining = quoteMsRemaining(expiresAt, now);

  // Exactly one re-quote per expired quote: keyed on the deadline, so the new
  // quote's arrival re-arms the effect instead of looping on it.
  const requotedFor = useRef<number | null>(null);
  useEffect(() => {
    if (expiresAt === null || remaining === null || remaining > 0) return;
    if (requotedFor.current === expiresAt) return;
    requotedFor.current = expiresAt;
    onExpired();
  }, [expiresAt, remaining, onExpired]);

  const announcement = remaining === null ? null : countdownMilestone(remaining);

  return (
    <fieldset className="pay-choice">
      <legend>Pay with</legend>

      <label>
        <input
          ref={firstRadio}
          type="radio"
          name="payAsset"
          value={linkAssetCode}
          checked={selected === null}
          onChange={() => onSelect(null)}
        />
        <span>
          <span className="mono">{linkAmount}</span> {linkAssetCode}
        </span>
      </label>

      {options.map((option, index) => (
        <label key={`${option.sourceAsset.code}:${option.sourceAsset.issuer ?? "native"}:${index}`}>
          <input
            type="radio"
            name="payAsset"
            value={option.sourceAsset.code}
            checked={selected !== null && sameAsset(selected.sourceAsset, option.sourceAsset)}
            onChange={() => onSelect(option)}
          />
          <span>{formatPayOption(option)}</span>
        </label>
      ))}

      {remaining !== null && (
        <p
          className={
            remaining <= 0
              ? "pay-choice__countdown pay-choice__countdown--expired"
              : "pay-choice__countdown"
          }
        >
          {remaining <= 0 ? (
            "Quote expired — getting a new price…"
          ) : (
            <>
              Quote valid for <span className="mono">{fmtCountdown(remaining)}</span>
            </>
          )}
        </p>
      )}

      {/* Thresholds only — see countdownMilestone. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement ?? ""}
      </p>

      {/* Deliberately does not say "above": this panel also renders on the
          underpaid screen, which has no QR code. */}
      <p className="pay-choice__hint">QR payments always use {linkAssetCode}.</p>
    </fieldset>
  );
}
