import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { anchorSessions, links, sellerKyc, sellers } from "../src/db/schema";
import { DrizzleKycRepository, DrizzleSellerRepository } from "../src/repos/index";
import { runKycRetentionSweep, eraseSellerIdentityLocal } from "../src/services/kyc-retention";
import { eq } from "drizzle-orm";

const DAY_MS = 86_400_000;

async function makeDb() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return { db, client };
}

async function seedSellerWithKycAndSession(
  db: DB,
  opts: {
    sellerId: string;
    wallet: string;
    lastActiveAt?: number | null;
    createdAt?: number;
    hasPendingCashOut?: boolean;
  },
) {
  const now = Date.now();
  const createdAt = opts.createdAt ?? now;
  const lastActiveAt = opts.lastActiveAt === undefined ? now : opts.lastActiveAt;

  await db.insert(sellers).values({
    id: opts.sellerId,
    name: "Test Seller",
    wallet: opts.wallet,
    payoutFieldsJson: JSON.stringify({ bank_account: "1234567890", bank_code: "044" }),
    lastActiveAt,
    createdAt,
  });

  const kycRepo = new DrizzleKycRepository(db, randomBytes(32));
  await kycRepo.save({
    sellerId: opts.sellerId,
    account: opts.wallet,
    customerId: "cust_123",
    status: "ACCEPTED",
    requiredFields: [{ name: "first_name", type: "string", optional: false }],
    providedFields: { first_name: "Alice", last_name: "Smith" },
    message: null,
    lastSyncedAt: createdAt,
    updatedAt: createdAt,
  });

  await db.insert(anchorSessions).values({
    sellerId: opts.sellerId,
    anchorDomain: "anchor.example.com",
    account: opts.wallet,
    tokenEncrypted: "enc_token_xyz",
    expiresAt: now + 3600_000,
    createdAt,
  });

  if (opts.hasPendingCashOut) {
    await db.insert(links).values({
      id: `lnk_${opts.sellerId}`,
      reference: `ref_${opts.sellerId}`,
      sellerId: opts.sellerId,
      destination: opts.wallet,
      title: "Pending Item",
      amount: "10.00",
      assetCode: "USDC",
      status: "offramp_pending",
      createdAt,
      updatedAt: createdAt,
    });
  }
}

