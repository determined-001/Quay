import { CannotReceiveError, type CannotReceiveReason, type Seller, type SellerRepository } from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { HttpError, LinkService, checkRefundReceivingCapability, type RefundAccountSnapshot } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const asset = { code: "USDC", issuer: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)) };
const ready = { kind: "ready", destination: payer } as const;

describe("refund receiving preflight", () => {
  it("checks the recorded payer and passes the exact amount to the rail", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    const amount = "12.3400001";
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, amount, ready))
      .resolves.toEqual({ ok: true, destination: payer, memoRequired: false });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, amount);
  });

  it("preserves a muxed refund destination while checking the base account", async () => {
    const destination = StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(8, 3)]));
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "ready", destination }))
      .resolves.toEqual({ ok: true, destination, memoRequired: false });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "1");
  });

  it.each([
    ["account_not_found", /valid refund address/],
    ["no_trustline", /add the required trustline/],
    ["trustline_not_authorized", /asset issuer/],
    ["trustline_limit_exceeded", /increase the limit/],
  ] satisfies [CannotReceiveReason, RegExp][])("offers a next step for %s", async (reason, message) => {
    const rail = { assertCanReceive: vi.fn().mockRejectedValue(new CannotReceiveError(reason, "internal details")) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready))
      .resolves.toEqual({ ok: false, reason, message: expect.stringMatching(message) });
  });

  it("rejects a missing account found during destination resolution", async () => {
    const rail = { assertCanReceive: vi.fn() };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "account_gone" }))
      .resolves.toMatchObject({ ok: false, reason: "account_not_found" });
    expect(rail.assertCanReceive).not.toHaveBeenCalled();
  });

  it("sets memoRequired from the destination's SEP-29 entry instead of leaving it false", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    const data = { "config.memo_required": Buffer.from("1").toString("base64") };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready, data))
      .resolves.toEqual({ ok: true, destination: payer, memoRequired: true });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "1");
  });

  it("keeps memoRequired false when the destination's entry is not 1", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    const data = { "config.memo_required": Buffer.from("0").toString("base64") };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready, data))
      .resolves.toEqual({ ok: true, destination: payer, memoRequired: false });
  });

  it("reports memoRequired when the resolution and the account entry both require a memo", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    const data = { "config.memo_required": "1" };
    await expect(
      checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "needs_memo", destination: payer }, data),
    ).resolves.toEqual({ ok: true, destination: payer, memoRequired: true });
  });

  it("requires the buyer's deposit memo after receiving checks pass", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "needs_memo", destination: payer }))
      .resolves.toEqual({
        ok: false,
        reason: "memo_required",
        message: expect.stringContaining("correct deposit memo"),
      });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "1");
  });

  it.each(["0", "-1", "NaN", "+1", "1.", "1e-7", "0.00000001", " 1", "922337203685.4775808"])(
    "rejects invalid amount %j before calling the rail",
    async (amount) => {
      const rail = { assertCanReceive: vi.fn() };
      await expect(checkRefundReceivingCapability(rail, { payer }, asset, amount, ready))
        .rejects.toMatchObject({ status: 400, message: "invalid_refund_amount" });
      expect(rail.assertCanReceive).not.toHaveBeenCalled();
    },
  );

  it("propagates an unexpected rail failure", async () => {
    const error = new Error("Horizon unavailable");
    const rail = { assertCanReceive: vi.fn().mockRejectedValue(error) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready)).rejects.toBe(error);
  });
});

const seller: Seller = {
  id: "sel_1",
  name: "Demo Seller",
  wallet: "GSELLERWALLETADDRESS",
  profileKind: "individual",
  payoutFields: null,
  createdAt: 1,
};

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: asset.issuer!,
};

const txHash = "ab".repeat(32);
const operationId = "998877";

function sellers(): SellerRepository {
  return {
    findById: async () => seller,
    findByWallet: async () => seller,
    createIfAbsent: async () => seller,
    savePayoutFields: async () => {},
    saveProfileKind: async () => {},
  };
}

