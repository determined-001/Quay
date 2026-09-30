import { afterEach, describe, expect, it } from "vitest";
import { serverNow, setServerSkewForTest } from "../lib/api";
import { fmtCountdown, quoteCountdownLabel, quoteMsRemaining } from "../lib/quote-countdown";

// Issue 5.22: the countdown must come from the expiry the API returned,
// measured on the server's clock — and an absent expiry must mean NO
// countdown, never a guessed number.

afterEach(() => setServerSkewForTest(0));

describe("quoteMsRemaining", () => {
  it("returns the remaining ms for a future expiry", () => {
    expect(quoteMsRemaining(10_000, 4_000)).toBe(6_000);
  });

  it("returns a negative value for a past expiry (expired, not hidden)", () => {
    expect(quoteMsRemaining(4_000, 10_000)).toBe(-6_000);
  });

  it("returns null — no countdown — when the response carried no usable expiry", () => {
    expect(quoteMsRemaining(undefined, 1_000)).toBeNull();
    expect(quoteMsRemaining(null, 1_000)).toBeNull();
    expect(quoteMsRemaining(Number.NaN, 1_000)).toBeNull();
    expect(quoteMsRemaining(Number.POSITIVE_INFINITY, 1_000)).toBeNull();
    expect(quoteMsRemaining("2026-09-29T00:00:00Z", 1_000)).toBeNull();
  });
});

describe("quoteCountdownLabel", () => {
  it("labels a future expiry with m:ss", () => {
    expect(quoteCountdownLabel(1_000 + 61_000, 1_000)).toBe("Quote valid for 1:01");
  });

  it("labels a past expiry as expired", () => {
    expect(quoteCountdownLabel(1_000, 61_000)).toBe("Quote expired");
    expect(quoteCountdownLabel(1_000, 1_000)).toBe("Quote expired");
  });

  it("returns null with no expiry — the caller renders nothing", () => {
    expect(quoteCountdownLabel(undefined, 1_000)).toBeNull();
  });
});

describe("fmtCountdown", () => {
  it("formats m:ss, padding seconds", () => {
    expect(fmtCountdown(65_000)).toBe("1:05");
    expect(fmtCountdown(600_000)).toBe("10:00");
  });

  it("clamps at 0:00 rather than going negative", () => {
    expect(fmtCountdown(-5_000)).toBe("0:00");
  });
});

describe("clock skew (serverNow)", () => {
  it("a skewed browser clock does not move the countdown when measured with serverNow()", () => {
    // The anchor's quote expires 60s from the SERVER's now. The browser
    // clock is 5 minutes fast — exactly the phone that used to break this.
    const skewMs = 5 * 60_000;
    setServerSkewForTest(-skewMs); // server = browser − 5min
    const expiresAt = serverNow() + 60_000;

    const remaining = quoteMsRemaining(expiresAt, serverNow());
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(59_000);
    expect(remaining!).toBeLessThanOrEqual(60_000);

    // Measured against the raw browser clock the same quote would already
    // look expired — the bug this issue removes.
    expect(quoteMsRemaining(expiresAt, Date.now())).toBeLessThan(0);
  });
});
