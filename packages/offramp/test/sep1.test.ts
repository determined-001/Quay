import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStellarTomlCache,
  fetchStellarToml,
  findCurrency,
  normalizeHomeDomain,
  parseToml,
  StellarTomlError,
} from "../src/sep1";

const TESTNET = "Test SDF Network ; September 2015";
const PUBLIC = "Public Global Stellar Network ; September 2015";

// A faithful slice of the real https://testanchor.stellar.org/.well-known/stellar.toml.
const TESTANCHOR_TOML = `
ACCOUNTS = ["GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE"]
VERSION = "0.1.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"

WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
KYC_SERVER = "https://testanchor.stellar.org/sep12"
TRANSFER_SERVER = "https://testanchor.stellar.org/sep6"
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
ANCHOR_QUOTE_SERVER = "https://testanchor.stellar.org/sep38"

[[CURRENCIES]]
code = "SRT"
issuer = "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B"
status = "test"
is_asset_anchored = false

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
status = "test"
is_asset_anchored = false
desc = "Circle USDC Token"

[[CURRENCIES]]
code = "native"
status = "test"

[DOCUMENTATION]
ORG_NAME = "Stellar Development Foundation"
ORG_URL = "https://stellar.org"
`;

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function tomlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

beforeEach(() => {
  clearStellarTomlCache();
});

afterEach(() => {
  clearStellarTomlCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseToml — the SEP-1 subset", () => {
  it("parses top-level scalars, arrays of tables, and sub-tables", () => {
    const t = parseToml(TESTANCHOR_TOML);

    expect(t.SIGNING_KEY).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
    expect(t.WEB_AUTH_ENDPOINT).toBe("https://testanchor.stellar.org/auth");
    expect(t.ACCOUNTS).toEqual(["GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE"]);
    expect(Array.isArray(t.CURRENCIES)).toBe(true);
    expect((t.CURRENCIES as unknown[]).length).toBe(3);
    expect((t.DOCUMENTATION as Record<string, unknown>).ORG_NAME).toBe("Stellar Development Foundation");
  });

  it("keeps each [[CURRENCIES]] entry separate rather than merging them", () => {
    const currencies = parseToml(TESTANCHOR_TOML).CURRENCIES as Array<Record<string, unknown>>;
    expect(currencies.map((c) => c.code)).toEqual(["SRT", "USDC", "native"]);
    // A merge bug would leak SRT's issuer into USDC — that would send a real
    // withdrawal to the wrong asset.
    expect(currencies[1]?.issuer).toBe(USDC_ISSUER);
    expect(currencies[2]?.issuer).toBeUndefined();
  });

  it("parses booleans, integers, floats and strips comments", () => {
    const t = parseToml(`
# leading comment
enabled = true          # trailing comment
disabled = false
count = 42
ratio = 1.5
neg = -7
underscored = 1_000
hash_in_string = "not # a comment"
`);
    expect(t.enabled).toBe(true);
    expect(t.disabled).toBe(false);
    expect(t.count).toBe(42);
    expect(t.ratio).toBe(1.5);
    expect(t.neg).toBe(-7);
    expect(t.underscored).toBe(1000);
    expect(t.hash_in_string).toBe("not # a comment");
  });

  it("handles multi-line arrays, multi-line strings, and escapes", () => {
    const t = parseToml(`
ACCOUNTS = [
  "GAAA",
  "GBBB",   # inline comment inside the array
]
ORG_DESCRIPTION = """
line one
line two"""
literal = 'C:\\not\\escaped'
escaped = "tab\\there"
`);
    expect(t.ACCOUNTS).toEqual(["GAAA", "GBBB"]);
    expect(t.ORG_DESCRIPTION).toBe("line one\nline two");
    expect(t.literal).toBe("C:\\not\\escaped");
    expect(t.escaped).toBe("tab\there");
  });

  it("supports dotted keys and quoted table names", () => {
    const t = parseToml(`
[a.b]
c = 1
["quoted.name"]
d = 2
`);
    expect(((t.a as Record<string, unknown>).b as Record<string, unknown>).c).toBe(1);
    expect((t["quoted.name"] as Record<string, unknown>).d).toBe(2);
  });

  it("throws on a line that is neither a table, a comment, nor an assignment", () => {
    expect(() => parseToml("this is not toml")).toThrow(/unparsable line/);
  });
});

describe("normalizeHomeDomain", () => {
  it("reduces scheme, path, port and case to a bare host so cache keys agree", () => {
    expect(normalizeHomeDomain("https://testanchor.stellar.org/.well-known/stellar.toml")).toBe(
      "testanchor.stellar.org",
    );
    expect(normalizeHomeDomain("TestAnchor.Stellar.Org")).toBe("testanchor.stellar.org");
    expect(normalizeHomeDomain("testanchor.stellar.org:443")).toBe("testanchor.stellar.org");
    expect(normalizeHomeDomain("  testanchor.stellar.org.  ")).toBe("testanchor.stellar.org");
  });

  it("rejects an empty domain rather than fetching https:///.well-known/stellar.toml", () => {
    expect(() => normalizeHomeDomain("   ")).toThrow(StellarTomlError);
    expect(() => normalizeHomeDomain("https://")).toThrow(StellarTomlError);
  });
});

