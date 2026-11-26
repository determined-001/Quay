import { describe, expect, it } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleLinkRepository, DrizzleSellerRepository } from "../src/repos/index";

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  const sellers = new DrizzleSellerRepository(db);
  const seller = await sellers.createIfAbsent("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV");
  const links = new DrizzleLinkRepository(db);
  return { links, seller, client, db };
}

describe("DrizzleLinkRepository claimForCashOut / releaseCashOutClaim", () => {
  it("atomically claims a paid link for cash-out, and second claim fails", async () => {
    const { links, seller } = await freshRepo();
    const link = await links.create({
      id: "lnk_test_1",
      reference: "ref_test_1",
      sellerId: seller.id,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Test item",
      amount: "10.00",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });

    // Mark paid
    link.status = "paid";
    await links.save(link);

    // First claim succeeds
    const claimed1 = await links.claimForCashOut(link.id, ["paid", "offramp_failed"]);
    expect(claimed1).toBe(true);

    const reloaded = await links.findById(link.id);
    expect(reloaded?.status).toBe("offramp_pending");

    // Second claim fails because status is now offramp_pending
    const claimed2 = await links.claimForCashOut(link.id, ["paid", "offramp_failed"]);
    expect(claimed2).toBe(false);
  });

  it("claims an offramp_failed link for retry", async () => {
    const { links, seller } = await freshRepo();
    const link = await links.create({
      id: "lnk_test_2",
      reference: "ref_test_2",
      sellerId: seller.id,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Test item",
      amount: "10.00",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });

    link.status = "offramp_failed";
    await links.save(link);

    const claimed = await links.claimForCashOut(link.id, ["paid", "offramp_failed"]);
    expect(claimed).toBe(true);

    const reloaded = await links.findById(link.id);
    expect(reloaded?.status).toBe("offramp_pending");
  });

  it("returns false for nonexistent link or non-admitted status", async () => {
    const { links, seller } = await freshRepo();
    expect(await links.claimForCashOut("lnk_nope", ["paid", "offramp_failed"])).toBe(false);

    const link = await links.create({
      id: "lnk_test_3",
      reference: "ref_test_3",
      sellerId: seller.id,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Active item",
      amount: "10.00",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });
    // Link is 'active', not in allowedStatuses
    expect(await links.claimForCashOut(link.id, ["paid", "offramp_failed"])).toBe(false);
  });

  it("releases claim back to specified status when link is offramp_pending", async () => {
    const { links, seller } = await freshRepo();
    const link = await links.create({
      id: "lnk_test_4",
      reference: "ref_test_4",
      sellerId: seller.id,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Test item",
      amount: "10.00",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });

    link.status = "paid";
    await links.save(link);

    await links.claimForCashOut(link.id, ["paid", "offramp_failed"]);
    expect((await links.findById(link.id))?.status).toBe("offramp_pending");

    await links.releaseCashOutClaim(link.id, "paid");
    expect((await links.findById(link.id))?.status).toBe("paid");
  });
});

// Issue 4.66: the buyer's side of a path payment is stored on the ledger row
// and read back verbatim; a plain payment leaves it NULL.
describe("DrizzleLinkRepository payment source side", () => {
  const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

  async function linkFor(links: DrizzleLinkRepository, sellerId: string) {
    return links.create({
      id: "lnk_source_side",
      reference: "ref_source_side",
      sellerId,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Path payment",
      amount: "10",
      asset: USDC,
      expiresAt: null,
    });
  }

  it("round-trips a path payment's source asset and amount, and NULL for a plain payment", async () => {
    const { links, seller } = await freshRepo();
    const link = await linkFor(links, seller.id);

    await links.recordPayment({
      linkId: link.id,
      txHash: "tx_path",
      operationId: "op_path",
      payer: "GBUYER",
      amount: "10.0000000",
      asset: USDC,
      ledger: 5,
      sourceAsset: { code: "XLM", issuer: null },
      sourceAmount: "24.1234567",
      createdAt: 1000,
    });
    await links.recordPayment({
      linkId: link.id,
      txHash: "tx_plain",
      operationId: "op_plain",
      payer: "GBUYER",
      amount: "10.0000000",
      asset: USDC,
      ledger: 6,
      createdAt: 2000,
    });

    const payments = await links.listPaymentsForLink(link.id);
    expect(payments).toHaveLength(2);
    expect(payments[0]!).toMatchObject({
      txHash: "tx_path",
      sourceAsset: { code: "XLM", issuer: null },
      sourceAmount: "24.1234567",
    });
    expect(payments[1]!).toMatchObject({ txHash: "tx_plain", sourceAsset: null, sourceAmount: null });
  });

  it("reads a row from before these columns existed as a plain payment", async () => {
    const { links, seller, client } = await freshRepo();
    const link = await linkFor(links, seller.id);

    await client.execute({
      sql: `INSERT INTO link_payments
        (id, link_id, tx_hash, operation_id, payer, amount, asset_code, asset_issuer, ledger,
         source_asset_code, source_asset_issuer, source_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      args: ["pmt_legacy", link.id, "tx_legacy", "op_legacy", "GBUYER", "10", USDC.code, USDC.issuer, 4, 1000],
    });

    const payments = await links.listPaymentsForLink(link.id);
    const payment = payments[0]!;
    expect(payment.amount).toBe("10");
    expect(payment.sourceAsset).toBeNull();
    expect(payment.sourceAmount).toBeNull();
  });
});

describe("DrizzleLinkRepository listPaymentsForLink (issue 4.58)", () => {
  const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

  it("returns one row per payer of a split-payment link, oldest first, and nothing from other links", async () => {
    const { links, seller } = await freshRepo();
    const base = {
      sellerId: seller.id,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Split dinner",
      amount: "10.00",
      asset: USDC,
      expiresAt: null,
    };
    await links.create({ ...base, id: "lnk_split", reference: "ref_split" });
    await links.create({ ...base, id: "lnk_other", reference: "ref_other" });

    const alice = {
      linkId: "lnk_split",
      txHash: "a".repeat(64),
      operationId: "2001",
      payer: "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      payerMuxed: null as string | null,
      amount: "6",
      asset: USDC,
      ledger: 100,
      createdAt: 2_000,
      sourceAsset: null,
      sourceAmount: null,
    };
    const bob = {
      ...alice,
      txHash: "b".repeat(64),
      operationId: "2002",
      payer: "GBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      // Bob paid from a sub-account of a custodial wallet (issue 2.14).
      payerMuxed: "MBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAAAAAAAAAAAACJUQ",
      amount: "4",
      ledger: 101,
      createdAt: 1_000,
    };
    await links.recordPayment(alice);
    await links.recordPayment(bob);
    await links.recordPayment({ ...alice, linkId: "lnk_other", txHash: "c".repeat(64) });

    expect(await links.listPaymentsForLink("lnk_split")).toEqual([bob, alice]);
    expect(await links.listPaymentsForLink("lnk_none")).toEqual([]);
  });
});
