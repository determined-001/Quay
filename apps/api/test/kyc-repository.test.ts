import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KycRecord } from "@checkout/core";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { sellerKyc } from "../src/db/schema";
import { DrizzleKycRepository } from "../src/repos/index";

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

function record(over: Partial<KycRecord> = {}): KycRecord {
  return {
    sellerId: "sel_1",
    account: "GSELLER1",
    customerId: "cust_1",
    status: "ACCEPTED",
    requiredFields: [{ name: "first_name", type: "string", optional: false }],
    providedFields: { first_name: "Ada Lovelace", email_address: "ada@example.org" },
    message: null,
    lastSyncedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...over,
  };
}

describe("DrizzleKycRepository", () => {
  it("round-trips a saved record exactly", async () => {
    const repo = new DrizzleKycRepository(await makeDb(), randomBytes(32));
    await repo.save(record());
    expect(await repo.get("sel_1")).toEqual(record());
  });

  it("returns null for a seller with no KYC record", async () => {
    const repo = new DrizzleKycRepository(await makeDb(), randomBytes(32));
    expect(await repo.get("sel_nobody")).toBeNull();
  });

  it("stores providedFields encrypted at rest — the raw row never contains the plaintext PII", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ providedFields: { first_name: "Ada Lovelace", email_address: "ada@example.org" } }));

    const [row] = await db.select().from(sellerKyc);
    expect(row).toBeDefined();
    expect(row!.fieldsEncrypted).not.toContain("Ada Lovelace");
    expect(row!.fieldsEncrypted).not.toContain("ada@example.org");
  });

  it("upserts on repeated save() for the same seller — never a second row", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ status: "NEEDS_INFO" }));
    await repo.save(record({ status: "ACCEPTED", providedFields: { first_name: "Ada Lovelace, corrected" } }));

    const rows = await db.select().from(sellerKyc);
    expect(rows).toHaveLength(1);
    expect((await repo.get("sel_1"))?.status).toBe("ACCEPTED");
  });

  it("never leaks one seller's KYC fields into another seller's record", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ sellerId: "sel_1", providedFields: { first_name: "Seller One" } }));
    await repo.save(record({ sellerId: "sel_2", providedFields: { first_name: "Seller Two" } }));

    const one = await repo.get("sel_1");
    const two = await repo.get("sel_2");
    expect(one?.providedFields.first_name).toBe("Seller One");
    expect(two?.providedFields.first_name).toBe("Seller Two");
  });

  it("fails closed rather than returning garbage when read with the wrong key", async () => {
    const db = await makeDb();
    await new DrizzleKycRepository(db, randomBytes(32)).save(record());
    const wrongKeyRepo = new DrizzleKycRepository(db, randomBytes(32));
    await expect(wrongKeyRepo.get("sel_1")).rejects.toThrow();
  });

  it("reads records encrypted under previous keys when configured with a keyring", async () => {
    const db = await makeDb();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    // Save with old key
    const oldRepo = new DrizzleKycRepository(db, oldKey);
    await oldRepo.save(record());

    // New repo with keyring containing old key as previous
    const { parsePiiKeyring } = await import("../src/crypto/pii");
    const keyring = parsePiiKeyring(newKey.toString("hex"), oldKey.toString("hex"));
    const newRepo = new DrizzleKycRepository(db, keyring);

    const rec = await newRepo.get("sel_1");
    expect(rec).toEqual(record());
  });

  it("correctly counts non-primary key rows via countNonPrimaryRows()", async () => {
    const db = await makeDb();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const { parsePiiKeyring } = await import("../src/crypto/pii");
    const keyring = parsePiiKeyring(newKey.toString("hex"), oldKey.toString("hex"));
    const repo = new DrizzleKycRepository(db, keyring);

    // Empty db -> 0
    expect(await repo.countNonPrimaryRows()).toBe(0);

    // Insert a row encrypted with oldKey
    const oldRepo = new DrizzleKycRepository(db, oldKey);
    await oldRepo.save(record({ sellerId: "sel_old" }));

    expect(await repo.countNonPrimaryRows()).toBe(1);

    // Insert a row encrypted with newKey (via keyring repo)
    await repo.save(record({ sellerId: "sel_new" }));

    expect(await repo.countNonPrimaryRows()).toBe(1);
  });
});
