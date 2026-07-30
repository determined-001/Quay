import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCurrencySupported, resolveAnchor } from "../src/anchor";
import { clearStellarTomlCache, StellarTomlError } from "../src/sep1";
import { endpoint } from "../src/endpoint";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR";

const FULL_TOML = `
SIGNING_KEY = "${SIGNING_KEY}"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
KYC_SERVER = "https://testanchor.stellar.org/sep12"
TRANSFER_SERVER = "https://testanchor.stellar.org/sep6"
ANCHOR_QUOTE_SERVER = "https://testanchor.stellar.org/sep38"

[[CURRENCIES]]
code = "USDC"
issuer = "${USDC_ISSUER}"
status = "test"
`;

function tomlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

function collectingLogger(): { warn(m: string): void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

beforeEach(() => clearStellarTomlCache());
afterEach(() => {
  clearStellarTomlCache();
  vi.unstubAllGlobals();
});

describe("endpoint()", () => {
  it("APPENDS the SEP path to a service URL instead of resolving it as absolute", () => {
    // `new URL("/quote", "https://a.com/sep38")` would give https://a.com/quote,
    // silently discarding the path the anchor advertised. That is the bug this
    // helper exists to prevent.
    expect(endpoint("https://a.com/sep38", "quote").toString()).toBe("https://a.com/sep38/quote");
    expect(endpoint("https://a.com/sep6", "transaction").toString()).toBe("https://a.com/sep6/transaction");
  });

  it("normalizes slashes on both sides", () => {
    expect(endpoint("https://a.com/sep38/", "/quote").toString()).toBe("https://a.com/sep38/quote");
    expect(endpoint("https://a.com", "customer").toString()).toBe("https://a.com/customer");
  });

  it("appends query params, skipping undefined ones", () => {
    const url = endpoint("https://a.com/sep6", "withdraw", {
      asset_code: "USDC",
      dest: undefined,
      amount: "10",
    });
    expect(url.searchParams.get("asset_code")).toBe("USDC");
    expect(url.searchParams.get("amount")).toBe("10");
    expect(url.searchParams.has("dest")).toBe(false);
  });
});

describe("resolveAnchor", () => {
  it("resolves every endpoint from the TOML, with no fallbacks and no warnings", async () => {
    const logger = collectingLogger();
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(FULL_TOML));

    const anchor = await resolveAnchor("testanchor.stellar.org", { fetchImpl: fetchMock, logger });

    expect(anchor.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(anchor.kycServer).toBe("https://testanchor.stellar.org/sep12");
    expect(anchor.transferServer).toBe("https://testanchor.stellar.org/sep6");
    expect(anchor.anchorQuoteServer).toBe("https://testanchor.stellar.org/sep38");
    expect(anchor.signingKey).toBe(SIGNING_KEY);
    expect(anchor.fellBackFor).toEqual([]);
    expect(logger.messages).toEqual([]);
  });

  it("honours a TOML that publishes endpoints on a completely different layout", async () => {
    // The point of SEP-1: an anchor that looks nothing like testanchor still works
    // with zero code changes.
    const exotic = `
SIGNING_KEY = "${SIGNING_KEY}"
WEB_AUTH_ENDPOINT = "https://auth.other-anchor.io/v3/web_authenticate"
KYC_SERVER = "https://kyc.other-anchor.io/customers/api"
TRANSFER_SERVER = "https://rails.other-anchor.io/transfer/v1"
ANCHOR_QUOTE_SERVER = "https://fx.other-anchor.io/quotes"
`;
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(exotic));
    const anchor = await resolveAnchor("other-anchor.io", { fetchImpl: fetchMock });

    expect(anchor.webAuthEndpoint).toBe("https://auth.other-anchor.io/v3/web_authenticate");
    expect(anchor.transferServer).toBe("https://rails.other-anchor.io/transfer/v1");
    expect(anchor.anchorQuoteServer).toBe("https://fx.other-anchor.io/quotes");
    expect(anchor.fellBackFor).toEqual([]);
  });

  it("falls back to the hard-coded path ONLY for a missing entry, and warns about it", async () => {
    const partial = `
SIGNING_KEY = "${SIGNING_KEY}"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
TRANSFER_SERVER = "https://a.example/sep6"
`;
    const logger = collectingLogger();
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(partial));

    const anchor = await resolveAnchor("a.example", { fetchImpl: fetchMock, logger });

    // Present entries are still taken from the TOML.
    expect(anchor.webAuthEndpoint).toBe("https://a.example/auth");
    expect(anchor.transferServer).toBe("https://a.example/sep6");
    // Absent ones fall back — and say so.
    expect(anchor.fellBackFor.sort()).toEqual(["anchorQuoteServer", "kycServer"]);
    expect(anchor.kycServer).toBe("https://a.example/sep12");
    expect(anchor.anchorQuoteServer).toBe("https://a.example/sep38");
    expect(logger.messages.join("\n")).toMatch(/publishes no KYC_SERVER/);
    expect(logger.messages.join("\n")).toMatch(/publishes no ANCHOR_QUOTE_SERVER/);
    expect(logger.messages.join("\n")).toMatch(/falling back to the hard-coded path/);
  });

  it("warns loudly when the anchor publishes no SIGNING_KEY", async () => {
    const logger = collectingLogger();
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(`WEB_AUTH_ENDPOINT = "https://a.example/auth"`));

    const anchor = await resolveAnchor("a.example", { fetchImpl: fetchMock, logger });

    expect(anchor.signingKey).toBeNull();
    expect(logger.messages.join("\n")).toMatch(/publishes no SIGNING_KEY/);
    expect(logger.messages.join("\n")).toMatch(/refused rather than signed/);
  });

  it("rejects an anchor on the wrong network before returning any endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(FULL_TOML));
    await expect(
      resolveAnchor("testanchor.stellar.org", {
        fetchImpl: fetchMock,
        expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    ).rejects.toThrow(/network mismatch/i);
  });
});

