import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStellarToml } from "../src/sep1";
import { HttpJsonRateSource, RateUnavailableError, readPath } from "../src/rates";

/**
 * Issue 3.22 — SEP-1 must be able to say "this anchor has no SEP-38", and the
 * HTTP rate source must be as careful as the static one.
 */
describe("SEP-1 no longer invents a quote server", () => {
  const NO_QUOTE_SERVER = `
    WEB_AUTH_ENDPOINT = "https://cowrie.exchange/auth"
    TRANSFER_SERVER = "https://api.cowrie.exchange/sep6"
    KYC_SERVER = "https://api.cowrie.exchange/sep12"
    DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/sep31"
    SIGNING_KEY = "GSIGNINGKEY"
  `;

  it("leaves anchorQuoteServer null when the TOML does not declare one", () => {
    // The bug this fixes: an undeclared key kept its guessed default of
    // https://<domain>/sep38, so quote() called a URL the anchor never published.
    const info = parseStellarToml(NO_QUOTE_SERVER, "cowrie.exchange");
    expect(info.anchorQuoteServer).toBeNull();
  });

  it("still parses a declared ANCHOR_QUOTE_SERVER", () => {
    const info = parseStellarToml(
      NO_QUOTE_SERVER.replace("WEB_AUTH_ENDPOINT", 'ANCHOR_QUOTE_SERVER = "https://api.cowrie.exchange/sep38"\n  WEB_AUTH_ENDPOINT'),
      "cowrie.exchange",
    );
    expect(info.anchorQuoteServer).toBe("https://api.cowrie.exchange/sep38");
  });

  it("falls back to null rather than a guess when the TOML fetch fails", async () => {
    // The real fallback path: fetchStellarToml cannot read the document, so it
    // substitutes a documented default layout. That layout includes a SEP-6
    // path (the common shape) and deliberately excludes SEP-38 — there is no
    // such thing as a default quote endpoint.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { fetchStellarToml } = await import("../src/sep1");
    const info = await fetchStellarToml("cowrie.example");

    expect(info.fallback).toBe(true);
    expect(info.anchorQuoteServer).toBeNull();
    expect(info.transferServer).toBe("https://cowrie.example/sep6");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ARGS = { anchorDomain: "anchor.example", sourceAsset: { code: "USDC" }, targetCurrency: "NGN" };

describe("HttpJsonRateSource", () => {
  const base = {
    url: "https://anchor.example/api/rates.json",
    jsonPath: "data.rate",
    anchorDomain: "anchor.example",
    targetCurrency: "NGN",
  };

  it("reads the rate at the configured JSON path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { rate: "1610" } }), { status: 200 })),
    );
    const source = new HttpJsonRateSource(base);
    const fx = await source.rate({
      anchorDomain: "anchor.example",
      sourceAsset: { code: "USDC" },
      targetCurrency: "NGN",
    });
    expect(fx.rate).toBe("1610");
    expect(fx.expiresAt).toBeGreaterThan(Date.now());
  });

  it("prefers an expiry the payload publishes over its own default", async () => {
    const expires = Date.now() + 120_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { rate: "1610" }, expiresAt: expires }), { status: 200 })),
    );
    const fx = await new HttpJsonRateSource({ ...base, defaultTtlMs: 300_000 }).rate(ARGS);
    expect(fx.expiresAt).toBe(expires);
  });

  it("caps a far-future payload expiry at now + the source's default TTL", async () => {
    const tenYears = Date.now() + 10 * 365 * 24 * 3600_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: { rate: "1610" }, expiresAt: tenYears }), { status: 200 })),
    );
    const before = Date.now();
    const fx = await new HttpJsonRateSource({ ...base, defaultTtlMs: 60_000 }).rate(ARGS);
    expect(fx.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(fx.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("refuses a payload whose published expiry has passed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { rate: "1610" }, expiresAt: Date.now() - 1 }), { status: 200 }),
      ),
    );
    await expect(
      new HttpJsonRateSource(base).rate({
        anchorDomain: "anchor.example",
        sourceAsset: { code: "USDC" },
        targetCurrency: "NGN",
      }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses a missing path rather than quoting NaN", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    await expect(
      new HttpJsonRateSource(base).rate({
        anchorDomain: "anchor.example",
        sourceAsset: { code: "USDC" },
        targetCurrency: "NGN",
      }),
    ).rejects.toThrow(/no value at JSON path/);
  });

  it("refuses a non-https URL at construction", () => {
    expect(() => new HttpJsonRateSource({ ...base, url: "http://anchor.example/rates.json" })).toThrow(
      /must be https/,
    );
  });

  it("refuses a URL the SSRF guard rejects, at configuration time", async () => {
    const source = new HttpJsonRateSource({
      ...base,
      guard: async () => ({ ok: false, reason: "resolves into a private range" }),
    });
    await expect(source.assertConfigured()).rejects.toThrow(/rejected by the SSRF guard/);
  });

  it("passes configuration when the guard approves the URL", async () => {
    const guard = vi.fn(async () => ({ ok: true as const }));
    await new HttpJsonRateSource({ ...base, guard }).assertConfigured();
    expect(guard).toHaveBeenCalledWith(base.url);
  });

  it("refuses a rate for another anchor or currency", async () => {
    const source = new HttpJsonRateSource(base);
    await expect(
      source.rate({ anchorDomain: "other.example", sourceAsset: { code: "USDC" }, targetCurrency: "NGN" }),
    ).rejects.toThrow(/configured for anchor.example/);
    await expect(
      source.rate({ anchorDomain: "anchor.example", sourceAsset: { code: "USDC" }, targetCurrency: "USD" }),
    ).rejects.toThrow(/configured for NGN/);
  });

  it("surfaces a non-2xx from the endpoint as a typed refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(
      new HttpJsonRateSource(base).rate({
        anchorDomain: "anchor.example",
        sourceAsset: { code: "USDC" },
        targetCurrency: "NGN",
      }),
    ).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe("HttpJsonRateSource hardening", () => {
  const SECRET_URL = "https://anchor.example/api/rates.json?apikey=TOPSECRET";
  const hard = { jsonPath: "data.rate", anchorDomain: "anchor.example", targetCurrency: "NGN", url: SECRET_URL };

  it("refuses redirects (the SSRF guard only vetted the configured URL) and sets a timeout signal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { rate: "1610" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new HttpJsonRateSource(hard).rate(ARGS);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a refused redirect into a generic error with no URL in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed: redirect to http://169.254.169.254/ from ${SECRET_URL}`);
      }),
    );
    const err = await new HttpJsonRateSource(hard).rate(ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateUnavailableError);
    const msg = (err as Error).message;
    expect(msg).not.toContain("TOPSECRET");
    expect(msg).not.toContain("169.254");
    expect(msg).not.toContain("anchor.example");
  });

  it("times out a hung endpoint instead of waiting forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );
    await expect(new HttpJsonRateSource({ ...hard, timeoutMs: 25 }).rate(ARGS)).rejects.toBeInstanceOf(
      RateUnavailableError,
    );
  });

  it("refuses an oversize body declared by content-length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { rate: "1610" } }), {
            status: 200,
            headers: { "content-length": "999999" },
          }),
      ),
    );
    await expect(new HttpJsonRateSource({ ...hard, maxBodyBytes: 1024 }).rate(ARGS)).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
  });

  it("refuses an oversize body that omits content-length", async () => {
    const big = JSON.stringify({ data: { rate: "1610" }, pad: "x".repeat(5000) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big, { status: 200 })));
    await expect(new HttpJsonRateSource({ ...hard, maxBodyBytes: 1024 }).rate(ARGS)).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
  });

  it("does not leak the response body or the URL on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal stack trace: db password=hunter2", { status: 500 })),
    );
    const warn = vi.fn();
    const logger = { child: () => logger, warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const err = await new HttpJsonRateSource({ ...hard, logger }).rate(ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateUnavailableError);
    const msg = (err as Error).message;
    expect(msg).toBe("rate endpoint returned HTTP 500");
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("TOPSECRET");
    // Server-side only: the truncated body goes to the log, never the message.
    expect(warn).toHaveBeenCalled();
  });

  it("does not echo the URL when it is not a valid URL", () => {
    let message = "";
    try {
      new HttpJsonRateSource({ ...hard, url: "not a url?apikey=TOPSECRET" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("TOPSECRET");
  });
});

describe("readPath", () => {
  it("walks dotted paths and numeric indices", () => {
    const body = { a: { b: [{ c: "deep" }] }, rate: "5" };
    expect(readPath(body, "rate")).toBe("5");
    expect(readPath(body, "a.b.0.c")).toBe("deep");
    expect(readPath(body, "a.missing.c")).toBeUndefined();
    expect(readPath(body, "rate.deeper")).toBeUndefined();
  });
});
