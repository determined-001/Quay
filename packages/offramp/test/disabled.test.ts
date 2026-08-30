import { describe, expect, it } from "vitest";
import { OffRampDisabledError } from "@checkout/core";
import { DisabledOffRamp } from "../src/disabled";

const ASSET = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

describe("DisabledOffRamp (OFFRAMP=none)", () => {
  it("refuses to quote", async () => {
    await expect(
      new DisabledOffRamp().quote({
        linkId: "lnk_1",
        sourceAsset: ASSET,
        sourceAmount: "10",
        targetCurrency: "NGN",
      }),
    ).rejects.toBeInstanceOf(OffRampDisabledError);
  });

  it("refuses to initiate", async () => {
    await expect(
      new DisabledOffRamp().initiate({
        linkId: "lnk_1",
        quoteId: "q_1",
        payout: { currency: "NGN", fields: {} },
      }),
    ).rejects.toBeInstanceOf(OffRampDisabledError);
  });

  it("refuses to report status", async () => {
    await expect(new DisabledOffRamp().status("job_1")).rejects.toBeInstanceOf(OffRampDisabledError);
  });

  it("refuses to describe payout requirements", async () => {
    await expect(new DisabledOffRamp().offrampRequirements("USDC")).rejects.toBeInstanceOf(
      OffRampDisabledError,
    );
  });

  it("names the operation in the error, so a 501 body is not a mystery", async () => {
    await expect(new DisabledOffRamp().status("job_1")).rejects.toThrow(/"status" is unavailable/);
  });

  it("omits indicativePrices entirely", () => {
    // Optional on the port. Leaving it undefined is what makes LinkService
    // degrade to an empty price list instead of surfacing an error, so the
    // dashboard's preview call stays a 200.
    expect(new DisabledOffRamp().indicativePrices).toBeUndefined();
  });

  it("is not confused with a transient anchor outage", async () => {
    // The distinction the routes rely on: 501 (permanent) vs 502 (retry).
    const err = await new DisabledOffRamp().quote({
      linkId: "lnk_1",
      sourceAsset: ASSET,
      sourceAmount: "10",
      targetCurrency: "NGN",
    }).catch((e) => e as Error);
    expect(err.name).toBe("OffRampDisabledError");
    expect(err.message).toMatch(/settle directly to the seller's wallet/);
  });
});
