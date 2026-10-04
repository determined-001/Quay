import { afterEach, describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { parseStellarToml } from "../src/sep1";
import { getSep6Info, resolveWithdrawType } from "../src/sep6";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TestAnchorOffRamp } from "../src/testanchor";
import { fixtureFetch, loadFixtures } from "./fixture-fetch";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

/** The NGNT issuer Cowrie lists in its recorded stellar.toml (test/fixtures/cowrie.exchange). */
const COWRIE_NGNT_ISSUER = "GAWODAROMJ33V5YDFY3NPYTHVYQG7MJXVJ2ND3AOGIHYRWINES6ACCPD";
const SELLER = { sellerId: "sel_compat", account: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };

function makeAdapter(
  domain: string,
  fallbackBaseUrl: string,
  networkPassphrase: string,
  sessions = new FakeAnchorSessionRepository(),
) {
  const discovery = new AnchorDiscovery({
    homeDomain: domain,
    fallbackBaseUrl,
    expectedNetworkPassphrase: networkPassphrase,
  });
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase });
  return new TestAnchorOffRamp({ discovery, auth, state: new FakeOffRampStateRepository() });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anchor Fixture Compatibility Suite (#221)", () => {
  describe("testanchor.stellar.org (testnet sandbox with full SEP stack)", () => {
    const domain = "testanchor.stellar.org";
    const fixtures = loadFixtures(domain);

    it("parses stellar.toml with declared endpoints and testnet passphrase", () => {
      const parsed = parseStellarToml(fixtures.toml, domain);
      expect(parsed.signingKey).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
      expect(parsed.networkPassphrase).toContain("Test SDF Network");
      expect(parsed.transferServer).toBe("https://testanchor.stellar.org/sep6");
      expect(parsed.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
      expect(parsed.kycServer).toBe("https://testanchor.stellar.org/sep12");
    });

    it("discovers SEP-6 withdraw info and resolves a withdraw type with preferredType", async () => {
      vi.stubGlobal("fetch", fixtureFetch(domain));
      const info = await getSep6Info("https://testanchor.stellar.org/sep6");
      expect(info.withdraw.USDC).toBeDefined();
      expect(info.withdraw.USDC.enabled).toBe(true);

      const resolved = await resolveWithdrawType("https://testanchor.stellar.org/sep6", "USDC", "5", "bank_account");
      expect(resolved.type).toBe("bank_account");
      expect(resolved.typeInfo).toBeDefined();
    });

    it("exposes offrampRequirements via TestAnchorOffRamp using recorded fixtures", async () => {
      vi.stubGlobal("fetch", fixtureFetch(domain));
      const adapter = makeAdapter(domain, "https://testanchor.stellar.org", Networks.TESTNET);

      const reqs = await adapter.offrampRequirements("USDC");
      expect(reqs.types.length).toBeGreaterThan(0);
      expect(reqs.types.some((t) => t.name === "bank_account")).toBe(true);
    });
  });

  describe("cowrie.exchange (production anchor without SEP-38)", () => {
    const domain = "cowrie.exchange";
    const fixtures = loadFixtures(domain);

    it("parses stellar.toml with declared endpoints and pubnet passphrase", () => {
      const parsed = parseStellarToml(fixtures.toml, domain);
      expect(parsed.signingKey).toBe("GBQZOJE2GWJU5VBT6NBLD2F3IOVOYUBDAXYUU32XMHDF4RMDOURWV3GT");
      expect(parsed.networkPassphrase).toBe("Public Global Stellar Network ; September 2015");
      expect(parsed.transferServer).toBe("https://api.cowrie.exchange/transfer");
      expect(parsed.webAuthEndpoint).toBe("https://api.cowrie.exchange/web_auth");
      expect(parsed.kycServer).toBe("https://api.cowrie.exchange/kyc");
    });

    it("discovers SEP-6 withdraw capability for NGNT and resolves withdraw type", async () => {
      vi.stubGlobal("fetch", fixtureFetch(domain));
      const info = await getSep6Info("https://api.cowrie.exchange/transfer");
      expect(info.withdraw.NGNT).toBeDefined();
      expect(info.withdraw.NGNT.enabled).toBe(true);

      const resolved = await resolveWithdrawType("https://api.cowrie.exchange/transfer", "NGNT", "500");
      expect(resolved.type).toBe("bank_account");
      expect(resolved.typeInfo.fields.dest).toBeDefined();
    });

    it("exposes field descriptors for NGNT on Cowrie", async () => {
      vi.stubGlobal("fetch", fixtureFetch(domain));
      const adapter = makeAdapter(domain, "https://api.cowrie.exchange", Networks.PUBLIC);

      const reqs = await adapter.offrampRequirements("NGNT");
      const bank = reqs.types.find((t) => t.name === "bank_account");
      expect(bank).toBeDefined();
      expect(bank!.descriptors.some((f) => f.name === "dest")).toBe(true);
      expect(bank!.descriptors.some((f) => f.name === "dest_extra")).toBe(true);
    });

    it("fails requests to endpoints outside the recorded fixture set (e.g. unadvertised SEP-38)", async () => {
      const stub = fixtureFetch(domain);
      await expect(stub("https://cowrie.exchange/sep38/prices")).rejects.toThrow(/Unexpected unmocked network request/);
    });

    // Gap recorded for Issue 3.22: Calling quote() on an anchor without ANCHOR_QUOTE_SERVER
    // currently guesses /sep38 and will fail because the anchor never published SEP-38.
    it.fails("calling quote() against an anchor with no SEP-38 fails until 3.22 fallback lands", async () => {
      vi.stubGlobal("fetch", fixtureFetch(domain));
      // quote() needs the seller signed in at the anchor (their own SEP-10 session).
      const sessions = new FakeAnchorSessionRepository();
      await sessions.save({
        sellerId: SELLER.sellerId,
        anchorDomain: domain,
        account: SELLER.account,
        token: "test-jwt",
        expiresAt: Date.now() + 60 * 60_000,
        createdAt: Date.now(),
      });
      const adapter = makeAdapter(domain, "https://api.cowrie.exchange", Networks.PUBLIC, sessions);

      // NGNT is listed in Cowrie's TOML, so this gets past the currency check and reaches SEP-38,
      // which Cowrie never published: the adapter guesses /sep38 and the fixture fetch refuses it.
      await adapter.quote({
        linkId: "lnk_compat",
        sourceAsset: { code: "NGNT", issuer: COWRIE_NGNT_ISSUER },
        sourceAmount: "500", // inside Cowrie's published limits, so the limits check passes
        targetCurrency: "NGN",
        customer: SELLER,
      });
    });
  });

  // Issue 3.24 asks for a SEP-6 /info shape the recorded anchors do not exercise: newer anchors can
  // publish `funding_methods` instead of per-type `types`. getSep6Info reads only `types`, so such an
  // anchor looks like it offers no way to withdraw. Recorded as an expected failure (not parsed yet),
  // so the gap is visible and flips to a real failure once parsing is added.
  describe("SEP-6 /info shapes beyond the recorded fixtures", () => {
    it.fails("resolves a withdraw type from an anchor that publishes funding_methods instead of types", async () => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              withdraw: { USDC: { enabled: true, min_amount: 1, funding_methods: ["bank_account"] } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );

      // a base URL no other test uses, so getSep6Info's per-URL cache cannot hide the shape
      const resolved = await resolveWithdrawType("https://funding-methods.example/sep6", "USDC", "10");

      expect(resolved.type).toBe("bank_account");
    });
  });
});
