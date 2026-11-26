import { CannotReceiveError, type Seller, type SellerRepository } from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { Memo, Networks, StrKey, TransactionBuilder, type Operation, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  LinkService,
  REFUND_TX_TIMEOUT_S,
  refundMemo,
  type RefundAccountSnapshot,
} from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeRefundRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

// Issue 4.59 (#535): the server builds the refund transaction and never signs it.

const sellerWallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const asset = { code: "USDC", issuer: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)) };
const txHash = "a".repeat(64);
const operationId = "1001";
const PAYMENT = `${txHash}:${operationId}`;
const NOW = Date.parse("2026-11-26T12:00:00Z");
const SEQUENCE = "4242";

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  usdcIssuer: asset.issuer,
};
const seller: Seller = { id: "sel_1", name: "Seller", wallet: sellerWallet, profileKind: "individual", payoutFields: null, createdAt: 1 };

function sellers(): SellerRepository {
  return {
    findById: async () => seller,
    findByWallet: async () => seller,
    createIfAbsent: async () => seller,
    savePayoutFields: async () => {},
    saveProfileKind: async () => {},
  };
}

const present: RefundAccountSnapshot = { exists: true, dataAttr: {} };
const memoRequired: RefundAccountSnapshot = {
  exists: true,
  dataAttr: { "config.memo_required": Buffer.from("1").toString("base64") },
};

async function setup(
  opts: {
    account?: RefundAccountSnapshot;
    assertCanReceive?: () => Promise<void>;
    linkAsset?: { code: string; issuer: string | null };
    loadAccountSequence?: (accountId: string) => Promise<string>;
    withRefunds?: boolean;
  } = {},
) {
  const link = makeLink({
    id: "lnk_1",
    reference: "pl_abcdefghijkl",
    sellerId: seller.id,
    destination: sellerWallet,
    asset: opts.linkAsset ?? asset,
    status: "paid",
  });
  const links = new FakeLinkRepository([link]);
  const refunds = new FakeRefundRepository();
  const loadAccountSequence = vi.fn(opts.loadAccountSequence ?? (async () => SEQUENCE));
  const service = new LinkService({
    links,
    sellers: sellers(),
    webhooks: new FakeWebhookRepository(),
    rail: {
      buildRequest: () => {
        throw new Error("unused");
      },
      isValidDestination: () => true,
      assertCanReceive: opts.assertCanReceive ?? (async () => {}),
    },
    offramp: new ScriptedOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar,
    telemetry: new FakeTelemetryRepository(),
    correlation: "memo",
    loadRefundAccount: async () => opts.account ?? present,
    loadAccountSequence,
    ...(opts.withRefunds === false ? {} : { refunds }),
  });
  await links.recordPayment({
    linkId: "lnk_1",
    txHash,
    operationId,
    payer,
    amount: "10",
    asset: opts.linkAsset ?? asset,
    ledger: 1,
    createdAt: 1,
  });
  return { service, links, refunds, link, loadAccountSequence };
}

function decode(xdr: string): Transaction {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected the call to be refused");
}

