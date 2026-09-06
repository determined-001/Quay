import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { publicRoutes } from "../../src/routes/public";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  GET /r/:reference — the public receipt.
//
//  A receipt is served to anyone holding the link, so what it must NOT carry
//  matters as much as what it does: the seller's identity and the off-ramp
//  economics stay off it.
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono;

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.route("/r", publicRoutes(container));
});

afterAll(() => {
  container.client.close();
});

async function paidLink(over: Record<string, unknown> = {}) {
  const seller = container.seller;
  const link = await container.links.create({
    id: `lnk_${Math.random().toString(36).slice(2, 10)}`,
    reference: `pl_${Math.random().toString(36).slice(2, 10)}`,
    sellerId: seller.id,
    destination: seller.wallet,
    muxedId: null,
    title: "Receipt test",
    amount: "10",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    expiresAt: null,
  });
  Object.assign(link, { status: "paid", txHash: "tx_paid_1", payer: "GBUYER", paidAmount: "10" }, over);
  await container.links.save(link);
  return link;
}

describe("GET /r/:reference", () => {
  it("does not leak the seller or off-ramp economics onto a public receipt", async () => {
    const link = await paidLink();
    const res = await app.request(`/r/${link.reference}`);
    const body = (await res.json()) as Record<string, unknown>;

    for (const leak of ["sellerId", "offrampRate", "offrampFeeAmount", "offrampNetTargetAmount"]) {
      expect(body).not.toHaveProperty(leak);
    }
  });

  it("404s an unpaid link — an unpaid link is not a receipt", async () => {
    const seller = container.seller;
    const link = await container.links.create({
      id: "lnk_unpaid_receipt",
      reference: "pl_unpaid_receipt",
      sellerId: seller.id,
      destination: seller.wallet,
      muxedId: null,
      title: "Unpaid",
      amount: "10",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });

    const res = await app.request(`/r/${link.reference}`);
    expect(res.status).toBe(404);
  });
});
