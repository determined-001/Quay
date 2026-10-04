/**
 * Quote-expiry countdown math (issue 5.22), pure and DOM-free so the
 * node-environment vitest setup can cover it.
 *
 * The SEP-38 quote TTL belongs to the ANCHOR: it arrives as `expiresAt`
 * (epoch ms, a server timestamp) on the quote and as `quoteExpiresAt` on the
 * cash-out response. Two rules follow, and both live here rather than in the
 * component:
 *
 * 1. No expiry in the response ⇒ no countdown. A guessed number tells the
 *    seller they have time they may not have (or that a live quote is dead).
 * 2. `now` must be the SERVER's clock (`serverNow()` from lib/api), because
 *    `expiresAt` is a server timestamp and phone clocks are routinely
 *    minutes out.
 *
 * 5.23 (quote-then-confirm) reuses the same helpers with the standalone
 * quote endpoint's `expiresAt`.
 */

/** m:ss, clamped at 0:00. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Milliseconds remaining on a quote at `now`, or `null` when the API sent no
 * usable expiry — `null` means "render no countdown", never "assume one".
 * `expiresAt` is `unknown` on purpose: this is the trust boundary where an
 * absent or malformed field must degrade to nothing instead of NaN.
 */
export function quoteMsRemaining(expiresAt: unknown, now: number): number | null {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return expiresAt - now;
}

/**
 * The countdown line for a quote at `now`: `null` when there is nothing
 * honest to show, "Quote expired" at or past the expiry, else
 * "Quote valid for m:ss".
 */
export function quoteCountdownLabel(expiresAt: unknown, now: number): string | null {
  const ms = quoteMsRemaining(expiresAt, now);
  if (ms === null) return null;
  return ms <= 0 ? "Quote expired" : `Quote valid for ${fmtCountdown(ms)}`;
}
