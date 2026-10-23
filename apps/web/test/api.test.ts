import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, apiBase, classifyError, describeError, CheckoutError, type ApiErrorCode, serverNow, setServerSkewForTest, setSessionToken } from "../lib/api";

/**
 * Regression for issue 5.8: `exportCsv` used to call `fetch()` directly, so it
 * carried neither the bearer token nor `credentials: "include"`. On the
 * split-origin topology `docs/MAINNET.md` prescribes, every click 401'd.
 */
describe("api.exportCsv", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    setSessionToken(null);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSessionToken(null);
    vi.restoreAllMocks();
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const csv = new Blob(["reference,amount\n"], { type: "text/csv" });
    const fetchMock = vi.fn(async () => new Response(csv, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("sends the bearer token and credentials, and resolves to a Blob", async () => {
    const fetchMock = stubFetch();
    setSessionToken("tok-123");

    const blob = await api.exportCsv();

    expect(blob).toBeInstanceOf(Blob);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/export/csv`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect((init.headers as Record<string, string>).accept).toBe("text/csv");
    expect(init.credentials).toBe("include");
  });

  it("still sends credentials when there is no in-memory token (cookie-only session)", async () => {
    const fetchMock = stubFetch();

    await api.exportCsv();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.credentials).toBe("include");
  });

  it("passes the from/to range through as query params", async () => {
    const fetchMock = stubFetch();

    await api.exportCsv("2026-01-01", "2026-02-01");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/export/csv?from=2026-01-01&to=2026-02-01`);
  });

  it("surfaces a non-2xx export as a CheckoutError instead of a Blob", async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(api.exportCsv()).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

/**
 * Issue #35: the checkout countdown is measured against the server's clock,
 * learned from the `Date` header, because a buyer's device can be minutes out
 * and `expiresAt` is a server timestamp.
 */
describe("server clock skew", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    setServerSkewForTest(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function stubWithDate(dateHeader: string) {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ link: {}, request: {} }), {
          status: 200,
          headers: { "content-type": "application/json", date: dateHeader },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("learns the offset from the Date header", async () => {
    const localNow = new Date("2026-09-05T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(localNow);
    // The server is 90 seconds ahead of this browser.
    stubWithDate(new Date(localNow + 90_000).toUTCString());

    await api.getLink("lnk_1");

    expect(serverNow() - localNow).toBeGreaterThanOrEqual(89_000);
    expect(serverNow() - localNow).toBeLessThanOrEqual(91_000);
  });

  it("ignores an unparsable Date header rather than corrupting the clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00.000Z").getTime());
    stubWithDate("not a date");

    await api.getLink("lnk_1");

    expect(serverNow()).toBe(Date.now());
  });
});

describe("api.quoteCashOut and api.cashOut", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    setSessionToken("tok-test");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSessionToken(null);
    vi.restoreAllMocks();
  });

  it("api.quoteCashOut URL-encodes targetCurrency and calls GET /links/:id/cash-out/quote", async () => {
    const quotePayload = {
      quoteId: "quote_123",
      sourceAmount: "10",
      targetCurrency: "NGN",
      targetAmount: "16500.00",
      rate: "1650",
      expiresAt: 1786000000000,
      fee: { amount: "165.00", currency: "NGN", source: "anchor" },
      netTargetAmount: "16335.00",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(quotePayload), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await api.quoteCashOut("lnk_1", "NGN");

    expect(res).toEqual(quotePayload);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/lnk_1/cash-out/quote?targetCurrency=NGN`);
    expect(init.method).toBeUndefined();
  });

  it("api.cashOut includes idempotencyKey header and sends quoteId in JSON body", async () => {
    const cashOutPayload = {
      job: { jobId: "job_123", status: "pending", targetAmount: "16335.00", targetCurrency: "NGN" },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(cashOutPayload), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await api.cashOut(
      "lnk_1",
      "NGN",
      { bank: "GTBank", account: "1234567890" },
      "idemp_key_123",
      "quote_123",
    );

    expect(res).toEqual(cashOutPayload);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/links/lnk_1/cash-out`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("idemp_key_123");
    expect(JSON.parse(init.body as string)).toEqual({
      targetCurrency: "NGN",
      payoutFields: { bank: "GTBank", account: "1234567890" },
      quoteId: "quote_123",
    });
  });
});

