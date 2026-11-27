import { describe, it, expect, beforeEach, vi } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  makeLink,
} from "./fakes";
import { FakeRefundRepository } from "./fakes";
import type { Refund } from "@checkout/core";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const stellar = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  usdcIssuer: ISSUER,
  networkPassphrase: "Test SDF Network ; September 2015",
};

function makeService(refunds: FakeRefundRepository, links: FakeLinkRepository, hooks: FakeWebhookRepository) {
  const seller = { id: "s_1", name: "Demo", wallet: DEST, profileKind: "individual", payoutFields: null, createdAt: 1 };
  return new LinkService({
    links,
    sellers: { findById: async () => seller, findByWallet: async () => seller, createIfAbsent: async () => seller, savePayoutFields: async () => {}, saveProfileKind: async () => {} },
    webhooks: hooks,
    rail: { buildRequest: () => ({} as any), isValidDestination: () => true, assertCanReceive: async () => {} },
    offramp: { mode: "seller_initiated", quote: async () => ({} as any), initiate: async () => ({} as any), status: async () => ({} as any), offrampRequirements: async () => ({ types: [], defaultType: null }) },
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar,
    telemetry: new FakeTelemetryRepository(),
    correlation: "memo",
    refunds,
  } as any);
}

describe("refund webhooks", () => {
  let links: FakeLinkRepository;
  let refunds: FakeRefundRepository;
  let hooks: FakeWebhookRepository;

  beforeEach(async () => {
    links = new FakeLinkRepository();
    refunds = new FakeRefundRepository();
    hooks = new FakeWebhookRepository();
    await hooks.create({ sellerId: "s_1", url: "https://example.com/h", secret: "test-secret" });
    await links.save(makeLink({ id: "lnk_1", reference: "ref_1", status: "paid", sellerId: "s_1", destination: DEST, amount: "10", asset: { code: "USDC", issuer: ISSUER }, txHash: "p".repeat(64), paidAmount: "10" }));
    // record a payment
    await links.recordPayment({ linkId: "lnk_1", txHash: "p".repeat(64), operationId: "1", payer: "GBUYER", amount: "10", asset: { code: "USDC", issuer: ISSUER }, ledger: 1, createdAt: 1 });
  });

  it("fires link.refunded on confirmed transition", async () => {
    const refundTx = "r".repeat(64);
    const refund: Refund = {
      id: "rfd_1",
      linkId: "lnk_1",
      sellerId: "s_1",
      paymentTxHash: "p".repeat(64),
      paymentOperationId: "1",
      destination: "GBUYER",
      destinationMuxedId: null,
      memo: null,
      memoType: null,
      amount: "0.5",
      asset: { code: "USDC", issuer: ISSUER },
      status: "submitted",
      txHash: refundTx,
      failureReason: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await refunds.create(refund);

    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: () => ({ call: async () => ({ successful: true }) }),
    } as any);

    const service = makeService(refunds, links, hooks);
    await service.pollRefunds();

    const queued = hooks.queue;
    expect(queued.some((q) => JSON.parse(q.payload).event === "link.refunded")).toBe(true);
    const ev = queued.map((q) => JSON.parse(q.payload)).find((q) => q.event === "link.refunded");
    expect(ev.data.txHash).toBe("p".repeat(64));
    expect(ev.data.refundId).toBe("rfd_1");
    expect(ev.data.refundAmount).toBe("0.5");
    expect(ev.data.refundTxHash).toBe(refundTx);
    expect(ev.data.paymentTxHash).toBe("p".repeat(64));
    expect(ev.data.fullyRefunded).toBe(false);
  });

  it("fires refund.failed when submitted tx fails", async () => {
    const refundTx = "r".repeat(64);
    const refund: Refund = {
      id: "rfd_2",
      linkId: "lnk_1",
      sellerId: "s_1",
      paymentTxHash: "p".repeat(64),
      paymentOperationId: "1",
      destination: "GBUYER",
      destinationMuxedId: null,
      memo: null,
      memoType: null,
      amount: "0.5",
      asset: { code: "USDC", issuer: ISSUER },
      status: "submitted",
      txHash: refundTx,
      failureReason: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await refunds.create(refund);

    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: () => ({ call: async () => ({ successful: false }) }),
    } as any);

    const service = makeService(refunds, links, hooks);
    await service.pollRefunds();

    const queued = hooks.queue;
    const ev = queued.map((q) => JSON.parse(q.payload)).find((q) => q.event === "refund.failed");
    expect(ev).toBeDefined();
    expect(ev.data.txHash).toBe("p".repeat(64));
    expect(ev.data.refundId).toBe("rfd_2");
    expect(ev.data.refundAmount).toBe("0.5");
    expect(ev.data.reason).toBeDefined();
  });

  it("prepared refund expiry fires no webhook", async () => {
    const refund: Refund = {
      id: "rfd_3",
      linkId: "lnk_1",
      sellerId: "s_1",
      paymentTxHash: "p".repeat(64),
      paymentOperationId: "1",
      destination: "GBUYER",
      destinationMuxedId: null,
      memo: null,
      memoType: null,
      amount: "0.5",
      asset: { code: "USDC", issuer: ISSUER },
      status: "prepared",
      txHash: null,
      failureReason: null,
      createdAt: 0,
      updatedAt: 0,
    };
    await refunds.create(refund);

    const service = makeService(refunds, links, hooks);
    await service.pollRefunds();

    const queued = hooks.queue;
    expect(queued.some((q) => {
      const e = JSON.parse(q.payload).event;
      return e === "refund.failed" || e === "link.refunded";
    })).toBe(false);
  });

  it("overlapping ticks fire once", async () => {
    const refundTx = "r".repeat(64);
    const refund: Refund = {
      id: "rfd_4",
      linkId: "lnk_1",
      sellerId: "s_1",
      paymentTxHash: "p".repeat(64),
      paymentOperationId: "1",
      destination: "GBUYER",
      destinationMuxedId: null,
      memo: null,
      memoType: null,
      amount: "0.5",
      asset: { code: "USDC", issuer: ISSUER },
      status: "submitted",
      txHash: refundTx,
      failureReason: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await refunds.create(refund);

    vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({
      transaction: () => ({ call: async () => ({ successful: true }) }),
    } as any);

    const service = makeService(refunds, links, hooks);
    await service.pollRefunds();
    await service.pollRefunds();

    const events = hooks.queue.map((q) => JSON.parse(q.payload).event);
    expect(events.filter((e) => e === "link.refunded").length).toBe(1);
  });
});
