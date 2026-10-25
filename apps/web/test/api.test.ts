import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, apiBase, classifyError, describeError, CheckoutError, getSessionToken, type ApiErrorCode, serverNow, setServerSkewForTest, setSessionToken } from "../lib/api";

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
    ["409 quote_mismatch", 409, { error: "quote_mismatch" }, "quote_mismatch"],
    ["409 request_in_progress", 409, { error: "request_in_progress" }, "request_in_progress"],
    ["409 idempotency_key_reuse", 409, { error: "idempotency_key_reuse" }, "request_in_progress"],
    ["400 challenge_rejected", 400, { error: "challenge_rejected" }, "challenge_rejected"],
    ["502 challenge_rejected", 502, { error: "challenge_rejected" }, "challenge_rejected"],
  ];

  it.each(rows)("%s", (_name, status, body, expected) => {
    expect(classifyError(status, body)).toBe(expected);
  });

  it("ignores non-string error and reason fields", () => {
    expect(classifyError(409, { error: 5, reason: {} })).toBe("conflict");
  });

  it.each(["anchor_unavailable", "offramp_disabled", "quote_expired", "quote_mismatch", "request_in_progress", "challenge_rejected"] as const)(
    "describeError has specific copy for %s",
    (code) => {
      const text = describeError(new CheckoutError(code, 400, "x"));
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/went wrong on the server/);
    },
  );

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
});

/**
 * Issue #390 (5.33): the `http()` wrapper is the single path every screen goes
 * through, so its token handling, multipart bodies, 204 handling and error
 * envelope are pinned here one behaviour at a time.
 */
