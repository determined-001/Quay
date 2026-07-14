import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TestAnchorOffRamp } from "../src/testanchor";

// These hit the real https://testanchor.stellar.org sandbox. Off by default —
// it's a shared external service, not something CI should depend on. Run with:
//   RUN_LIVE_ANCHOR_TESTS=1 pnpm --filter @checkout/offramp test
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe.skipIf(!process.env.RUN_LIVE_ANCHOR_TESTS)("TestAnchorOffRamp (live)", () => {
  it("quote() returns a positive rate with a future expiry and a valid SEP-10 JWT underneath", async () => {
    const offramp = new TestAnchorOffRamp({ sellerKeypair: Keypair.random() });

    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });

    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    expect(quote.quoteId).toBeTruthy();
  });

  it("initiate() then status() completes the SEP-6 request/response round trip", async () => {
    const offramp = new TestAnchorOffRamp({ sellerKeypair: Keypair.random() });

    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });

    const job = await offramp.initiate({
      linkId: "test-link",
      quoteId: quote.quoteId,
      payout: {
        currency: "USD",
        fields: { type: "bank_account", dest: "1234", dest_extra: "021000021" },
      },
    });
    expect(job.jobId).toBeTruthy();

    // Sandbox settlement timing is not deterministic — only assert the shape,
    // never assert eventual "settled".
    const polled = await offramp.status(job.jobId);
    expect(["pending", "settled", "failed"]).toContain(polled.status);
  });
});