describe("LinkService.prepareRefund (issue 4.59)", () => {
  it("returns an unsigned transaction with one payment: source, destination, asset, amount, memo and time bounds", async () => {
    const { service } = await setup();

    const prepared = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "4.5" }, NOW);

    const tx = decode(prepared.xdr);
    expect(tx.source).toBe(sellerWallet);
    // Built on the seller's current sequence, so it is the next transaction of that account.
    expect(tx.sequence).toBe(String(BigInt(SEQUENCE) + 1n));
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.Payment;
    expect(op.type).toBe("payment");
    expect(op.source).toBeUndefined();
    expect(op.destination).toBe(payer);
    expect(op.asset.getCode()).toBe("USDC");
    expect(op.asset.getIssuer()).toBe(asset.issuer);
    expect(op.amount).toBe("4.5000000");
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value?.toString()).toBe("refund pl_abcdefghijkl");
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(NOW / 1000 + REFUND_TX_TIMEOUT_S) });
    // Nobody signed it: that is the seller's wallet's job.
    expect(tx.signatures).toHaveLength(0);

    expect(prepared.networkPassphrase).toBe(Networks.TESTNET);
    expect(prepared.expiresAt).toBe("2026-11-26T12:05:00.000Z");
  });

  it("stores a prepared refund for the payment, with the id it returns", async () => {
    const { service, refunds } = await setup();

    const prepared = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "4.5" }, NOW);

    expect(prepared.refundId).toMatch(/^rfd_/);
    expect(await refunds.findById(prepared.refundId)).toEqual({
      id: prepared.refundId,
      linkId: "lnk_1",
      sellerId: seller.id,
      paymentTxHash: txHash,
      paymentOperationId: operationId,
      destination: payer,
      destinationMuxedId: null,
      memo: null,
      memoType: null,
      amount: "4.5",
      asset,
      status: "prepared",
      txHash: null,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("pays a native refund for a link priced in XLM", async () => {
    const { service } = await setup({ linkAsset: { code: "XLM", issuer: null } });
    const prepared = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW);
    expect((decode(prepared.xdr).operations[0] as Operation.Payment).asset.isNative()).toBe(true);
  });

  it("carries the buyer's own memo, in the type asked for, and stores it", async () => {
    const { service, refunds } = await setup({ account: memoRequired });

    const text = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1", memo: "deposit 7781" }, NOW);
    expect(decode(text.xdr).memo.value?.toString()).toBe("deposit 7781");
    expect(await refunds.findById(text.refundId)).toMatchObject({ memo: "deposit 7781", memoType: "text" });

    const id = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1", memo: "7781", memoType: "id" }, NOW);
    expect(decode(id.xdr).memo.type).toBe("id");
    expect(decode(id.xdr).memo.value).toBe("7781");
    expect(await refunds.findById(id.refundId)).toMatchObject({ memo: "7781", memoType: "id" });
  });

  it("refuses with memo_required when the account needs a memo and none was given, and reserves nothing", async () => {
    const { service, refunds } = await setup({ account: memoRequired });

    const err = await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW));

    expect(err.status).toBe(422);
    expect(err.message).toBe("refund_destination_cannot_receive");
    expect(err.extra).toMatchObject({ reason: "memo_required" });
    expect(await refunds.listByPayment(txHash, operationId)).toEqual([]);
  });

  it("refuses when the buyer cannot receive the asset, and reserves nothing", async () => {
    const { service, refunds } = await setup({
      assertCanReceive: async () => {
        throw new CannotReceiveError("no_trustline", "no trustline");
      },
    });

    const err = await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW));

    expect(err.status).toBe(422);
    expect(err.extra).toMatchObject({ reason: "no_trustline" });
    expect(await refunds.listByPayment(txHash, operationId)).toEqual([]);
  });

  it("refuses more than the payment has left with 409 and what is left", async () => {
    const { service, refunds } = await setup();
    await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "4" }, NOW);

    const err = await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "6.0000001" }, NOW));

    expect(err.status).toBe(409);
    expect(err.message).toBe("refund_exceeds_refundable");
    expect(err.extra).toEqual({ refundable: "6" });
    expect(await refunds.listByPayment(txHash, operationId)).toHaveLength(1);
    // Exactly what is left is fine.
    await expect(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "6" }, NOW)).resolves.toMatchObject({
      refundId: expect.any(String),
    });
  });

  it("lets exactly one of two concurrent requests win when together they exceed the payment", async () => {
    const { service, refunds } = await setup();

    const results = await Promise.allSettled([
      service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "6" }, NOW),
      service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "6" }, NOW),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(HttpError);
    expect((lost.reason as HttpError).status).toBe(409);
    expect((lost.reason as HttpError).extra).toEqual({ refundable: "4" });
    expect(await refunds.listByPayment(txHash, operationId)).toHaveLength(1);
  });

  it.each([
    ["0", "not_positive"],
    ["-1", "not_positive"],
    ["abc", "invalid_amount"],
    ["1.00000001", "too_many_decimals"],
  ])("refuses the amount %j as invalid (%s)", async (amount, reason) => {
    const { service, refunds } = await setup();
    const err = await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount }, NOW));
    expect(err.status).toBe(400);
    expect(err.message).toBe("invalid_refund_amount");
    expect(err.extra).toEqual({ reason });
    expect(await refunds.listByPayment(txHash, operationId)).toEqual([]);
  });

  it("answers 404 for an unknown link and for a payment the link does not have, and 400 for a malformed payment key", async () => {
    const { service } = await setup();
    expect((await rejection(service.prepareRefund("lnk_none", { payment: PAYMENT, amount: "1" }, NOW))).status).toBe(404);
    expect((await rejection(service.prepareRefund("lnk_1", { payment: `${txHash}:9999`, amount: "1" }, NOW))).status).toBe(404);
    const bad = await rejection(service.prepareRefund("lnk_1", { payment: "no-colon", amount: "1" }, NOW));
    expect([bad.status, bad.message]).toEqual([400, "invalid_payment"]);
  });

  it("releases the amount of a prepared refund once its time bounds have passed", async () => {
    const { service, refunds } = await setup();
    const first = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "10" }, NOW);

    // One second before it expires the whole payment is still reserved.
    const stillHeld = NOW + (REFUND_TX_TIMEOUT_S - 1) * 1000;
    expect((await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, stillHeld))).status).toBe(409);
    expect((await refunds.findById(first.refundId))?.status).toBe("prepared");

    // At the expiry the next request marks it failed and gets the amount.
    const expired = NOW + REFUND_TX_TIMEOUT_S * 1000;
    const second = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "10" }, expired);
    expect(await refunds.findById(first.refundId)).toMatchObject({ status: "failed", failureReason: "expired_unsigned" });
    expect((await refunds.findById(second.refundId))?.status).toBe("prepared");
  });

  it("does not expire a refund that was already submitted", async () => {
    const { service, refunds } = await setup();
    const first = await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "10" }, NOW);
    await refunds.update(first.refundId, { status: "submitted", txHash: "b".repeat(64) });

    const later = NOW + 10 * REFUND_TX_TIMEOUT_S * 1000;
    expect((await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, later))).status).toBe(409);
    expect((await refunds.findById(first.refundId))?.status).toBe("submitted");
  });

  it("reserves nothing when the seller's sequence cannot be loaded", async () => {
    const { service, refunds } = await setup({
      loadAccountSequence: async () => {
        throw new Error("horizon down");
      },
    });
    await expect(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW)).rejects.toThrow("horizon down");
    expect(await refunds.listByPayment(txHash, operationId)).toEqual([]);
  });

  it("loads the sequence of the link's destination, the seller's wallet", async () => {
    const { service, loadAccountSequence } = await setup();
    await service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW);
    expect(loadAccountSequence).toHaveBeenCalledExactlyOnceWith(sellerWallet);
  });

  it("answers 501 refunds_disabled when the service has no refund repository", async () => {
    const { service } = await setup({ withRefunds: false });
    const err = await rejection(service.prepareRefund("lnk_1", { payment: PAYMENT, amount: "1" }, NOW));
    expect([err.status, err.message]).toEqual([501, "refunds_disabled"]);
  });
});

