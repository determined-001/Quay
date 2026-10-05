import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AnchorAuthRequiredError, type AnchorCustomer } from "@checkout/core";
import { profileRoutes } from "../src/routes/profile";
import {
  DrizzleKycConsentRepository,
  DrizzleKycRepository,
  DrizzleSellerProfileRepository,
} from "../src/repos/index";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";
import type { Container } from "../src/services/container";
import {
  anchorSessions,
  kycConsents,
  kycDisclosureFields,
  links,
  sellerKyc,
  sellerProfile,
  sellers,
} from "../src/db/schema";
import type { DB } from "../src/db/client";
import { createTestContainer } from "./setup";

const DOMAIN = "testanchor.stellar.org";

type Delete = (customer: AnchorCustomer) => Promise<"deleted" | "not_found">;

async function seedIdentity(db: DB, sellerId: string, wallet: string, kycRepo: DrizzleKycRepository, key: Buffer) {
  const now = Date.now();
  await kycRepo.save({
    sellerId,
    account: wallet,
    anchorDomain: DOMAIN,
    customerId: `cust_${sellerId}`,
    status: "ACCEPTED",
    requiredFields: [],
    providedFields: { first_name: "Alice" },
    providedFieldStatus: [],
    sentFields: ["first_name"],
    message: null,
    lastSyncedAt: now,
    updatedAt: now,
  });
  await db.update(sellerKyc).set({ callbackTokenHash: "hash_" + sellerId }).where(eq(sellerKyc.sellerId, sellerId));
  await new DrizzleSellerProfileRepository(db, key).upsert(sellerId, { given_name: "Alice" }, "seller");
  await new DrizzleKycConsentRepository(db).grant({
    sellerId,
    anchorDomain: DOMAIN,
    fields: ["first_name"],
    grantedAt: now,
    revokedAt: null,
    grantedVia: "session",
    noticeVersion: "1.0",
  });
  await db.insert(kycDisclosureFields).values({ sellerId, anchorDomain: DOMAIN, fieldName: "first_name", sentAt: now });
  await db.insert(anchorSessions).values({
    sellerId,
    anchorDomain: DOMAIN,
    account: wallet,
    tokenEncrypted: "enc",
    expiresAt: now + 3_600_000,
    createdAt: now,
  });
  await db.update(sellers).set({ payoutFieldsJson: '{"bank":"044"}', payoutFieldsEncrypted: "enc" }).where(eq(sellers.id, sellerId));
  await db.insert(links).values({
    id: `lnk_${sellerId}`,
    reference: `ref_${sellerId}`,
    sellerId,
    destination: wallet,
    title: "Kept",
    amount: "1.00",
    assetCode: "USDC",
    status: "paid",
    createdAt: now,
    updatedAt: now,
  });
}

async function counts(db: DB, sellerId: string) {
  const n = async (t: any) => (await db.select().from(t).where(eq(t.sellerId, sellerId))).length;
  return {
    kyc: await n(sellerKyc),
    profile: await n(sellerProfile),
    consents: await n(kycConsents),
    disclosures: await n(kycDisclosureFields),
    sessions: await n(anchorSessions),
    links: await n(links),
  };
}

async function harness(deleteAnchorCustomer: Delete | null) {
  const container = await createTestContainer();
  const key = randomBytes(32);
  const kycRepo = new DrizzleKycRepository(container.db, key);
  const app = profileRoutes({
    ...container,
    sellerProfile: new DrizzleSellerProfileRepository(container.db, key),
    anchorDomain: deleteAnchorCustomer ? DOMAIN : null,
    deleteAnchorCustomer,
  } as unknown as Container);

  const seller = container.seller;
  const other = await container.sellers.createIfAbsent("GB_OTHER_SELLER_WALLET_FOR_ERASURE_TEST_000000000000000000");
  await seedIdentity(container.db, seller.id, seller.wallet, kycRepo, key);
  await seedIdentity(container.db, other.id, other.wallet, kycRepo, key);

  const token = await container.tokenFor(seller.id, seller.wallet);
  const session = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const erase = (body: unknown, headers: Record<string, string> = session) =>
    app.request("/", { method: "DELETE", headers, body: JSON.stringify(body) });
  return { container, seller, other, session, erase };
}

