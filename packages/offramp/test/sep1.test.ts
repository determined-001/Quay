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

  it("accepts the alternate key spellings some anchors publish", () => {
    // WEB_AUTH_URL and TRANSFER_SERVER_SEP24 are the same two endpoints under
    // the names anchors actually use; removing the SEP-24 adapter (#207) must
    // not remove the parsing of its discovery key with it.
    const p = parseStellarToml(
      `WEB_AUTH_URL = "https://anchor.example/auth"\nTRANSFER_SERVER_SEP24 = "https://anchor.example/sep24"\n`,
      "anchor.example",
    );
    expect(p.webAuthEndpoint).toBe("https://anchor.example/auth");
    expect(p.transferServerSep24).toBe("https://anchor.example/sep24");
  });

  it("parses CRLF line endings identically to LF", () => {
    const lf = parseStellarToml(TOML, "anchor.example");
    const crlf = parseStellarToml(TOML.replace(/\n/g, "\r\n"), "anchor.example");
    expect(crlf).toEqual(lf);
  });

  it("recognises lower-case [[currencies]] as the currency block", () => {
    const toml = `[[currencies]]\ncode = "USDC"\n[[currencies]]\ncode = "EURC"\n`;
    const p = parseStellarToml(toml, "anchor.example");
    expect(p.currencies).toEqual(["USDC", "EURC"]);
  });

  it("ends the currency block on a different table header and resumes on subsequent [[CURRENCIES]]", () => {
    const toml = [
      "[[CURRENCIES]]",
      'code = "USDC"',
      "[DOCUMENTATION]",
      'code = "NOT_A_CURRENCY"',
      "[[CURRENCIES]]",
      'code = "EURC"',
    ].join("\n");
    const p = parseStellarToml(toml, "anchor.example");
    expect(p.currencies).toEqual(["USDC", "EURC"]);
  });

  it("retains an explicit KYC_SERVER that equals the guessed path rather than falling back to transfer server", () => {
    // Guess for anchor.example is https://anchor.example/sep12. If KYC_SERVER was
    // absent, it would fall back to TRANSFER_SERVER (https://anchor.example/sep6).
    // An explicitly declared KYC_SERVER equal to the guess must remain set.
    const toml = [
      'TRANSFER_SERVER = "https://anchor.example/sep6"',
      'KYC_SERVER = "https://anchor.example/sep12"',
    ].join("\n");
    const p = parseStellarToml(toml, "anchor.example");
    expect(p.kycServer).toBe("https://anchor.example/sep12");
  });
});

describe("fetchStellarToml", () => {
  beforeEach(() => clearStellarTomlCache());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caches, so a second call inside the TTL does not re-fetch", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    const a = await fetchStellarToml("anchor.example");
    const b = await fetchStellarToml("anchor.example");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("expires the cache after 5 minutes (TTL expiry)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    await fetchStellarToml("anchor.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Just under 5 minutes: cache hit, no new fetch
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await fetchStellarToml("anchor.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past 5 minutes (TTL expired): re-fetches
    await vi.advanceTimersByTimeAsync(2);
    await fetchStellarToml("anchor.example");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("force: true re-fetches inside the TTL and updates the cache", async () => {
    const toml1 = `SIGNING_KEY = "GKEY1"\n`;
    const toml2 = `SIGNING_KEY = "GKEY2"\n`;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tomlResponse(toml1))
      .mockResolvedValueOnce(tomlResponse(toml2));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchStellarToml("anchor.example");
    expect(first.signingKey).toBe("GKEY1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Force re-fetch inside TTL
    const forced = await fetchStellarToml("anchor.example", { force: true });
    expect(forced.signingKey).toBe("GKEY2");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Next unforced call returns the updated cached result without fetching
    const cached = await fetchStellarToml("anchor.example");
    expect(cached.signingKey).toBe("GKEY2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a response when expectedNetworkPassphrase mismatches", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchStellarToml("anchor.example", { expectedNetworkPassphrase: "Wrong Network Passphrase" }),
    ).rejects.toBeInstanceOf(Sep1NetworkMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Subsequent call without passphrase fetches again rather than reusing mismatch
    const ok = await fetchStellarToml("anchor.example");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ok.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("refuses an anchor whose declared network is not ours", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tomlResponse(TOML)));

    await expect(
      fetchStellarToml("anchor.example", { expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015" }),
    ).rejects.toBeInstanceOf(Sep1NetworkMismatchError);
  });

  it("refuses a cached anchor when subsequent caller specifies a mismatching network passphrase without re-fetching", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    // Call without passphrase populates the cache
    const first = await fetchStellarToml("anchor.example");
    expect(first.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Subsequent call with mismatching passphrase throws Sep1NetworkMismatchError without hitting network
    await expect(
      fetchStellarToml("anchor.example", {
        expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    ).rejects.toBeInstanceOf(Sep1NetworkMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves from cache when subsequent caller specifies a matching network passphrase", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchStellarToml("anchor.example");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await fetchStellarToml("anchor.example", {
      expectedNetworkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("accepts a document that declares no NETWORK_PASSPHRASE for any expected passphrase", async () => {
    const tomlWithoutPassphrase = `
ACCOUNTS = [ "GABC" ]
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
TRANSFER_SERVER = "https://anchor.example/sep6"
`;
    const fetchMock = vi.fn(async () => tomlResponse(tomlWithoutPassphrase));
    vi.stubGlobal("fetch", fetchMock);

    const info = await fetchStellarToml("anchor.example", {
      expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
    });
    expect(info.networkPassphrase).toBeNull();
    expect(info.transferServer).toBe("https://anchor.example/sep6");

    // Also on cache hit
    const cachedInfo = await fetchStellarToml("anchor.example", {
      expectedNetworkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedInfo).toEqual(info);
  });

  it("does not cache a document when fresh fetch fails network passphrase check", async () => {
    const fetchMock = vi.fn(async () => tomlResponse(TOML));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchStellarToml("anchor.example", {
        expectedNetworkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    ).rejects.toBeInstanceOf(Sep1NetworkMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call re-fetches because mismatch was not cached
    const second = await fetchStellarToml("anchor.example", {
      expectedNetworkPassphrase: "Test SDF Network ; September 2015",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.networkPassphrase).toBe("Test SDF Network ; September 2015");
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

  it("falls back to guessed paths when the TOML fetch times out, and does not pin the fallback", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((_url, init) => {
          return new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }
          });
        }),
      );

      const fetchPromise = fetchStellarToml("anchor.example", { timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      const fallback = await fetchPromise;

      expect(fallback.fallback).toBe(true);
      expect(fallback.webAuthEndpoint).toBe("https://anchor.example/auth");

      // Verify it was not cached in the discovery cache: a subsequent call re-fetches
      vi.stubGlobal("fetch", vi.fn(async () => tomlResponse(TOML)));
      const good = await fetchStellarToml("anchor.example");
      expect(good.fallback).toBe(false);
      expect(good.signingKey).toBe("GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR");
    } finally {
      vi.useRealTimers();
    }
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
