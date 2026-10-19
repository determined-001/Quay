import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorHttpError } from "../src/anchor-error";
import { getSep38Prices, getSep38Quote } from "../src/sep38";

const BASE_URL = "https://anchor.example/sep38";
const JWT = "test-jwt-token";

describe("sep38", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getSep38Prices", () => {
    it("constructs correct GET request parameters for issued asset with context=sep6", async () => {
      let requestedUrl: string | undefined;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          requestedUrl = String(input);
          return new Response(
            JSON.stringify({
              buy_assets: [
                {
                  asset: "iso4217:NGN",
                  price: "0.00065",
                  buy_delivery_methods: [{ name: "BANK_TRANSFER" }, { name: "WIRE" }],
                },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const prices = await getSep38Prices(BASE_URL, {
        sellAsset: { code: "USDC", issuer },
        sellAmount: "100",
      });

      expect(requestedUrl).toBeDefined();
      const url = new URL(requestedUrl!);
      expect(url.origin + url.pathname).toBe("https://anchor.example/sep38/prices");
      expect(url.searchParams.get("sell_asset")).toBe(`stellar:USDC:${issuer}`);
      expect(url.searchParams.get("sell_amount")).toBe("100");
      expect(url.searchParams.get("context")).toBe("sep6");

      expect(prices).toEqual([
        {
          buyCurrency: "NGN",
          price: "0.00065",
          deliveryMethods: ["BANK_TRANSFER", "WIRE"],
        },
      ]);
    });

    it("formats native XLM sell_asset as stellar:native", async () => {
      let requestedUrl: string | undefined;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          requestedUrl = String(input);
          return new Response(
            JSON.stringify({
              buy_assets: [
                {
                  asset: "iso4217:USD",
                  price: "0.12",
                },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      const prices = await getSep38Prices(BASE_URL, {
        sellAsset: { code: "XLM", issuer: null },
        sellAmount: "50",
      });

      const url = new URL(requestedUrl!);
      expect(url.searchParams.get("sell_asset")).toBe("stellar:native");
      expect(url.searchParams.get("sell_amount")).toBe("50");
      expect(prices).toEqual([
        {
          buyCurrency: "USD",
          price: "0.12",
          deliveryMethods: [],
        },
      ]);
    });

    it("filters to valid ISO-4217 uppercase 3-letter codes and drops lowercase or stellar assets", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              buy_assets: [
                { asset: "iso4217:NGN", price: "0.00065" },
                { asset: "iso4217:ngn", price: "0.00065" },
                { asset: "iso4217:USDC", price: "1.0" },
                { asset: "iso4217:12", price: "1.0" },
                { asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", price: "1.0" },
                { asset: "stellar:native", price: "1.0" },
                { asset: "iso4217:EUR", price: "1.08", buy_delivery_methods: [{ name: "SEPA" }] },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      const prices = await getSep38Prices(BASE_URL, {
        sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sellAmount: "10",
      });

      expect(prices).toEqual([
        { buyCurrency: "NGN", price: "0.00065", deliveryMethods: [] },
        { buyCurrency: "EUR", price: "1.08", deliveryMethods: ["SEPA"] },
      ]);
    });

    it("handles missing buy_assets property gracefully by returning empty array", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(JSON.stringify({}), { status: 200 });
        }),
      );

      const prices = await getSep38Prices(BASE_URL, {
        sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sellAmount: "10",
      });

      expect(prices).toEqual([]);
    });

    it("handles empty buy_delivery_methods or missing buy_delivery_methods", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              buy_assets: [
                { asset: "iso4217:BRL", price: "5.5", buy_delivery_methods: [] },
                { asset: "iso4217:MXN", price: "18.2" },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      const prices = await getSep38Prices(BASE_URL, {
        sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sellAmount: "10",
      });

      expect(prices).toEqual([
        { buyCurrency: "BRL", price: "5.5", deliveryMethods: [] },
        { buyCurrency: "MXN", price: "18.2", deliveryMethods: [] },
      ]);
    });

    it("throws typed AnchorHttpError on non-OK HTTP status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response("Bad Request: unsupported asset", { status: 400 });
        }),
      );

      const promise = getSep38Prices(BASE_URL, {
        sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sellAmount: "10",
      });

      await expect(promise).rejects.toThrow(AnchorHttpError);
      await expect(promise).rejects.toMatchObject({
        sep: "38",
        op: "/prices",
        status: 400,
        body: "Bad Request: unsupported asset",
      });
    });

    it("throws TypeError if an entry in buy_assets is missing an asset property (current behavior before 3.27)", async () => {
      // Issue 3.27 tracks skipping entries with missing asset.
      // Assert current behavior where entry.asset.match throws TypeError.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              buy_assets: [
                { price: "1.0" }, // missing asset property
              ],
            }),
            { status: 200 },
          );
        }),
      );

      await expect(
        getSep38Prices(BASE_URL, {
          sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
          sellAmount: "10",
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe("getSep38Quote", () => {
    it("sends correct POST request with body and headers, returning parsed Sep38QuoteResult", async () => {
      let requestedUrl: string | undefined;
      let requestedInit: RequestInit | undefined;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          requestedUrl = String(input);
          requestedInit = init;
          return new Response(
            JSON.stringify({
              id: "quote-12345",
              price: "0.00065",
              total_price: "0.00066",
              sell_amount: "100",
              buy_amount: "153846.15",
              expires_at: "2026-10-19T12:00:00Z",
            }),
            { status: 200 },
          );
        }),
      );

      const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const quote = await getSep38Quote(BASE_URL, JWT, {
        sellAsset: { code: "USDC", issuer },
        sellAmount: "100",
        buyCurrency: "NGN",
        buyDeliveryMethod: "BANK_TRANSFER",
      });

      expect(requestedUrl).toBe("https://anchor.example/sep38/quote");
      expect(requestedInit?.method).toBe("POST");
      expect(requestedInit?.headers).toEqual({
        "content-type": "application/json",
        authorization: `Bearer ${JWT}`,
      });

      const body = JSON.parse(requestedInit?.body as string);
      expect(body).toEqual({
        sell_asset: `stellar:USDC:${issuer}`,
        sell_amount: "100",
        buy_asset: "iso4217:NGN",
        buy_delivery_method: "BANK_TRANSFER",
        context: "sep6",
      });

      expect(quote).toEqual({
        id: "quote-12345",
        price: "0.00065",
        sellAmount: "100",
        buyAmount: "153846.15",
        expiresAt: "2026-10-19T12:00:00Z",
      });
    });

    it("omits buy_delivery_method when not provided and handles native XLM sell_asset", async () => {
      let requestedInit: RequestInit | undefined;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          requestedInit = init;
          return new Response(
            JSON.stringify({
              id: "quote-native",
              price: "0.12",
              total_price: "0.12",
              sell_amount: "50",
              buy_amount: "6",
              expires_at: "2026-10-19T12:00:00Z",
            }),
            { status: 200 },
          );
        }),
      );

      const quote = await getSep38Quote(BASE_URL, JWT, {
        sellAsset: { code: "XLM", issuer: null },
        sellAmount: "50",
        buyCurrency: "USD",
      });

      const body = JSON.parse(requestedInit?.body as string);
      expect(body).toEqual({
        sell_asset: "stellar:native",
        sell_amount: "50",
        buy_asset: "iso4217:USD",
        context: "sep6",
      });
      expect(body).not.toHaveProperty("buy_delivery_method");

      expect(quote.id).toBe("quote-native");
      expect(quote.price).toBe("0.12");
      expect(quote.sellAmount).toBe("50");
      expect(quote.buyAmount).toBe("6");
    });

    it("throws typed AnchorHttpError on non-OK HTTP status from POST /quote", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({ error: "The anchor cannot deliver this amount" }),
            { status: 422 },
          );
        }),
      );

      const promise = getSep38Quote(BASE_URL, JWT, {
        sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sellAmount: "99999999",
        buyCurrency: "NGN",
      });

      await expect(promise).rejects.toThrow(AnchorHttpError);
      await expect(promise).rejects.toMatchObject({
        sep: "38",
        op: "quote",
        status: 422,
      });
    });
  });
});
