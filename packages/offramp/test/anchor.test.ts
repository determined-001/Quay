import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AnchorOffRamp, mapSep24Status } from "../src/anchor";
import { parseStellarToml } from "../src/sep1";
import { clearSep24InfoCache } from "../src/sep24";

const USDC_TESTNET_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("AnchorOffRamp (offline)", () => {
  beforeEach(() => {
    clearSep24InfoCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSep24InfoCache();
  });

  it("parseStellarToml parses SEP-1 discovery endpoints correctly", () => {
    const toml = `
      WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
      TRANSFER_SERVER_SEP24 = "https://testanchor.stellar.org/sep24"
      ANCHOR_QUOTE_SERVER = "https://testanchor.stellar.org/sep38"
    `;
    const parsed = parseStellarToml(toml, "testanchor.stellar.org");
    expect(parsed.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(parsed.transferServerSep24).toBe(
      "https://testanchor.stellar.org/sep24",
    );
    expect(parsed.anchorQuoteServer).toBe(
      "https://testanchor.stellar.org/sep38",
    );
  });

  it("mapSep24Status maps SEP-24 transaction states onto OffRampJobStatus", () => {
    expect(mapSep24Status("completed")).toBe("settled");
    expect(mapSep24Status("error")).toBe("failed");
    expect(mapSep24Status("refunded")).toBe("failed");
    expect(mapSep24Status("expired")).toBe("failed");
    expect(mapSep24Status("pending_user_transfer_start")).toBe("pending");
    expect(mapSep24Status("pending_anchor")).toBe("pending");
    expect(mapSep24Status("pending_external")).toBe("pending");
  });

  it("quote() validates against SEP-24 /info and estimates fee when SEP-38 is not present", async () => {
    const toml = `
      WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
      TRANSFER_SERVER_SEP24 = "https://testanchor.stellar.org/sep24"
    `;

    const sep24Info = {
      withdraw: {
        USDC: {
          enabled: true,
          min_amount: 5,
          max_amount: 1000,
          fee_fixed: 1,
          fee_percent: 2,
          fee_minimum: 0.5,
        },
      },
    };

    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      if (url.includes(".well-known/stellar.toml")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => toml,
        });
      }
      if (url.includes("/sep24/info") || url.includes("/info")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sep24Info,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });
    });

    const offramp = new AnchorOffRamp({
      homeDomain: "testanchor.stellar.org",
      sellerKeypair: Keypair.random(),
      networkPassphrase: Networks.TESTNET,
    });

    // 1. Rejects below min_amount before quoting
    await expect(
      offramp.quote({
        sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sourceAmount: "2",
        targetCurrency: "USD",
      }),
    ).rejects.toThrow("below the anchor's minimum");

    // 2. Returns estimated fee when valid amount and no SEP-38
    // Fee = max(0.5, 1 + 100 * 2 / 100) = 3.0000
    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "100",
      targetCurrency: "USD",
    });

    expect(quote.fee.source).toBe("estimated");
    expect(quote.fee.amount).toBe("3.0000");
    expect(quote.netTargetAmount).toBe("97.0000");
  });

  it("quote() respects fee_minimum when fixed + percent is lower", async () => {
    const toml = `
      TRANSFER_SERVER_SEP24 = "https://testanchor.stellar.org/sep24"
    `;

    const sep24Info = {
      withdraw: {
        USDC: {
          enabled: true,
          fee_fixed: 0.1,
          fee_percent: 0,
          fee_minimum: 1.5,
        },
      },
    };

    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      if (url.includes(".well-known/stellar.toml")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => toml,
        });
      }
      if (url.includes("/sep24/info") || url.includes("/info")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sep24Info,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ token: "mock-jwt" }),
      });
    });

    const offramp = new AnchorOffRamp({
      homeDomain: "testanchor.stellar.org",
      sellerKeypair: Keypair.random(),
      networkPassphrase: Networks.TESTNET,
    });

    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });

    expect(quote.fee.source).toBe("estimated");
    expect(quote.fee.amount).toBe("1.5000");
    expect(quote.netTargetAmount).toBe("8.5000");
  });
});

describe.skipIf(!process.env.RUN_LIVE_ANCHOR_TESTS)(
  "AnchorOffRamp (live)",
  () => {
    it("quote(), initiate(), and status() execute SEP-24 flow against a live anchor", async () => {
      const homeDomain =
        process.env.ANCHOR_HOME_DOMAIN || "testanchor.stellar.org";
      const offramp = new AnchorOffRamp({
        homeDomain,
        sellerKeypair: Keypair.random(),
        networkPassphrase: Networks.TESTNET,
      });

      const quote = await offramp.quote({
        sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sourceAmount: "10",
        targetCurrency: "USD",
      });

      expect(Number(quote.rate)).toBeGreaterThan(0);
      expect(quote.quoteId).toBeTruthy();

      const initiation = await offramp.initiate({
        linkId: "test-link-sep24",
        quoteId: quote.quoteId,
        payout: {
          currency: "USD",
          fields: { dest: "1234567890" },
        },
      });

      expect(initiation.kind).toBe("interactive");
      expect(initiation.jobId).toBeTruthy();
      if (initiation.kind === "interactive") {
        expect(initiation.url).toBeTruthy();
      }

      const jobStatus = await offramp.status(initiation.jobId);
      expect(["pending", "settled", "failed"]).toContain(jobStatus.status);
    });
  },
);