describe("KYC Retention Policy (NDPA Compliance)", () => {
  it("purges KYC data, anchor sessions, and payout fields for a seller inactive >730 days (731 days)", async () => {
    const { db } = await makeDb();
    const now = 2_000_000_000_000;
    const inactiveSince = now - 731 * DAY_MS;

    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_inactive",
      wallet: "GA_INACTIVE_731",
      lastActiveAt: inactiveSince,
      createdAt: inactiveSince,
    });

    const result = await runKycRetentionSweep({
      db,
      retentionDays: 730,
      now,
    });

    expect(result.eligibleCount).toBe(1);
    expect(result.purgedCount).toBe(1);
    expect(result.skippedPendingCashOutCount).toBe(0);
    expect(result.anchorStatus).toBe("anchor_not_contacted");

    // Verify KYC row is deleted
    const kycRows = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_inactive"));
    expect(kycRows).toHaveLength(0);

    // Verify anchor session is deleted
    const sessionRows = await db.select().from(anchorSessions).where(eq(anchorSessions.sellerId, "sel_inactive"));
    expect(sessionRows).toHaveLength(0);

    // Verify payoutFieldsJson is cleared to null
    const [sellerRow] = await db.select().from(sellers).where(eq(sellers.id, "sel_inactive"));
    expect(sellerRow).toBeDefined();
    expect(sellerRow!.payoutFieldsJson).toBeNull();
    // Seller row itself remains
    expect(sellerRow!.wallet).toBe("GA_INACTIVE_731");
  });

  it("keeps identity data for a seller inactive <730 days (729 days)", async () => {
    const { db } = await makeDb();
    const now = 2_000_000_000_000;
    const activeSince = now - 729 * DAY_MS;

    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_active",
      wallet: "GA_ACTIVE_729",
      lastActiveAt: activeSince,
      createdAt: activeSince,
    });

    const result = await runKycRetentionSweep({
      db,
      retentionDays: 730,
      now,
    });

    expect(result.eligibleCount).toBe(0);
    expect(result.purgedCount).toBe(0);

    const kycRows = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_active"));
    expect(kycRows).toHaveLength(1);

    const sessionRows = await db.select().from(anchorSessions).where(eq(anchorSessions.sellerId, "sel_active"));
    expect(sessionRows).toHaveLength(1);

    const [sellerRow] = await db.select().from(sellers).where(eq(sellers.id, "sel_active"));
    expect(sellerRow!.payoutFieldsJson).not.toBeNull();
  });

  it("keeps identity data for an inactive seller who has a pending cash-out (offramp_pending)", async () => {
    const { db } = await makeDb();
    const now = 2_000_000_000_000;
    const inactiveSince = now - 800 * DAY_MS;

    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_pending",
      wallet: "GA_PENDING_CASHOUT",
      lastActiveAt: inactiveSince,
      createdAt: inactiveSince,
      hasPendingCashOut: true,
    });

    const result = await runKycRetentionSweep({
      db,
      retentionDays: 730,
      now,
    });

    expect(result.eligibleCount).toBe(0);
    expect(result.purgedCount).toBe(0);
    expect(result.skippedPendingCashOutCount).toBe(1);

    const kycRows = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_pending"));
    expect(kycRows).toHaveLength(1);

    const [sellerRow] = await db.select().from(sellers).where(eq(sellers.id, "sel_pending"));
    expect(sellerRow!.payoutFieldsJson).not.toBeNull();
  });

  it("purges nothing when KYC_RETENTION_DAYS = 0 (disabled)", async () => {
    const { db } = await makeDb();
    const now = 2_000_000_000_000;
    const inactiveSince = now - 1000 * DAY_MS;

    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_disabled",
      wallet: "GA_DISABLED_RETENTION",
      lastActiveAt: inactiveSince,
      createdAt: inactiveSince,
    });

    const result = await runKycRetentionSweep({
      db,
      retentionDays: 0,
      now,
    });

    expect(result.eligibleCount).toBe(0);
    expect(result.purgedCount).toBe(0);

    const kycRows = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_disabled"));
    expect(kycRows).toHaveLength(1);
  });

  it("dryRun reports eligible counts without modifying the database", async () => {
    const { db } = await makeDb();
    const now = 2_000_000_000_000;
    const inactiveSince = now - 900 * DAY_MS;

    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_dryrun",
      wallet: "GA_DRY_RUN",
      lastActiveAt: inactiveSince,
      createdAt: inactiveSince,
    });

    const result = await runKycRetentionSweep({
      db,
      retentionDays: 730,
      now,
      dryRun: true,
    });

    expect(result.eligibleCount).toBe(1);
    expect(result.purgedCount).toBe(0);
    expect(result.dryRun).toBe(true);

    // Database is unmodified
    const kycRows = await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_dryrun"));
    expect(kycRows).toHaveLength(1);

    const [sellerRow] = await db.select().from(sellers).where(eq(sellers.id, "sel_dryrun"));
    expect(sellerRow!.payoutFieldsJson).not.toBeNull();
  });

  it("eraseSellerIdentityLocal erases all identity artifacts for a single seller", async () => {
    const { db } = await makeDb();
    await seedSellerWithKycAndSession(db, {
      sellerId: "sel_direct_erase",
      wallet: "GA_DIRECT_ERASE",
    });

    await eraseSellerIdentityLocal(db, "sel_direct_erase");

    expect(await db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, "sel_direct_erase"))).toHaveLength(0);
    expect(await db.select().from(anchorSessions).where(eq(anchorSessions.sellerId, "sel_direct_erase"))).toHaveLength(0);
    const [seller] = await db.select().from(sellers).where(eq(sellers.id, "sel_direct_erase"));
    expect(seller!.payoutFieldsJson).toBeNull();
  });

  it("touchLastActive throttles writes to once per hour", async () => {
    const { db } = await makeDb();
    const repo = new DrizzleSellerRepository(db);

    const seller = await repo.createIfAbsent("GA_THROTTLE_TEST");
    await db.update(sellers).set({ lastActiveAt: null }).where(eq(sellers.id, seller.id));
    const t0 = 1_700_000_000_000;

    // First touch at t0 (from null -> t0)
    await repo.touchLastActive(seller.id, t0, 3600_000);
    let s = await repo.findById(seller.id);
    expect(s?.lastActiveAt).toBe(t0);

    // Second touch 30 minutes later (throttled, should not update)
    await repo.touchLastActive(seller.id, t0 + 30 * 60 * 1000, 3600_000);
    s = await repo.findById(seller.id);
    expect(s?.lastActiveAt).toBe(t0);

    // Third touch 61 minutes later (elapsed > 1h, should update)
    const t1 = t0 + 61 * 60 * 1000;
    await repo.touchLastActive(seller.id, t1, 3600_000);
    s = await repo.findById(seller.id);
    expect(s?.lastActiveAt).toBe(t1);
  });

  it("bootstrap backfills last_active_at on legacy sellers from max activity", async () => {
    const { client, db } = createDb(":memory:");
    // Setup legacy table without last_active_at initially
    await client.execute(`
      CREATE TABLE sellers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE,
        payout_fields_json TEXT, created_at INTEGER NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE links (
        id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
        destination TEXT NOT NULL, muxed_id TEXT, title TEXT NOT NULL, amount TEXT NOT NULL,
        asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
        tx_hash TEXT, payer TEXT, paid_amount TEXT, overpaid_amount TEXT,
        offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
        offramp_indicative_rate TEXT, offramp_rate TEXT, offramp_rate_delta TEXT,
        offramp_fee_amount TEXT, offramp_fee_currency TEXT, offramp_fee_source TEXT,
        offramp_net_target_amount TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);

    const tCreated = 1_000_000;
    const tLink = 2_000_000;

    await client.execute({
      sql: "INSERT INTO sellers (id, name, wallet, payout_fields_json, created_at) VALUES (?, ?, ?, ?, ?)",
      args: ["sel_legacy", "Legacy", "G_LEGACY", null, tCreated],
    });
    await client.execute({
      sql: `INSERT INTO links (id, reference, seller_id, destination, title, amount, asset_code, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["lnk_leg", "ref_leg", "sel_legacy", "G_LEGACY", "Title", "1.00", "USDC", "paid", tLink, tLink],
    });

    // Run bootstrap migration
    await bootstrap(client);

    const [row] = await db.select().from(sellers).where(eq(sellers.id, "sel_legacy"));
    expect(row!.lastActiveAt).toBe(tLink);
  });
});
