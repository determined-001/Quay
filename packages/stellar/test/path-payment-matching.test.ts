import { describe, expect, it } from "vitest";
import { matchPayment, type PaymentLink } from "@checkout/core";
import type { HorizonPaymentRecord } from "../src/horizon-client";
import { normalizePayment } from "../src/normalize";

// ---------------------------------------------------------------------------
//  Issue 5.48 — the buyer pays in another asset, the seller receives the link
//  asset. Horizon reports the delivered side in `amount`/`asset_*` and the paid
//  side in `source_amount`/`source_asset_*`; settlement must follow the
//  delivered side, or a path payment would be booked as the wrong currency.
// ---------------------------------------------------------------------------

const DEST = "GC6VE2YE5FIGNDLGVFHSNZFINUH7FIRS5L5N4HORYKOP6XMONBXSIBKA";
const BUYER = "GAYOLLLUIZE4DZMBB2ZBKGBETLZ4QDLBFRGVBLZQXZ3T2J6G4N4UZP3Y";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const REFERENCE = "pl_ref1";

/** A strict-receive path payment: spends XLM, delivers 10 USDC. */
function horizonRecord(over: Record<string, unknown> = {}): HorizonPaymentRecord {
  return {
    type: "path_payment_strict_receive",
    paging_token: "9",
    transaction_hash: "path_tx",
    created_at: "2026-01-01T00:00:00Z",
    from: BUYER,
    to: DEST,
    // delivered
    amount: "10.0000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: USDC_ISSUER,
    // spent
    source_amount: "24.1200000",
    source_asset_type: "native",
    path: [],
    transaction: async () => ({ memo_type: "text", memo: REFERENCE, ledger_attr: 42 }),
    ...over,
  } as unknown as HorizonPaymentRecord;
}

/** Only the fields the matcher reads; the rest of a stored link is irrelevant. */
function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: REFERENCE,
    status: "active",
    amount: "10",
    paidAmount: null,
    asset: { code: "USDC", issuer: USDC_ISSUER },
    destination: DEST,
    ...over,
  } as unknown as PaymentLink;
}

describe("a path payment settles as the asset that was delivered (issue 5.48)", () => {
  it("normalizes the delivered side as amount and asset", async () => {
    const payment = await normalizePayment(horizonRecord());

    expect(payment?.amount).toBe("10.0000000");
    expect(payment?.asset).toEqual({ code: "USDC", issuer: USDC_ISSUER });
    // The buyer's outlay rides along for receipts, and differs from delivery.
    expect(payment?.sourceAmount).toBe("24.1200000");
    expect(payment?.sourceAsset).toEqual({ code: "XLM", issuer: null });
  });

  it("matches the link by memo and marks it paid in the link asset", async () => {
    const payment = (await normalizePayment(horizonRecord()))!;

    const outcome = matchPayment(payment, (reference) =>
      reference === REFERENCE ? link() : undefined,
    );

    expect(outcome.kind).toBe("paid");
    if (outcome.kind !== "paid") return;
    expect(outcome.receivedTotal).toBe("10");
    expect(outcome.overpaid).toBe(false);
  });

  it("does not accept the asset the buyer spent as the asset the seller received", async () => {
    const payment = (await normalizePayment(horizonRecord()))!;
    const xlmLink = link({ asset: { code: "XLM", issuer: null } });

    const outcome = matchPayment(payment, () => xlmLink);

    expect(outcome.kind).toBe("asset_mismatch");
  });
});
