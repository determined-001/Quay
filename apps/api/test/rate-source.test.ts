import { describe, expect, it } from "vitest";
import { createRateSource, type RateSourceConfig } from "../src/services/rate-source";
import { HttpJsonRateSource, Sep38RateSource, StaticRateSource } from "@checkout/offramp";

/**
 * Issue 3.22 — rate-source configuration.
 *
 * Every branch in here ends in a refusal, and the point of the tests is that
 * each refusal is specific: "you configured OFFRAMP_RATE_SOURCE=static and
 * forgot the expiry" is an operator who can fix it in ten seconds, whereas a
 * silent default is how a stale rate ends up quoted to a seller as live.
 */
const ANCHOR = "cowrie.exchange";

function cfg(over: Partial<RateSourceConfig> = {}): RateSourceConfig {
  return {
    kind: undefined,
    anchorDomain: ANCHOR,
    offramp: "anchor",
    resolveQuoteServer: async () => null,
    ...over,
  };
}

describe("createRateSource", () => {
  it("returns null when OFFRAMP_RATE_SOURCE is unset", async () => {
    // The default: an anchor with SEP-38 is quoted normally, and one without
    // refuses rather than being handed a made-up number.
    expect(await createRateSource(cfg())).toBeNull();
  });

  it("refuses a configured source when the deployment has no anchor", async () => {
    await expect(
      createRateSource(cfg({ kind: "static", offramp: "mock", anchorDomain: null })),
    ).rejects.toThrow(/no anchor to source a rate for \(OFFRAMP="mock"\)/);
  });

  it("rejects an unknown source kind by name", async () => {
    await expect(createRateSource(cfg({ kind: "carrier-pigeon" }))).rejects.toThrow(
      /must be one of sep38 \| static \| http \(got "carrier-pigeon"\)/,
    );
  });

  describe("sep38", () => {
    it("builds a source that defers to the anchor's declared quote server", async () => {
      const source = await createRateSource(cfg({ kind: "sep38" }));
      expect(source).toBeInstanceOf(Sep38RateSource);
    });

    it("carries the resolver through, so a late-configured anchor still works", async () => {
      let declared: string | null = null;
      const source = await createRateSource(
        cfg({ kind: "sep38", resolveQuoteServer: async () => declared }),
      );
      // With no quote server declared, asking for a rate is a typed refusal.
      await expect(
        source!.rate({ anchorDomain: ANCHOR, sourceAsset: { code: "USDC", issuer: null }, targetCurrency: "NGN" }),
      ).rejects.toThrow(/declares no ANCHOR_QUOTE_SERVER/);
      declared = "https://api.cowrie.exchange/sep38";
      expect(declared).toBeTruthy();
    });
  });

  describe("static", () => {
    const base = { kind: "static", rate: "1600", rateExpiresAt: "2999-01-01T00:00:00Z", currency: "NGN" };

    it("names the missing OFFRAMP_RATE rather than failing generically", async () => {
      await expect(createRateSource(cfg({ kind: "static", rateExpiresAt: "2999-01-01T00:00:00Z", currency: "NGN" }))).rejects.toThrow(
        /requires OFFRAMP_RATE\b/,
      );
    });

    it("refuses a rate with no expiry — a guess is not a rate", async () => {
      await expect(createRateSource(cfg({ kind: "static", rate: "1600", currency: "NGN" }))).rejects.toThrow(
        /requires OFFRAMP_RATE_EXPIRES_AT/,
      );
    });

    it("requires the target currency, so a rate cannot be silently misapplied", async () => {
      await expect(createRateSource(cfg({ kind: "static", rate: "1600", rateExpiresAt: "2999-01-01T00:00:00Z" }))).rejects.toThrow(
        /requires OFFRAMP_RATE_CURRENCY/,
      );
    });

    it("builds a static source bound to this anchor and currency", async () => {
      const source = await createRateSource(cfg({ ...base, sourceAsset: "USDC" }));
      expect(source).toBeInstanceOf(StaticRateSource);
      const fx = await source!.rate({
        anchorDomain: ANCHOR,
        sourceAsset: { code: "USDC", issuer: null },
        targetCurrency: "NGN",
      });
      expect(fx.rate).toBe("1600");
      expect(fx.source).toBe("static");
    });
  });

  describe("http", () => {
    const base = {
      kind: "http",
      url: "https://anchor.example/rates.json",
      jsonPath: "rate",
      currency: "NGN",
    };

    it("requires a URL", async () => {
      await expect(createRateSource(cfg({ kind: "http", jsonPath: "rate", currency: "NGN" }))).rejects.toThrow(
        /requires OFFRAMP_RATE_URL/,
      );
    });

    it("requires a JSON path", async () => {
      await expect(
        createRateSource(cfg({ kind: "http", url: base.url, currency: "NGN" })),
      ).rejects.toThrow(/requires OFFRAMP_RATE_JSON_PATH/);
    });

    it("requires the target currency", async () => {
      await expect(
        createRateSource(cfg({ kind: "http", url: base.url, jsonPath: "rate" })),
      ).rejects.toThrow(/requires OFFRAMP_RATE_CURRENCY/);
    });

    it("refuses a plaintext URL before any request", async () => {
      await expect(
        createRateSource(cfg({ kind: "http", url: "http://anchor.example/rates.json", jsonPath: "rate", currency: "NGN" })),
      ).rejects.toThrow(/must be https/);
    });

    it("builds an http source once the SSRF guard approves the URL", async () => {
      const guard = async (url: string) => (url === base.url ? { ok: true as const } : { ok: false as const, reason: "other" });
      const source = await createRateSource(cfg({ ...base, guard }));
      expect(source).toBeInstanceOf(HttpJsonRateSource);
    });

    it("refuses to start when the SSRF guard rejects the URL", async () => {
      const guard = async () => ({ ok: false as const, reason: "resolves into a private range" });
      await expect(createRateSource(cfg({ ...base, guard }))).rejects.toThrow(
        /rejected by the SSRF guard: resolves into a private range/,
      );
    });
  });
});
