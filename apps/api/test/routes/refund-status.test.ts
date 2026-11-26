import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Refund, RefundStatus } from "@checkout/core";
import { linkRoutes } from "../../src/routes/links";
import { publicRoutes } from "../../src/routes/public";
import { createTestContainer, type TestContainer } from "../setup";

// Issue 5.45 (#541): refunds on the seller's link detail and on the buyer's receipt.

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const BUYER = "GBUYERADDRESSTHATMUSTNEVERAPPEARONTHERECEIPT";
const asset = { code: "USDC", issuer: ISSUER };

let container: TestContainer;
let app: Hono;
let token = "";
let seq = 0;

const previous = process.env.REFUNDS_ENABLED;

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.route("/links", linkRoutes(container, async (_c, next) => next()));
  app.route("/r", publicRoutes(container));
  token = await container.tokenFor(container.seller.id, container.seller.wallet);
});

afterEach(() => {
  if (previous === undefined) delete process.env.REFUNDS_ENABLED;
  else process.env.REFUNDS_ENABLED = previous;
});

afterAll(() => {
  container.client.close();
});

/** A paid link with one 10 USDC payment. */
async function paidLink() {
  const n = ++seq;
  const link = await container.links.create({
    id: `lnk_refund_status_${n}`,
    reference: `pl_refund_status_${n}`,
    sellerId: container.seller.id,
    destination: container.seller.wallet,
    muxedId: null,
    title: "Refund status test",
    amount: "10",
    asset,
    expiresAt: null,
  });
  Object.assign(link, { status: "paid", txHash: `tx_pay_${n}`, payer: BUYER, paidAmount: "10" });
  await container.links.save(link);
  await container.links.recordPayment({
    linkId: link.id,
    txHash: `tx_pay_${n}`,
    operationId: `op_pay_${n}`,
    payer: BUYER,
    amount: "10.0000000",
    asset,
    ledger: n,
    createdAt: 1_000,
  });
  return { link, paymentTxHash: `tx_pay_${n}`, paymentOperationId: `op_pay_${n}` };
}

async function refund(
  paid: Awaited<ReturnType<typeof paidLink>>,
  status: RefundStatus,
  amount: string,
  createdAt: number,
): Promise<Refund> {
  const id = `rfd_status_${++seq}`;
  const row: Refund = {
    id,
    linkId: paid.link.id,
    sellerId: container.seller.id,
    paymentTxHash: paid.paymentTxHash,
    paymentOperationId: paid.paymentOperationId,
    destination: BUYER,
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount,
    asset,
    status,
    txHash: status === "prepared" ? null : `tx_${id}`,
    failureReason: status === "failed" ? "tx_failed" : null,
    createdAt,
    updatedAt: createdAt,
  };
  await container.refunds.create(row);
  return row;
}

