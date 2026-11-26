import { Asset, Horizon, Networks, Operation, Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { AssetRef } from "@checkout/core";
import type { LinkWithRequest } from "../lib/api";
import {
  buildDirectPaymentXdr,
  buildPathPaymentXdr,
  PathPaymentError,
  planPathPayment,
  type PaymentHorizon,
  type PlannedPathPayment,
} from "../lib/payment-build";

// ---------------------------------------------------------------------------
//  Issue 5.48 — build the path payment the buyer chose, from a fresh quote.
//
//  Everything here is offline: Horizon is an in-memory fake, and the XDR the
//  builders produce is parsed back with the real SDK, so the assertions are on
//  the operation that would actually be signed.
// ---------------------------------------------------------------------------

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const BUYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST = "GC6VE2YE5FIGNDLGVFHSNZFINUH7FIRS5L5N4HORYKOP6XMONBXSIBKA";

const USDC = { code: "USDC", issuer: ISSUER };
const XLM = { code: "XLM", issuer: null };
const BTC = { code: "BTC", issuer: ISSUER };

type PathRecord = Horizon.ServerApi.PaymentPathRecord;

function assetFields(asset: AssetRef): { asset_type: string; asset_code?: string; asset_issuer?: string } {
  if (asset.issuer === null) return { asset_type: "native" };
  return { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer };
}

/** One Horizon strict-receive record, shaped like the real thing. */
function quoteRecord(sourceAsset: AssetRef, sourceAmount: string, path: AssetRef[] = []): PathRecord {
  return {
    ...assetFields(sourceAsset),
    source_amount: sourceAmount,
    source_asset_type: assetFields(sourceAsset).asset_type,
    source_asset_code: assetFields(sourceAsset).asset_code,
    source_asset_issuer: assetFields(sourceAsset).asset_issuer,
    destination_amount: "10.0000000",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: USDC.code,
    destination_asset_issuer: USDC.issuer,
    path: path.map(assetFields),
  } as unknown as PathRecord;
}

/** In-memory Horizon: one canned quote list per requested destination amount. */
class FakeHorizon implements PaymentHorizon {
  readonly calls: Array<{ source: string | Asset[]; destAmount: string }> = [];
  sequence = "100";
  balances = [
    { asset_type: "native", balance: "500.0000000" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0000000" },
  ];
  private readonly byAmount = new Map<string, PathRecord[]>();

  quote(destAmount: string, records: PathRecord[]): this {
    this.byAmount.set(destAmount, records);
    return this;
  }

  async loadAccount() {
    return { sequence: this.sequence, balances: this.balances };
  }

  payments(): never {
    throw new Error("the builder never reads payment history");
  }

  strictReceivePaths(source: string | Asset[], _destAsset: Asset, destAmount: string) {
    this.calls.push({ source, destAmount });
    return { call: async () => ({ records: [...(this.byAmount.get(destAmount) ?? [])] }) };
  }
}

const option = { sourceAsset: XLM, sendMax: "24.36" };

/** Full amount 13 XLM for 10 USDC, 1% slice at 0.12 XLM for 0.1 USDC:
 *  the full quote is ~833 bps worse per unit than the slice. */
function thinBook(): FakeHorizon {
  return new FakeHorizon()
    .quote("10", [quoteRecord(XLM, "13", [BTC])])
    .quote("0.1", [quoteRecord(XLM, "0.12")]);
}

describe("planPathPayment (issue 5.48)", () => {
  it("re-quotes the chosen asset for the outstanding amount and keeps the accepted cap", async () => {
    const horizon = new FakeHorizon()
      .quote("10", [quoteRecord(USDC, "9"), quoteRecord(XLM, "24.12", [BTC])])
      .quote("0.1", [quoteRecord(XLM, "0.2412")]);

    const plan = await planPathPayment({
      client: horizon,
      buyer: BUYER,
      destAsset: USDC,
      destAmount: "10",
      option,
      maxPriceImpactBps: 300,
    });

    expect(plan.sourceAsset).toEqual(XLM);
    expect(plan.sourceAmount).toBe("24.12");
    expect(plan.path).toEqual([BTC]);
    // sendMax is what the buyer accepted, never the fresh quote.
    expect(plan.maxSourceAmount).toBe("24.36");
    expect(plan.priceImpactBps).toBe(0);
    // Two calls, both for this buyer: the full amount and a 1% slice.
    expect(horizon.calls.map((call) => call.destAmount)).toEqual(["10", "0.1"]);
    expect(horizon.calls.every((call) => call.source === BUYER)).toBe(true);
  });

  it("refuses when the chosen asset has no path any more", async () => {
    const horizon = new FakeHorizon()
      .quote("10", [quoteRecord(USDC, "9")])
      .quote("0.1", [quoteRecord(USDC, "0.09")]);

    await expect(
      planPathPayment({
        client: horizon,
        buyer: BUYER,
        destAsset: USDC,
        destAmount: "10",
        option,
        maxPriceImpactBps: 300,
      }),
    ).rejects.toMatchObject({ code: "no_path" });
  });

  it("refuses a quote whose price impact is above the cap", async () => {
    await expect(
      planPathPayment({
        client: thinBook(),
        buyer: BUYER,
        destAsset: USDC,
        destAmount: "10",
        option: { sourceAsset: XLM, sendMax: "100" },
        maxPriceImpactBps: 300,
      }),
    ).rejects.toMatchObject({ code: "no_path" });
  });

  it("accepts a quote exactly at the cap (the boundary is inclusive)", async () => {
    // 10 USDC costs 10.30 XLM; the slice prices 1 XLM per 0.1 USDC → 300 bps.
    const horizon = new FakeHorizon()
      .quote("10", [quoteRecord(XLM, "10.3")])
      .quote("0.1", [quoteRecord(XLM, "0.1")]);

    const plan = await planPathPayment({
      client: horizon,
      buyer: BUYER,
      destAsset: USDC,
      destAmount: "10",
      option: { sourceAsset: XLM, sendMax: "10.4" },
      maxPriceImpactBps: 300,
    });

    expect(plan.priceImpactBps).toBe(300);
  });

  it("refuses a fresh price above the maxSourceAmount the buyer accepted", async () => {
    // Same unit price, but the amount moved past the accepted cap.
    const horizon = new FakeHorizon()
      .quote("10", [quoteRecord(XLM, "24.5")])
      .quote("0.1", [quoteRecord(XLM, "0.245")]);

    await expect(
      planPathPayment({
        client: horizon,
        buyer: BUYER,
        destAsset: USDC,
        destAmount: "10",
        option,
        maxPriceImpactBps: 300,
      }),
    ).rejects.toMatchObject({ code: "price_moved" });
  });

  it("reports the refusal through PathPaymentError so the panel can explain it", async () => {
    await expect(
      planPathPayment({
        client: thinBook(),
        buyer: BUYER,
        destAsset: USDC,
        destAmount: "10",
        option,
        maxPriceImpactBps: 100,
      }),
    ).rejects.toBeInstanceOf(PathPaymentError);
  });
});

const PLAN: PlannedPathPayment = {
  sourceAsset: XLM,
  sourceAmount: "24.12",
  path: [BTC],
  maxSourceAmount: "24.36",
  priceImpactBps: 12,
};

function parse(xdr: string) {
  return new Transaction(xdr, Networks.TESTNET);
}

// The parsed operation's friendly fields. The SDK types `operations[0]` as the
// raw XDR arm, so the decoded shape is described here instead.
interface PathPaymentStrictReceiveOp {
  type: string;
  destination: string;
  sendAsset: Asset;
  sendMax: string;
  destAsset: Asset;
  destAmount: string;
  path: Asset[];
}

interface PaymentOp {
  type: string;
  destination: string;
  asset: Asset;
  amount: string;
}

describe("path payment XDR (issue 5.48)", () => {
  it("builds pathPaymentStrictReceive with the fresh path and the accepted sendMax", async () => {
    const xdr = await buildPathPaymentXdr({
      address: BUYER,
      sequence: "100",
      destination: DEST,
      destAsset: USDC,
      destAmount: "10",
      networkPassphrase: Networks.TESTNET,
      memo: "ref_1",
      plan: PLAN,
    });

    const tx = parse(xdr);
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value?.toString()).toBe("ref_1");
    expect(tx.source).toBe(BUYER);

    const path = tx.operations[0] as unknown as PathPaymentStrictReceiveOp;
    expect(path.type).toBe("pathPaymentStrictReceive");
    expect(path.destination).toBe(DEST);
    expect(path.sendAsset.isNative()).toBe(true);
    expect(path.sendMax).toBe("24.3600000");
    expect(path.destAsset.getCode()).toBe("USDC");
    expect(path.destAsset.getIssuer()).toBe(ISSUER);
    expect(path.destAmount).toBe("10.0000000");
    expect(path.path.map((hop) => hop.getCode())).toEqual(["BTC"]);
  });

  it("builds a standard payment when the buyer keeps the link asset", async () => {
    const xdr = await buildDirectPaymentXdr({
      address: BUYER,
      sequence: "100",
      destination: DEST,
      destAsset: USDC,
      destAmount: "10",
      networkPassphrase: Networks.TESTNET,
      memo: "ref_1",
    });

    const payment = parse(xdr).operations[0] as unknown as PaymentOp;
    expect(payment.type).toBe("payment");
    expect(payment.destination).toBe(DEST);
    expect(payment.asset.getCode()).toBe("USDC");
    expect(payment.amount).toBe("10.0000000");
  });
});

// ---------------------------------------------------------------------------
//  The builder the wallet button actually calls, end to end through the fake
//  Horizon: it must pick the path payment only when an option was chosen.
// ---------------------------------------------------------------------------

function linkFixture(over: Partial<LinkWithRequest> = {}): LinkWithRequest {
  return {
    link: { id: "lnk_1", status: "active", amount: "10", paidAmount: null },
    request: { uri: "web+stellar:pay?x", destination: DEST, amount: "10", asset: USDC, memo: "ref_1" },
    pay: { pathPayments: true, maxSlippageBps: 100, maxPriceImpactBps: 300 },
    ...over,
  } as unknown as LinkWithRequest;
}

describe("buildPaymentXdr asset choice (issue 5.48)", () => {
  it("pays the link asset directly when no foreign asset is chosen", async () => {
    const { buildPaymentXdr } = await import("../app/components/WalletPayButton");
    const horizon = new FakeHorizon();

    const xdr = await buildPaymentXdr(
      { address: BUYER, initial: linkFixture(), payOption: null },
      { horizon },
    );

    expect(parse(xdr).operations[0]!.type).toBe("payment");
    // No quote is spent on a payment that needs no path.
    expect(horizon.calls).toHaveLength(0);
  });

  it("builds the path payment from a fresh quote when a foreign asset is chosen", async () => {
    const { buildPaymentXdr } = await import("../app/components/WalletPayButton");
    const horizon = new FakeHorizon()
      .quote("10", [quoteRecord(XLM, "24.12", [BTC])])
      .quote("0.1", [quoteRecord(XLM, "0.2412")]);

    const xdr = await buildPaymentXdr(
      {
        address: BUYER,
        initial: linkFixture(),
        payOption: { sourceAsset: XLM, sendMax: "24.36" },
      },
      { horizon },
    );

    const op = parse(xdr).operations[0] as unknown as PathPaymentStrictReceiveOp;
    expect(op.type).toBe("pathPaymentStrictReceive");
    expect(op.sendMax).toBe("24.3600000");
    expect(op.destAmount).toBe("10.0000000");
    expect(op.destAsset.getCode()).toBe("USDC");
  });

  it("refuses a thin book instead of signing an unfavourable conversion", async () => {
    const { buildPaymentXdr } = await import("../app/components/WalletPayButton");

    await expect(
      buildPaymentXdr(
        {
          address: BUYER,
          initial: linkFixture(),
          payOption: { sourceAsset: XLM, sendMax: "100" },
        },
        { horizon: thinBook() },
      ),
    ).rejects.toMatchObject({ code: "no_path" });
  });

  it("quotes only the outstanding amount on an underpaid link", async () => {
    const { buildPaymentXdr } = await import("../app/components/WalletPayButton");
    const horizon = new FakeHorizon()
      .quote("4", [quoteRecord(XLM, "9.5")])
      .quote("0.04", [quoteRecord(XLM, "0.095")]);

    const xdr = await buildPaymentXdr(
      {
        address: BUYER,
        initial: linkFixture({
          link: { id: "lnk_1", status: "underpaid", amount: "10", paidAmount: "6" },
        } as Partial<LinkWithRequest>),
        payOption: { sourceAsset: XLM, sendMax: "9.6" },
      },
      { horizon },
    );

    expect(horizon.calls.map((call) => call.destAmount)).toEqual(["4", "0.04"]);
    const op = parse(xdr).operations[0] as unknown as PathPaymentStrictReceiveOp;
    expect(op.destAmount).toBe("4.0000000");
  });
});