describe("refundMemo", () => {
  it("defaults to `refund <reference>`, never the bare reference, within the 28-byte limit", () => {
    const memo = refundMemo({}, "pl_abcdefghijkl");
    expect(memo.type).toBe("text");
    expect(memo.value?.toString()).toBe("refund pl_abcdefghijkl");
    expect(memo.value?.toString()).not.toBe("pl_abcdefghijkl");
    expect(Buffer.byteLength("refund pl_abcdefghijkl")).toBeLessThanOrEqual(28);
  });

  it("uses the buyer's memo as text unless another type is named", () => {
    expect(refundMemo({ memo: "deposit 1" }, "ref")).toEqual(Memo.text("deposit 1"));
    expect(refundMemo({ memo: "12345", memoType: "id" }, "ref")).toEqual(Memo.id("12345"));
    expect(refundMemo({ memo: "c".repeat(64), memoType: "hash" }, "ref")).toEqual(Memo.hash("c".repeat(64)));
  });

  it.each([
    [{ memo: "x".repeat(29) }, "text longer than 28 bytes"],
    [{ memo: "not-a-number", memoType: "id" as const }, "an id that is not a number"],
    [{ memo: "abc", memoType: "hash" as const }, "a hash that is not 32 bytes of hex"],
    [{ memoType: "id" as const }, "a type with no memo"],
  ] as [Parameters<typeof refundMemo>[0], string][])("refuses %j (%s) with 400 invalid_memo", (input) => {
    try {
      refundMemo(input, "ref");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect([(err as HttpError).status, (err as HttpError).message]).toEqual([400, "invalid_memo"]);
      return;
    }
    throw new Error("expected a refusal");
  });
});