describe("DELETE /seller/profile (issue 239)", () => {
  it("erases every identity row for the caller only, calling the anchor with the caller's account", async () => {
    const calls: AnchorCustomer[] = [];
    const h = await harness(async (c) => {
      calls.push(c);
      return "deleted";
    });
    const { db } = h.container;
    expect(await counts(db, h.seller.id)).toEqual({ kyc: 1, profile: 1, consents: 1, disclosures: 1, sessions: 1, links: 1 });

    const res = await h.erase({ confirm: h.seller.wallet });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.erased).toEqual(["profile", "kyc", "consents", "anchor_sessions", "payout_fields"]);
    expect(body.anchors).toEqual([{ anchorDomain: DOMAIN, result: "erased" }]);
    expect(body.retained.map((r: any) => r.what)).toEqual(
      expect.arrayContaining(["payment history", "database backups"]),
    );
    expect(calls).toEqual([{ sellerId: h.seller.id, account: h.seller.wallet }]);

    // Caller: identity gone, callback hash gone with the kyc row, financial rows and seller row kept.
    expect(await counts(db, h.seller.id)).toEqual({ kyc: 0, profile: 0, consents: 0, disclosures: 0, sessions: 0, links: 1 });
    const [row] = await db.select().from(sellers).where(eq(sellers.id, h.seller.id));
    expect(row!.payoutFieldsJson).toBeNull();
    expect(row!.payoutFieldsEncrypted).toBeNull();

    // Other seller untouched.
    expect(await counts(db, h.other.id)).toEqual({ kyc: 1, profile: 1, consents: 1, disclosures: 1, sessions: 1, links: 1 });
    const [otherKyc] = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, h.other.id));
    expect(otherKyc!.callbackTokenHash).toBe("hash_" + h.other.id);
    const [otherRow] = await db.select().from(sellers).where(eq(sellers.id, h.other.id));
    expect(otherRow!.payoutFieldsJson).not.toBeNull();
    h.container.client.close();
  });

  it("still completes when the anchor holds nothing (404)", async () => {
    const h = await harness(async () => "not_found");
    const res = await h.erase({ confirm: h.seller.wallet });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).anchors).toEqual([{ anchorDomain: DOMAIN, result: "not_held" }]);
    expect((await counts(h.container.db, h.seller.id)).kyc).toBe(0);
    h.container.client.close();
  });

  it("reports not_attempted:no_session and still erases locally", async () => {
    const h = await harness(async () => {
      throw new AnchorAuthRequiredError(DOMAIN);
    });
    const res = await h.erase({ confirm: h.seller.wallet });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).anchors).toEqual([{ anchorDomain: DOMAIN, result: "not_attempted:no_session" }]);
    expect(await counts(h.container.db, h.seller.id)).toMatchObject({ kyc: 0, profile: 0, consents: 0, sessions: 0 });
    h.container.client.close();
  });

  it("reports refused:<status> without leaking details, and still erases locally", async () => {
    const h = await harness(async () => {
      throw new Error("SEP-12 customer DELETE failed: 451");
    });
    const res = await h.erase({ confirm: h.seller.wallet });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).anchors).toEqual([{ anchorDomain: DOMAIN, result: "refused:451" }]);
    expect((await counts(h.container.db, h.seller.id)).profile).toBe(0);
    h.container.client.close();
  });

  it("erases locally with no anchors when the deployment has no real anchor", async () => {
    const h = await harness(null);
    const res = await h.erase({ confirm: h.seller.wallet });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).anchors).toEqual([]);
    expect((await counts(h.container.db, h.seller.id)).kyc).toBe(0);
    h.container.client.close();
  });

  it("rejects an API key with 403 and changes nothing", async () => {
    let called = false;
    const h = await harness(async () => {
      called = true;
      return "deleted";
    });
    const { plaintext, prefix } = generateApiKey("test");
    await h.container.apiKeys.create({
      sellerId: h.seller.id,
      name: "k",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes: ["offramp:initiate"],
    });
    const res = await h.erase(
      { confirm: h.seller.wallet },
      { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
    );
    expect(res.status).toBe(403);
    expect(called).toBe(false);
    expect((await counts(h.container.db, h.seller.id)).kyc).toBe(1);
    h.container.client.close();
  });

  it("rejects a missing or wrong confirmation (including another seller's wallet) with 400", async () => {
    let called = false;
    const h = await harness(async () => {
      called = true;
      return "deleted";
    });
    for (const body of [{}, { confirm: "" }, { confirm: "nope" }, { confirm: h.other.wallet }]) {
      expect((await h.erase(body)).status).toBe(400);
    }
    expect(called).toBe(false);
    expect((await counts(h.container.db, h.seller.id)).kyc).toBe(1);
    expect((await counts(h.container.db, h.other.id)).kyc).toBe(1);
    h.container.client.close();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const h = await harness(async () => "deleted");
    const res = await h.erase({ confirm: h.seller.wallet }, { "content-type": "application/json" });
    expect(res.status).toBe(401);
    h.container.client.close();
  });
});