describe("assertCurrencySupported", () => {
  async function anchorFrom(toml: string) {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(toml));
    return resolveAnchor("a.example", { fetchImpl: fetchMock, logger: collectingLogger() });
  }

  it("passes for an asset the anchor lists", async () => {
    const anchor = await anchorFrom(FULL_TOML);
    expect(() => assertCurrencySupported(anchor, { code: "USDC", issuer: USDC_ISSUER })).not.toThrow();
  });

  it("throws for the right code under an issuer the anchor never listed", async () => {
    const anchor = await anchorFrom(FULL_TOML);
    // A look-alike USDC. Without this check it would fail later as an opaque
    // SEP-6 rejection, or worse, be accepted.
    expect(() =>
      assertCurrencySupported(anchor, { code: "USDC", issuer: "GFAKEISSUER00000000000000000000000000000000000000000000" }),
    ).toThrow(StellarTomlError);
    expect(() => assertCurrencySupported(anchor, { code: "EURC", issuer: USDC_ISSUER })).toThrow(
      /does not list/,
    );
  });

  it("names what the anchor does advertise, to make the error actionable", async () => {
    const anchor = await anchorFrom(FULL_TOML);
    expect(() => assertCurrencySupported(anchor, { code: "NGN", issuer: USDC_ISSUER })).toThrow(
      /It advertises: USDC:GBBD47IF/,
    );
  });

  it("throws for a listed-but-dead asset", async () => {
    const anchor = await anchorFrom(`
SIGNING_KEY = "${SIGNING_KEY}"
[[CURRENCIES]]
code = "OLD"
issuer = "${USDC_ISSUER}"
status = "dead"
`);
    expect(() => assertCurrencySupported(anchor, { code: "OLD", issuer: USDC_ISSUER })).toThrow(
      /no longer redeemable/,
    );
  });

  it("treats an absent CURRENCIES list as unknown, not unsupported — warns and proceeds", async () => {
    // SEP-1 allows CURRENCIES to live at a separate URL we don't follow, so
    // absence must not block a withdrawal that would otherwise succeed.
    const anchor = await anchorFrom(`SIGNING_KEY = "${SIGNING_KEY}"`);
    const logger = collectingLogger();
    expect(() => assertCurrencySupported(anchor, { code: "USDC", issuer: USDC_ISSUER }, logger)).not.toThrow();
    expect(logger.messages.join("\n")).toMatch(/lists no CURRENCIES/);
  });
});
