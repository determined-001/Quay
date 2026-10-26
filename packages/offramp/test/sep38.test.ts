import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRef } from "@checkout/core";
import { AnchorHttpError } from "../src/anchor-error";
import { getSep38Prices, getSep38Quote } from "../src/sep38";

const BASE = "https://anchor.example/sep38";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC: AssetRef = { code: "USDC", issuer: ISSUER };
const XLM: AssetRef = { code: "XLM", issuer: null };

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  return new URL(String(fetchMock.mock.calls[0]![0]));
}

afterEach(() => vi.unstubAllGlobals());

describe("getSep38Prices", () => {
  it("asks for sell_asset stellar:CODE:ISSUER, the amount and context=sep6", async () => {
    const fetchMock = stubFetch({ buy_assets: [] });
    await getSep38Prices(BASE, { sellAsset: USDC, sellAmount: "25" });

    const url = requestedUrl(fetchMock);
    expect(url.origin + url.pathname).toBe(`${BASE}/prices`);
    expect(url.searchParams.get("sell_asset")).toBe(`stellar:USDC:${ISSUER}`);
    expect(url.searchParams.get("sell_amount")).toBe("25");
    expect(url.searchParams.get("context")).toBe("sep6");
  });

  it("names native XLM as stellar:native", async () => {
    const fetchMock = stubFetch({ buy_assets: [] });
    await getSep38Prices(BASE, { sellAsset: XLM, sellAmount: "5" });
    expect(requestedUrl(fetchMock).searchParams.get("sell_asset")).toBe("stellar:native");
  });

  it("keeps only upper-case iso4217 fiat entries and carries delivery method names through", async () => {
    stubFetch({
      buy_assets: [
        { asset: "iso4217:NGN", price: "0.00065", buy_delivery_methods: [{ name: "WIRE" }, { name: "BANK", description: "d" }] },
        { asset: "iso4217:ngn", price: "0.00065" },
        { asset: "stellar:USDC:" + ISSUER, price: "1" },
        { asset: "iso4217:GHS", price: "0.08" },
      ],
    });

    const prices = await getSep38Prices(BASE, { sellAsset: USDC, sellAmount: "10" });

    expect(prices).toEqual([
      { buyCurrency: "NGN", price: "0.00065", deliveryMethods: ["WIRE", "BANK"] },
      { buyCurrency: "GHS", price: "0.08", deliveryMethods: [] },
    ]);
  });

  it("returns an empty list when the anchor sends no buy_assets", async () => {
    stubFetch({});
    expect(await getSep38Prices(BASE, { sellAsset: USDC, sellAmount: "10" })).toEqual([]);
  });

  it("skips entries with no asset or an unusable price instead of throwing (issue 3.27)", async () => {
    stubFetch({
      buy_assets: [{ price: "1" }, { asset: "iso4217:KES", price: "0" }, { asset: "iso4217:NGN", price: "0.00065" }],
    });
    const prices = await getSep38Prices(BASE, { sellAsset: USDC, sellAmount: "10" });
    expect(prices.map((p) => p.buyCurrency)).toEqual(["NGN"]);
  });

  it("throws a typed AnchorHttpError on a non-OK reply, keeping the body out of the message", async () => {
    stubFetch({ error: "SECRET-BODY" }, 503);
    const err = await getSep38Prices(BASE, { sellAsset: USDC, sellAmount: "10" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnchorHttpError);
    expect(err).toMatchObject({ sep: "38", op: "/prices", status: 503 });
    expect((err as Error).message).not.toContain("SECRET-BODY");
  });
});

describe("getSep38Quote", () => {
  const QUOTE = {
    id: "q_1",
    price: "0.00065",
    total_price: "0.00066",
    sell_amount: "10",
    buy_amount: "15384.6",
    expires_at: "2026-01-01T00:00:00Z",
  };

  function bodyOf(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("POSTs the sell and buy assets with the bearer token and defaults to context=sep6", async () => {
    const fetchMock = stubFetch(QUOTE);
    const quote = await getSep38Quote(BASE, "jwt-1", { sellAsset: USDC, sellAmount: "10", buyCurrency: "NGN" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`${BASE}/quote`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer jwt-1", "content-type": "application/json" });
    expect(bodyOf(fetchMock)).toEqual({
      sell_asset: `stellar:USDC:${ISSUER}`,
      sell_amount: "10",
      buy_asset: "iso4217:NGN",
      context: "sep6",
    });
    expect(quote).toEqual({
      id: "q_1",
      price: "0.00065",
      sellAmount: "10",
      buyAmount: "15384.6",
      expiresAt: "2026-01-01T00:00:00Z",
    });
  });

  it("includes buy_delivery_method only when given", async () => {
    const withMethod = stubFetch(QUOTE);
    await getSep38Quote(BASE, "j", { sellAsset: USDC, sellAmount: "10", buyCurrency: "NGN", buyDeliveryMethod: "WIRE" });
    expect(bodyOf(withMethod)).toMatchObject({ buy_delivery_method: "WIRE" });

    const without = stubFetch(QUOTE);
    await getSep38Quote(BASE, "j", { sellAsset: USDC, sellAmount: "10", buyCurrency: "NGN" });
    expect(bodyOf(without)).not.toHaveProperty("buy_delivery_method");
  });

  it("requests the sep24 context when asked", async () => {
    const fetchMock = stubFetch(QUOTE);
    await getSep38Quote(BASE, "j", { sellAsset: XLM, sellAmount: "10", buyCurrency: "NGN", context: "sep24" });
    expect(bodyOf(fetchMock)).toMatchObject({ context: "sep24", sell_asset: "stellar:native" });
  });

  it("throws a typed AnchorHttpError on a non-OK reply", async () => {
    stubFetch({ error: "unsupported pair" }, 400);
    const err = await getSep38Quote(BASE, "j", { sellAsset: USDC, sellAmount: "10", buyCurrency: "XYZ" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnchorHttpError);
    expect(err).toMatchObject({ sep: "38", op: "quote", status: 400 });
  });
});
