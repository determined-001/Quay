import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHorizonLookup } from "../src/horizon-lookup";

// Recorded Horizon responses (issue #538): real-shaped bodies, captured once,
// so the lookup's field mapping is exercised without a live Horizon.
const HASH = "3b1f0c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c";
const FAILED_HASH = "7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d";
const USDC = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};
const BUYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const REFUNDER = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

function fetchFor(txBody: unknown, paymentsBody: unknown) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/payments")) return Response.json(paymentsBody);
    if (u.includes("/transactions/")) return Response.json(txBody);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("createHorizonLookup (issue #538)", () => {
  it("reads a recorded successful transaction and its payment operations", async () => {
    const fetchImpl = fetchFor(
      fixture("horizon-transaction-success.json"),
      fixture("horizon-transaction-payments.json"),
    );
    const horizon = createHorizonLookup("https://horizon.example/", fetchImpl);

    expect(await horizon.getTransaction(HASH)).toEqual({
      successful: true,
      memoType: "text",
      memo: "deposit 7781",
      resultCode: "tx_success",
    });

    // create_account is not a payment; the muxed payment carries the G-address
    // and id a refund's destination is checked against.
    expect(await horizon.getPayments(HASH)).toEqual([
      { from: REFUNDER, to: BUYER, amount: "5.0000000", asset: USDC },
      {
        from: REFUNDER,
        to: "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        amount: "2.0000000",
        asset: { code: "XLM", issuer: null },
        toMuxed: BUYER,
        toMuxedId: "42",
      },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(`https://horizon.example/transactions/${HASH}`, expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://horizon.example/transactions/${HASH}/payments?limit=200`,
      expect.anything(),
    );
  });

  it("reports a failed transaction's Horizon result code", async () => {
    const fetchImpl = fetchFor(
      fixture("horizon-transaction-failed.json"),
      fixture("horizon-transaction-payments.json"),
    );
    const horizon = createHorizonLookup("https://horizon.example", fetchImpl);

    expect(await horizon.getTransaction(FAILED_HASH)).toMatchObject({
      successful: false,
      resultCode: "tx_failed",
    });
  });

  it("maps 404 to no transaction and no payments", async () => {
    const notFound = createHorizonLookup(
      "https://horizon.example",
      (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    );
    expect(await notFound.getTransaction(HASH)).toBeNull();
    expect(await notFound.getPayments(HASH)).toEqual([]);
  });

  it("raises a status-only error for any other failure", async () => {
    const broken = createHorizonLookup(
      "https://horizon.example",
      (async () => new Response("<html>secret body</html>", { status: 502 })) as unknown as typeof fetch,
    );
    await expect(broken.getTransaction(HASH)).rejects.toThrow("Horizon answered HTTP 502");
    await expect(broken.getTransaction(HASH)).rejects.not.toThrow(/secret/);
  });

  it("refuses to build a URL from a malformed hash", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const horizon = createHorizonLookup("https://horizon.example", fetchImpl);
    await expect(horizon.getTransaction("../accounts")).rejects.toThrow(/malformed/);
    await expect(horizon.getPayments("../accounts")).rejects.toThrow(/malformed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
