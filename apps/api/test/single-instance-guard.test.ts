import { describe, expect, it, vi } from "vitest";
import { assertSharedStateOrSingleInstance } from "../src/services/container";

// ---------------------------------------------------------------------------
//  Two security properties in this service are per-process when REDIS_URL is
//  unset: rate-limit counters, and the SEP-10 "this challenge has been used"
//  claim. Both are correct on one instance and both break silently on two —
//  N times every limit, and one signed challenge redeemable once per replica.
//
//  What makes it worth a boot guard rather than a doc line is that the change
//  which breaks it is not a code change. It is a number in a dashboard, made
//  by someone who will never see this file.
// ---------------------------------------------------------------------------

const logger = () => ({ warn: vi.fn() }) as never;

describe("assertSharedStateOrSingleInstance", () => {
  it("refuses to boot on pubnet with no REDIS_URL and no acknowledgement", () => {
    expect(() => assertSharedStateOrSingleInstance({ network: "public", singleInstance: false })).toThrow(
      /REDIS_URL is not set on the public network/,
    );
  });

  it("explains both failures in the error, not just 'set REDIS_URL'", () => {
    try {
      assertSharedStateOrSingleInstance({ network: "public", singleInstance: false });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/N times every limit/);
      expect(msg).toMatch(/N redemptions of one signed challenge/);
      expect(msg).toMatch(/SINGLE_INSTANCE=true/);
    }
  });

  it("boots when REDIS_URL is set — the state is genuinely shared", () => {
    expect(() =>
      assertSharedStateOrSingleInstance({ network: "public", redisUrl: "redis://x", singleInstance: false }),
    ).not.toThrow();
  });

  it("boots on an explicit single-instance acknowledgement, and says so out loud", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertSharedStateOrSingleInstance({ network: "public", singleInstance: true }, log as never),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scaling.single_instance" }),
      expect.stringContaining("must stay at one instance"),
    );
  });

  it("does not warn when REDIS_URL is set — there is nothing to warn about", () => {
    const log = { warn: vi.fn() };
    assertSharedStateOrSingleInstance({ network: "public", redisUrl: "redis://x", singleInstance: true }, log as never);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never fires on testnet, where the blast radius is play money", () => {
    expect(() => assertSharedStateOrSingleInstance({ network: "testnet", singleInstance: false }, logger())).not.toThrow();
  });
});
