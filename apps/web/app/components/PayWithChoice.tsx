"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AssetRef } from "@checkout/core";
import { serverNow, type PayOption } from "../../lib/api";
import { fmtCountdown, quoteMsRemaining } from "../../lib/quote-countdown";

/** Same asset means same code AND same issuer — "USDC" on its own is ambiguous. */
export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
}

/** "about 24.12 XLM, at most 24.36 XLM" — the quote's own figures (issue 5.47). */
export function formatPayOption(option: PayOption): string {
  const code = option.sourceAsset.code;
  return `about ${option.sourceAmount} ${code}, at most ${option.sendMax} ${code}`;
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
  /** The asset the link is denominated in; always the first radio. */
  linkAsset: AssetRef;
  /** What the buyer owes in `linkAsset`, exactly as the API quoted it. */
  linkAmount: string;
  /** Other assets on offer (issue 4.64); empty means "no choice to show". */
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
 *
 * A real `fieldset`/`legend` with native radios gives the group one Tab stop,
 * so Tab and Shift+Tab move past the whole choice. The arrow keys are handled
 * here rather than left to the browser's native radio behaviour: it keeps the
 * selection and the focused radio in step, and makes the requirement testable
 * in the DOM the unit suite runs in.
 */
export default function PayWithChoice({
  linkAsset,
  linkAmount,
  options,
  selected,
  onSelect,
  onExpired,
}: Props) {
  const radios = useRef<Array<HTMLInputElement | null>>([]);
  const hintId = useId();

  // The link asset is always index 0, then each quote in the API's order.
  const entries = useMemo<Array<PayOption | null>>(() => [null, ...options], [options]);
  const found = selected === null ? 0 : options.findIndex((option) => sameAsset(option.sourceAsset, selected.sourceAsset)) + 1;
  const selectedIndex = found >= 0 ? found : 0;

  // The group appears in response to a click; without moving focus it stays on
  // a button that is no longer the next thing to do.
  useEffect(() => {
    radios.current[0]?.focus();
  }, []);

  // Every option in a response is quoted together, so the earliest deadline is
  // when the prices on screen stop standing. A malformed entry must not turn
  // the countdown into NaN: it is filtered out instead.
  const expiresAt = useMemo(() => {
    const deadlines = options
      .map((option) => option.expiresAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }, [options]);

  const [now, setNow] = useState(() => serverNow());

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

  const choose = (index: number) => {
    onSelect(entries[index] ?? null);
    radios.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    let next: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (selectedIndex + 1) % entries.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (selectedIndex - 1 + entries.length) % entries.length;
        break;
      default:
        return;
    }
    // Native radios already do this in a browser; handling it here keeps one
    // implementation, prevents a double move and works in the DOM test env.
    event.preventDefault();
    choose(next);
  };

  const announcement = remaining === null ? null : countdownMilestone(remaining);

  return (
    <fieldset className="pay-choice" aria-describedby={hintId} onKeyDown={onKeyDown}>
      <legend>Pay with</legend>

      {entries.map((entry, index) => {
        const asset = entry === null ? linkAsset : entry.sourceAsset;
        return (
          <label key={entry === null ? "link-asset" : `${asset.code}:${asset.issuer ?? "native"}`}>
            <input
              ref={(element) => {
                radios.current[index] = element;
              }}
              type="radio"
              name="payAsset"
              value={asset.code}
              checked={selectedIndex === index}
              onChange={() => choose(index)}
            />
            <span>
              {entry === null ? (
                <>
                  <span className="mono">{linkAmount}</span> {linkAsset.code}
                </>
              ) : (
                formatPayOption(entry)
              )}
            </span>
          </label>
        );
      })}

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

      {/* Thresholds only — see countdownMilestone. The visible clock stays
          outside the live region so it is never read once a second. */}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement ?? ""}
      </p>

      <p id={hintId} className="pay-choice__hint">
        The QR code always pays in {linkAsset.code}.
      </p>
    </fieldset>
  );
}