describe("http() transport contract", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    setSessionToken(null);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setSessionToken(null);
    vi.restoreAllMocks();
  });

  it("clears the in-memory session token on a 401 so callers stop retrying with it", async () => {
    setSessionToken("tok-stale");
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"anchor_auth_required"}', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(api.listLinks()).rejects.toMatchObject({ code: "anchor_auth_required", status: 401 });

    expect(getSessionToken()).toBeNull();

    // The very next request must go out without the dead bearer token.
    const fetchMock = vi.fn(async () => new Response('{"links":[]}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await api.listLinks();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("resolves undefined for a 204 rather than trying to parse a body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;

    await expect(api.deleteWebhook("wh_1")).resolves.toBeUndefined();
  });

  it("omits content-type for a FormData body so the browser sets the multipart boundary", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: "pending", requiredFields: [], providedFields: {}, message: null, lastSyncedAt: null }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const form = new FormData();
    form.append("id_document", new Blob(["x"], { type: "image/png" }), "id.png");

    await api.submitKycFiles(form);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/seller/kyc/files`);
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("still sends a JSON content-type when the body is JSON", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "wh_1" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.createWebhook("https://example.test/hook");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("maps a non-JSON error body to server_error instead of guessing a code", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("<html><body>Bad request</body></html>", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(api.listLinks()).rejects.toMatchObject({ code: "server_error", status: 400 });
  });

  it("maps a thrown fetch to unreachable with status 0", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(api.listLinks()).rejects.toMatchObject({ code: "unreachable", status: 0 });
  });

  it("propagates missingFields and the leftover error details", async () => {
    const body = {
      error: "kyc_required",
      message: "KYC incomplete",
      missingFields: ["id_number", "date_of_birth"],
      reason: "kyc_incomplete",
      anchorDomain: "anchor.example",
    };
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(body), { status: 403 }),
    ) as unknown as typeof fetch;

    const err = (await api.getKyc().catch((e: unknown) => e)) as CheckoutError;

    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.code).toBe("kyc_required");
    expect(err.status).toBe(403);
    expect(err.message).toBe("kyc_required (403): KYC incomplete");
    expect(err.missingFields).toEqual(["id_number", "date_of_birth"]);
    // `error`, `message` and `missingFields` are destructured out; the rest is
    // kept verbatim so callers can read `details.reason`, `details.limits`, ...
    expect(err.details).toEqual({ reason: "kyc_incomplete", anchorDomain: "anchor.example" });
  });

  it("drops a missingFields that is not an array", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"kyc_required","missingFields":"id_number"}', { status: 403 }),
    ) as unknown as typeof fetch;

    const err = (await api.getKyc().catch((e: unknown) => e)) as CheckoutError;

    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.missingFields).toBeUndefined();
    expect(err.message).toBe("kyc_required (403): kyc_required");
  });
});

/**
 * Issue #390 (5.33): seller-facing copy is asserted for every `ApiErrorCode`.
 * The record below is `Record<ApiErrorCode, true>`, so adding a code to the
 * union without listing it here fails `pnpm typecheck` — the copy can't quietly
 * fall back to "an unexpected error occurred" for a new code.
 */
const DEFAULT_ERROR_COPY = "An unexpected error occurred. Please try again.";

const EVERY_ERROR_CODE: Record<ApiErrorCode, true> = {
  not_found: true,
  invalid_body: true,
  conflict: true,
  kyc_required: true,
  anchor_auth_required: true,
  destination_cannot_receive: true,
  payment_rejected: true,
  wallet_rejected: true,
  insufficient_balance: true,
  missing_trustline: true,
  wrong_network: true,
  unreachable: true,
  server_error: true,
  consent_required: true,
  offramp_rejected: true,
  quote_mismatch: true,
  unauthorized: true,
  telemetry_not_enabled: true,
  telemetry_error: true,
  anchor_unavailable: true,
  offramp_disabled: true,
  quote_expired: true,
  request_in_progress: true,
  challenge_rejected: true,
};

const ALL_ERROR_CODES = Object.keys(EVERY_ERROR_CODE) as ApiErrorCode[];

/** Operator telemetry codes are shown on the ops page, never as seller copy. */
const GENERIC_COPY_CODES: ApiErrorCode[] = ["unauthorized", "telemetry_not_enabled", "telemetry_error"];

describe("describeError copy coverage", () => {
  it.each(ALL_ERROR_CODES)("returns usable copy for %s", (code) => {
    const text = describeError(new CheckoutError(code, 400, "x"));
    expect(text.trim().length).toBeGreaterThan(10);
  });

  it.each(ALL_ERROR_CODES.filter((code) => !GENERIC_COPY_CODES.includes(code)))(
    "has a code-specific message for %s",
    (code) => {
      expect(describeError(new CheckoutError(code, 400, "x"))).not.toBe(DEFAULT_ERROR_COPY);
    },
  );

  it.each(GENERIC_COPY_CODES)("falls back to the generic message for %s", (code) => {
    expect(describeError(new CheckoutError(code, 400, "x"))).toBe(DEFAULT_ERROR_COPY);
  });
});

describe("describeError copy for offramp_rejected limits", () => {
  function copyFor(limits?: { minAmount?: number; maxAmount?: number }): string {
    return describeError(
      new CheckoutError("offramp_rejected", 422, "x", undefined, limits ? { limits } : {}),
    );
  }

  it("names both bounds when the anchor quoted a range", () => {
    expect(copyFor({ minAmount: 5, maxAmount: 500 })).toBe(
      "The anchor only accepts cash-outs between 5 and 500. Adjust the amount and try again.",
    );
  });

  it("names only the minimum when that is all the anchor quoted", () => {
    expect(copyFor({ minAmount: 5 })).toBe("The anchor requires a cash-out of at least 5.");
  });

  it("names only the maximum when that is all the anchor quoted", () => {
    expect(copyFor({ maxAmount: 500 })).toBe("The anchor accepts cash-outs of at most 500.");
  });

  it("falls back to generic copy when the anchor gave no limits", () => {
    expect(copyFor({})).toBe("The anchor can't process this cash-out as requested.");
    expect(copyFor()).toBe("The anchor can't process this cash-out as requested.");
  });
});