describe("fetchStellarToml", () => {
  it("fetches /.well-known/stellar.toml over https and maps every endpoint we need", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));

    const toml = await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://testanchor.stellar.org/.well-known/stellar.toml");
    expect(toml.signingKey).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
    expect(toml.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(toml.transferServer).toBe("https://testanchor.stellar.org/sep6");
    expect(toml.kycServer).toBe("https://testanchor.stellar.org/sep12");
    expect(toml.anchorQuoteServer).toBe("https://testanchor.stellar.org/sep38");
    expect(toml.networkPassphrase).toBe(TESTNET);
    expect(toml.currencies).toHaveLength(3);
  });

  it("caches for 5 minutes, then refetches once the TTL expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));

    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });
    await fetchStellarToml("TESTANCHOR.stellar.org/", { fetchImpl: fetchMock }); // same domain, normalized
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4 * 60 * 1000);
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 1000); // now past 5 minutes
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent cold-cache callers into a single request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));

    const [a, b, c] = await Promise.all([
      fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock }),
      fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock }),
      fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.signingKey).toBe(b.signingKey);
    expect(b.signingKey).toBe(c.signingKey);
  });

  it("forceRefresh bypasses a warm cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock, forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an anchor whose NETWORK_PASSPHRASE is a different network", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));

    await expect(
      fetchStellarToml("testanchor.stellar.org", {
        fetchImpl: fetchMock,
        expectedNetworkPassphrase: PUBLIC,
      }),
    ).rejects.toThrow(/network mismatch/i);
  });

  it("accepts a matching NETWORK_PASSPHRASE, and tolerates one that is absent", async () => {
    const matching = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));
    await expect(
      fetchStellarToml("a.example", { fetchImpl: matching, expectedNetworkPassphrase: TESTNET }),
    ).resolves.toMatchObject({ networkPassphrase: TESTNET });

    // SEP-1 does not require NETWORK_PASSPHRASE, so absent is not a mismatch.
    const silent = vi.fn().mockResolvedValue(tomlResponse(`WEB_AUTH_ENDPOINT = "https://b.example/auth"`));
    await expect(
      fetchStellarToml("b.example", { fetchImpl: silent, expectedNetworkPassphrase: TESTNET }),
    ).resolves.toMatchObject({ networkPassphrase: null });
  });

  it("still enforces the network check on a cache hit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(TESTANCHOR_TOML));
    await fetchStellarToml("testanchor.stellar.org", { fetchImpl: fetchMock });

    // Cached from the testnet caller above; a public-network caller must not
    // silently inherit it.
    await expect(
      fetchStellarToml("testanchor.stellar.org", {
        fetchImpl: fetchMock,
        expectedNetworkPassphrase: PUBLIC,
      }),
    ).rejects.toThrow(/network mismatch/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a typed StellarTomlError on a non-200, and does not cache the failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tomlResponse("not found", 404))
      .mockResolvedValueOnce(tomlResponse(TESTANCHOR_TOML));

    await expect(fetchStellarToml("nope.example", { fetchImpl: fetchMock })).rejects.toBeInstanceOf(
      StellarTomlError,
    );
    // A transient failure must not poison the cache for 5 minutes.
    await expect(fetchStellarToml("nope.example", { fetchImpl: fetchMock })).resolves.toMatchObject({
      signingKey: expect.any(String),
    });
  });

  it("wraps a network error and names the domain", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(fetchStellarToml("gone.example", { fetchImpl: fetchMock })).rejects.toThrow(
      /gone\.example.*ENOTFOUND/s,
    );
  });

  it("rejects a document over the 100 KB SEP-1 limit", async () => {
    const huge = `SIGNING_KEY = "G..."\n# ${"x".repeat(101 * 1024)}`;
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse(huge));
    await expect(fetchStellarToml("big.example", { fetchImpl: fetchMock })).rejects.toThrow(/100 KB/);
  });

  it("reports unparsable TOML as a discovery failure rather than crashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tomlResponse("<html>404 not found</html>"));
    await expect(fetchStellarToml("html.example", { fetchImpl: fetchMock })).rejects.toThrow(
      /not valid TOML/,
    );
  });
});

describe("findCurrency", () => {
  const toml = {
    homeDomain: "testanchor.stellar.org",
    signingKey: null,
    networkPassphrase: null,
    webAuthEndpoint: null,
    transferServer: null,
    transferServerSep24: null,
    kycServer: null,
    anchorQuoteServer: null,
    currencies: [
      { code: "USDC", issuer: USDC_ISSUER, status: "test", isAssetAnchored: false, anchorAssetType: null, desc: null },
      { code: "native", issuer: null, status: "test", isAssetAnchored: false, anchorAssetType: null, desc: null },
    ],
    raw: {},
  };

  it("matches on code AND issuer together", () => {
    expect(findCurrency(toml, { code: "USDC", issuer: USDC_ISSUER })).toMatchObject({ code: "USDC" });
  });

  it("returns null for the right code under the wrong issuer", () => {
    // The dangerous case: a look-alike USDC from an issuer the anchor never listed.
    expect(findCurrency(toml, { code: "USDC", issuer: "GDIFFERENTISSUER" })).toBeNull();
  });

  it("resolves the native asset to the `native` entry", () => {
    expect(findCurrency(toml, { code: "XLM", issuer: null })).toMatchObject({ code: "native" });
  });

  it("returns undefined (unknown, not unsupported) when no CURRENCIES are listed", () => {
    expect(findCurrency({ ...toml, currencies: [] }, { code: "USDC", issuer: USDC_ISSUER })).toBeUndefined();
  });
});