describe("classifyError", () => {
  const rows: Array<[string, number, Record<string, unknown>, ApiErrorCode]> = [
    // Existing branches (no behaviour change)
    ["5xx with no body", 500, {}, "server_error"],
    ["5xx beats a known code", 500, { error: "not_found" }, "server_error"],
    ["409 insufficient_balance reason", 409, { error: "payment_rejected", reason: "insufficient_balance" }, "insufficient_balance"],
    ["409 missing_trustline reason", 409, { reason: "missing_trustline" }, "missing_trustline"],
    ["409 wrong_network reason", 409, { reason: "wrong_network" }, "wrong_network"],
    ["409 payment_rejected", 409, { error: "payment_rejected" }, "payment_rejected"],
    ["409 plain conflict", 409, { error: "something_else" }, "conflict"],
    ["404 not_found", 404, { error: "not_found" }, "not_found"],
    ["400 invalid_body", 400, { error: "invalid_body" }, "invalid_body"],
    ["403 kyc_required", 403, { error: "kyc_required" }, "kyc_required"],
    ["422 offramp_rejected", 422, { error: "offramp_rejected" }, "offramp_rejected"],
    ["401 anchor_auth_required", 401, { error: "anchor_auth_required" }, "anchor_auth_required"],
    ["422 destination_cannot_receive", 422, { error: "destination_cannot_receive" }, "destination_cannot_receive"],
    ["400 payment_rejected", 400, { error: "payment_rejected" }, "payment_rejected"],
    ["unknown 4xx code falls back", 418, { error: "teapot" }, "server_error"],
    ["empty body falls back", 400, {}, "server_error"],
    ["prototype key is not a code", 400, { error: "constructor" }, "server_error"],
    // New codes
    ["503 anchor_unavailable", 503, { error: "anchor_unavailable" }, "anchor_unavailable"],
    ["501 offramp_disabled", 501, { error: "offramp_disabled" }, "offramp_disabled"],
    ["409 quote_expired with detail", 409, { error: "quote_expired: quote q_1 lapsed" }, "quote_expired"],
    ["409 request_in_progress", 409, { error: "request_in_progress" }, "request_in_progress"],
    ["409 idempotency_key_reuse", 409, { error: "idempotency_key_reuse" }, "request_in_progress"],
    ["400 challenge_rejected", 400, { error: "challenge_rejected" }, "challenge_rejected"],
    ["502 challenge_rejected", 502, { error: "challenge_rejected" }, "challenge_rejected"],
    ["403 consent_required", 403, { error: "consent_required" }, "consent_required"],
    ["401 unauthorized", 401, { error: "unauthorized" }, "unauthorized"],
    ["429 rate_limited", 429, { error: "rate_limited" }, "rate_limited"],
  ];

  it.each(rows)("%s", (_name, status, body, expected) => {
    expect(classifyError(status, body)).toBe(expected);
  });

  it("ignores non-string error and reason fields", () => {
    expect(classifyError(409, { error: 5, reason: {} })).toBe("conflict");
  });

  it.each([
    "anchor_unavailable",
    "offramp_disabled",
    "quote_expired",
    "request_in_progress",
    "challenge_rejected",
    "unauthorized",
    "rate_limited",
    "consent_required",
  ] as const)("describeError has specific copy for %s", (code) => {
    const text = describeError(new CheckoutError(code, 400, "x"));
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toMatch(/went wrong on the server/);
    expect(text).not.toMatch(/An unexpected error occurred/);
  });

  it("http() surfaces a classified code end to end", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"anchor_unavailable"}', { status: 503 }),
    ) as unknown as typeof fetch;
    try {
      await expect(api.getLink("lnk_1")).rejects.toMatchObject({ code: "anchor_unavailable", status: 503 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("preserves details.fields and anchorDomain on consent_required errors thrown by http()", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "consent_required",
            anchorDomain: "testanchor.stellar.org",
            fields: ["first_name", "last_name"],
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    try {
      await expect(api.getLink("lnk_1")).rejects.toMatchObject({
        code: "consent_required",
        status: 403,
        details: {
          anchorDomain: "testanchor.stellar.org",
          fields: ["first_name", "last_name"],
        },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