function serviceWith(account: RefundAccountSnapshot, assertCanReceive: () => Promise<void> = async () => {}) {
  const link = makeLink({ id: "lnk_1", sellerId: seller.id, asset, status: "paid" });
  const links = new FakeLinkRepository([link]);
  return {
    links,
    service: new LinkService({
      links,
      sellers: sellers(),
      webhooks: new FakeWebhookRepository(),
      rail: { buildRequest: () => { throw new Error("unused"); }, isValidDestination: () => true, assertCanReceive },
      offramp: new ScriptedOffRamp(),
      offrampState: new FakeOffRampStateRepository(),
      kyc: new AlwaysAcceptedKyc(),
      stellar,
      telemetry: new FakeTelemetryRepository(),
      correlation: "memo",
      loadRefundAccount: async () => account,
    }),
  };
}

describe("LinkService.refundPreflight", () => {
  const present: RefundAccountSnapshot = { exists: true, dataAttr: {} };

  async function paid(links: FakeLinkRepository) {
    await links.recordPayment({
      linkId: "lnk_1",
      txHash,
      operationId,
      payer,
      amount: "10",
      asset,
      ledger: 1,
      createdAt: 1,
    });
  }

  it("checks the buyer's G-address for the exact amount and reports no memo", async () => {
    const assertCanReceive = vi.fn(async () => {});
    const { links, service } = serviceWith(present, assertCanReceive);
    await paid(links);
    await expect(service.refundPreflight("lnk_1", `${txHash}:${operationId}`, "4.5")).resolves.toEqual({
      ok: true,
      destination: payer,
      memoRequired: false,
    });
    expect(assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "4.5");
  });

  it("sets memoRequired from the buyer's SEP-29 config.memo_required entry", async () => {
    const { links, service } = serviceWith({
      exists: true,
      dataAttr: { "config.memo_required": Buffer.from("1").toString("base64") },
    });
    await paid(links);
    await expect(service.refundPreflight("lnk_1", `${txHash}:${operationId}`, "1")).resolves.toEqual({
      ok: true,
      destination: payer,
      memoRequired: true,
    });
  });

  it("returns account_not_found without calling the rail when the buyer is gone", async () => {
    const assertCanReceive = vi.fn(async () => {});
    const { links, service } = serviceWith({ exists: false, dataAttr: {} }, assertCanReceive);
    await paid(links);
    await expect(service.refundPreflight("lnk_1", `${txHash}:${operationId}`, "1")).resolves.toMatchObject({
      ok: false,
      reason: "account_not_found",
    });
    expect(assertCanReceive).not.toHaveBeenCalled();
  });

  it("returns the rail's cannot-receive reason", async () => {
    const { links, service } = serviceWith(present, async () => {
      throw new CannotReceiveError("no_trustline", "internal");
    });
    await paid(links);
    await expect(service.refundPreflight("lnk_1", `${txHash}:${operationId}`, "1")).resolves.toMatchObject({
      ok: false,
      reason: "no_trustline",
    });
  });

  it("404s an unknown link and an unknown payment", async () => {
    const { links, service } = serviceWith(present);
    await expect(service.refundPreflight("lnk_missing", `${txHash}:${operationId}`, "1")).rejects.toMatchObject({
      status: 404,
      message: "not_found",
    });
    await expect(service.refundPreflight("lnk_1", `${txHash}:${operationId}`, "1")).rejects.toBeInstanceOf(HttpError);
    await paid(links);
    await expect(service.refundPreflight("lnk_1", `${txHash}:other`, "1")).rejects.toMatchObject({
      status: 404,
      message: "not_found",
    });
  });

  it("rejects a payment key that is not txHash:operationId", async () => {
    const { service } = serviceWith(present);
    await expect(service.refundPreflight("lnk_1", "no-colon", "1")).rejects.toMatchObject({
      status: 400,
      message: "invalid_payment",
    });
  });
});
