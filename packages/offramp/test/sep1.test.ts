import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearStellarTomlCache,
  fetchStellarToml,
  listsCurrency,
  parseStellarToml,
  Sep1NetworkMismatchError,
} from "../src/sep1";

const TOML = `
ACCOUNTS = [ "GABC" ]
VERSION = "2.0.0"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://anchor.example/auth"
TRANSFER_SERVER = "https://anchor.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"
ANCHOR_QUOTE_SERVER = "https://anchor.example/sep38"
KYC_SERVER = "https://anchor.example/sep12"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

[[CURRENCIES]]
code = "EURC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

function tomlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("parseStellarToml", () => {
  it("reads every endpoint, the signing key, the passphrase and the currencies", () => {
    const p = parseStellarToml(TOML, "anchor.example");
    expect(p.webAuthEndpoint).toBe("https://anchor.example/auth");
    expect(p.transferServer).toBe("https://anchor.example/sep6");
    expect(p.transferServerSep24).toBe("https://anchor.example/sep24");
    expect(p.anchorQuoteServer).toBe("https://anchor.example/sep38");
    expect(p.kycServer).toBe("https://anchor.example/sep12");
    expect(p.signingKey).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
    expect(p.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(p.currencies).toEqual(["USDC", "EURC"]);
    expect(p.fallback).toBe(false);
  });

  it("does not mistake a key inside [[CURRENCIES]] for a top-level one", () => {
    const p = parseStellarToml(
      `SIGNING_KEY = "GTOP"\n\n[[CURRENCIES]]\ncode = "USDC"\nSIGNING_KEY = "GNESTED"\n`,
      "anchor.example",
    );
    expect(p.signingKey).toBe("GTOP");
    expect(p.currencies).toEqual(["USDC"]);
  });

  it("falls back to the transfer server for SEP-12 when KYC_SERVER is absent", () => {
    // The spec says an anchor without KYC_SERVER serves SEP-12 from its
    // transfer server; guessing /sep12 would 404.
    const p = parseStellarToml(`TRANSFER_SERVER = "https://anchor.example/api/sep6"\n`, "anchor.example");
    expect(p.kycServer).toBe("https://anchor.example/api/sep6");
  });

  it("strips quotes and trailing comments", () => {
    const p = parseStellarToml(`SIGNING_KEY = "GABC" # the anchor's key\n`, "anchor.example");
    expect(p.signingKey).toBe("GABC");
  });
});

describe("fetchStellarToml", () => {
  beforeEach(() => clearStellarTomlCache());
  afterEach(() => vi.unstubAllGlobals());

  it("caches, so a second call inside the TTL does not re-fetch", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    const a = await fetchStellarToml("anchor.example");
    const b = await fetchStellarToml("anchor.example");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("refuses an anchor whose declared network is not ours", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tomlResponse(TOML)));

    await expect(
      fetchStellarToml("anchor.example", { expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015" }),
    ).rejects.toBeInstanceOf(Sep1NetworkMismatchError);
  });

  it("falls back to guessed paths when the TOML cannot be fetched, and does not cache that", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tomlResponse("nope", 500))
      .mockResolvedValueOnce(tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    const bad = await fetchStellarToml("anchor.example");
    expect(bad.fallback).toBe(true);
    expect(bad.signingKey).toBeNull();
    expect(bad.transferServer).toBe("https://anchor.example/sep6");

    // A transient outage must not pin guessed endpoints for the whole TTL.
    const good = await fetchStellarToml("anchor.example");
    expect(good.fallback).toBe(false);
    expect(good.signingKey).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
  });
});

describe("listsCurrency", () => {
  const info = parseStellarToml(TOML, "anchor.example");

  it("matches case-insensitively", () => {
    expect(listsCurrency(info, "usdc")).toBe(true);
  });

  it("rejects an asset the anchor does not list", () => {
    expect(listsCurrency(info, "BRL")).toBe(false);
  });

  it("passes anything when the anchor declares no currencies at all", () => {
    // Silence is not a denial — plenty of anchors omit the block entirely.
    const none = parseStellarToml(`SIGNING_KEY = "GABC"\n`, "anchor.example");
    expect(listsCurrency(none, "BRL")).toBe(true);
  });
});
