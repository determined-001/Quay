import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Issue #35. The countdown itself is presentational, but two decisions in it
// are not, and both are pure functions of the numbers:
//
//   - a link past its deadline must never present as payable, even while the
//     server still has it stored as `active` (the sweep runs on a timer)
//   - the remaining time must be measured on the *server's* clock, because a
//     buyer's phone can be minutes out
// ---------------------------------------------------------------------------

const EXPIRY_WARNING_MS = 2 * 60_000;

/** Mirrors formatRemaining in CheckoutClient. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Mirrors the expiredByClock / isTerminal derivation in CheckoutClient. */
function checkoutState(link: { status: string; expiresAt: number | null }, serverNowMs: number) {
  const msRemaining = link.expiresAt === null ? null : link.expiresAt - serverNowMs;
  const expiredByClock = msRemaining !== null && msRemaining <= 0;
  const terminalStatus = ["paid", "expired", "cancelled", "offramp_pending", "offramp_settled", "offramp_failed"];
  return {
    msRemaining,
    expiredByClock,
    showsPayableQr: !terminalStatus.includes(link.status) && !expiredByClock,
    urgent: msRemaining !== null && msRemaining > 0 && msRemaining <= EXPIRY_WARNING_MS,
  };
}

describe("checkout expiry", () => {
  const NOW = 1_700_000_000_000;

  it("never shows a payable QR once the deadline has passed, even while the status is still active", () => {
    // The exact window the sweep leaves open.
    const state = checkoutState({ status: "active", expiresAt: NOW - 1 }, NOW);
    expect(state.expiredByClock).toBe(true);
    expect(state.showsPayableQr).toBe(false);
  });

  it("still shows the QR one second before the deadline", () => {
    const state = checkoutState({ status: "active", expiresAt: NOW + 1_000 }, NOW);
    expect(state.showsPayableQr).toBe(true);
  });

  it("shows the QR indefinitely for a link with no TTL", () => {
    const state = checkoutState({ status: "active", expiresAt: null }, NOW);
    expect(state.msRemaining).toBeNull();
    expect(state.showsPayableQr).toBe(true);
  });

  it("uses the server clock, so a badly skewed local clock cannot extend a link", () => {
    // Buyer's device is five minutes slow; the link expired a minute ago.
    const expiresAt = NOW - 60_000;
    const skewedLocalNow = NOW - 5 * 60_000;

    expect(checkoutState({ status: "active", expiresAt }, skewedLocalNow).showsPayableQr).toBe(true);
    expect(checkoutState({ status: "active", expiresAt }, NOW).showsPayableQr).toBe(false);
  });

  it("warns only inside the last two minutes", () => {
    expect(checkoutState({ status: "active", expiresAt: NOW + 2 * 60_000 + 1 }, NOW).urgent).toBe(false);
    expect(checkoutState({ status: "active", expiresAt: NOW + 90_000 }, NOW).urgent).toBe(true);
    // Past the deadline it is not "urgent" any more, it is over.
    expect(checkoutState({ status: "active", expiresAt: NOW - 1 }, NOW).urgent).toBe(false);
  });

  it("formats mm:ss with a stable width", () => {
    expect(formatRemaining(9 * 60_000 + 41_000)).toBe("9:41");
    expect(formatRemaining(7_000)).toBe("0:07");
    expect(formatRemaining(0)).toBe("0:00");
    expect(formatRemaining(-5_000)).toBe("0:00");
  });
});