async function detail(linkId: string) {
  const res = await app.request(`/links/${linkId}/detail`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function receipt(reference: string) {
  const res = await app.request(`/r/${reference}`);
  expect(res.status).toBe(200);
  return { body: (await res.json()) as Record<string, unknown>, text: JSON.stringify(await (await app.request(`/r/${reference}`)).json()) };
}

describe("GET /links/:id/detail refunds (issue 5.45)", () => {
  it.each([undefined, "0", "yes"])("has no refund fields when REFUNDS_ENABLED is %j", async (value) => {
    if (value === undefined) delete process.env.REFUNDS_ENABLED;
    else process.env.REFUNDS_ENABLED = value;
    const paid = await paidLink();
    await refund(paid, "confirmed", "4.5", 2_000);

    const body = await detail(paid.link.id);

    expect(body).not.toHaveProperty("refunds");
    expect(body).not.toHaveProperty("refundSummary");
  });

  it("lists every refund oldest first, with the totals", async () => {
    process.env.REFUNDS_ENABLED = "1";
    const paid = await paidLink();
    const failed = await refund(paid, "failed", "9", 4_000);
    const confirmed = await refund(paid, "confirmed", "4.5", 2_000);
    const submitted = await refund(paid, "submitted", "1", 3_000);

    const body = await detail(paid.link.id);

    expect((body.refunds as Refund[]).map((r) => r.id)).toEqual([confirmed.id, submitted.id, failed.id]);
    expect((body.refunds as Refund[])[0]).toMatchObject({ amount: "4.5", status: "confirmed", txHash: confirmed.txHash });
    // The failed refund counts for nothing; the submitted one is pending.
    expect(body.refundSummary).toEqual({ refundedAmount: "4.5", pendingAmount: "1", fullyRefunded: false });
  });

  it("reports a link refunded in full, and an empty list for a link with no refunds", async () => {
    process.env.REFUNDS_ENABLED = "true";
    const full = await paidLink();
    await refund(full, "confirmed", "6", 2_000);
    await refund(full, "confirmed", "4", 3_000);
    expect((await detail(full.link.id)).refundSummary).toEqual({
      refundedAmount: "10",
      pendingAmount: "0",
      fullyRefunded: true,
    });

    const none = await paidLink();
    const body = await detail(none.link.id);
    expect(body.refunds).toEqual([]);
    expect(body.refundSummary).toEqual({ refundedAmount: "0", pendingAmount: "0", fullyRefunded: false });
  });

  it("leaves the link's status as it was", async () => {
    process.env.REFUNDS_ENABLED = "1";
    const paid = await paidLink();
    await refund(paid, "confirmed", "10", 2_000);
    expect(((await detail(paid.link.id)).link as { status: string }).status).toBe("paid");
  });
});

describe("GET /r/:reference refunds (issue 5.45)", () => {
  it.each([undefined, "0", "yes"])("has no refund fields when REFUNDS_ENABLED is %j", async (value) => {
    if (value === undefined) delete process.env.REFUNDS_ENABLED;
    else process.env.REFUNDS_ENABLED = value;
    const paid = await paidLink();
    await refund(paid, "confirmed", "4.5", 2_000);

    const { body } = await receipt(paid.link.reference);

    expect(body).not.toHaveProperty("refundedAmount");
    expect(body).not.toHaveProperty("refunds");
  });

  it("shows only confirmed refunds, each as its amount and transaction hash", async () => {
    process.env.REFUNDS_ENABLED = "1";
    const paid = await paidLink();
    await refund(paid, "prepared", "1", 2_000);
    await refund(paid, "submitted", "1", 3_000);
    await refund(paid, "failed", "1", 4_000);
    const second = await refund(paid, "confirmed", "2", 6_000);
    const first = await refund(paid, "confirmed", "4.5", 5_000);

    const { body } = await receipt(paid.link.reference);

    expect(body.refundedAmount).toBe("6.5");
    expect(body.refunds).toEqual([
      { amount: "4.5", txHash: first.txHash },
      { amount: "2", txHash: second.txHash },
    ]);
  });

  it("never includes the refund destination, or anything else of the refund row", async () => {
    process.env.REFUNDS_ENABLED = "1";
    const paid = await paidLink();
    // The buyer was refunded at an address that is not the one they paid from.
    const elsewhere = "GREFUNDDESTINATIONTHATMUSTSTAYPRIVATE";
    const row = await refund(paid, "confirmed", "4.5", 2_000);
    const other: Refund = { ...row, id: `${row.id}_b`, destination: elsewhere, destinationMuxedId: "77", memo: "deposit 1", memoType: "text", txHash: "tx_elsewhere" };
    await container.refunds.create(other);

    const { body, text } = await receipt(paid.link.reference);

    for (const entry of body.refunds as Array<Record<string, unknown>>) {
      expect(Object.keys(entry).sort()).toEqual(["amount", "txHash"]);
    }
    expect(text).not.toContain(elsewhere);
    expect(text).not.toContain("deposit 1");
    expect(text).not.toContain(container.seller.id);
    expect(text).not.toContain("destination");
  });

  it("reports zero and an empty list for a receipt with no confirmed refund", async () => {
    process.env.REFUNDS_ENABLED = "1";
    const paid = await paidLink();
    await refund(paid, "submitted", "3", 2_000);

    const { body } = await receipt(paid.link.reference);

    expect(body.refundedAmount).toBe("0");
    expect(body.refunds).toEqual([]);
  });
});
