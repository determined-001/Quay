import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KycRecord, ProvidedFieldStatus } from "@checkout/core";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { sellerKyc } from "../src/db/schema";
import { DrizzleKycRepository } from "../src/repos/index";

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

const ANCHOR = "testanchor.stellar.org";

function record(over: Partial<KycRecord> = {}): KycRecord {
  return {
    sellerId: "sel_1",
    anchorDomain: "testanchor.stellar.org",
    account: "GSELLER1",
    customerId: "cust_1",
    status: "ACCEPTED",
    requiredFields: [{ name: "first_name", type: "string", optional: false }],
    providedFields: { first_name: "Ada Lovelace", email_address: "ada@example.org" },
    providedFieldStatus: [],
    sentFields: [],
    callbackTokenHash: null,
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
    expect(await repo.get("sel_1", ANCHOR)).toEqual(record());
  });

  it("looks up a record by callbackTokenHash", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    const tokenHash = "abc123hash";
    await repo.save(record({ callbackTokenHash: tokenHash }));
    const found = await repo.getByCallbackTokenHash(tokenHash);
    expect(found?.sellerId).toBe("sel_1");
    expect(await repo.getByCallbackTokenHash("nonexistent")).toBeNull();
  });

  it("refuses to persist a binary field in providedFields (ID photos are never stored)", async () => {
    const repo = new DrizzleKycRepository(await makeDb(), randomBytes(32));
    const withPhoto = record({
      requiredFields: [{ name: "photo_id_front", type: "binary", optional: false }],
      providedFields: { photo_id_front: "RAW-IMAGE-BYTES" },
    });

    const failure = await repo.save(withPhoto).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(failure?.message).toMatch(/must never be persisted/);
    // the message names the field, never its value
    expect(failure?.message).not.toContain("RAW-IMAGE-BYTES");
    expect(await repo.get("sel_1", ANCHOR)).toBeNull();
  });

  it("returns null for a seller with no KYC record", async () => {
    const repo = new DrizzleKycRepository(await makeDb(), randomBytes(32));
    expect(await repo.get("sel_nobody", ANCHOR)).toBeNull();
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
    expect((await repo.get("sel_1", ANCHOR))?.status).toBe("ACCEPTED");
  });

  it("never leaks one seller's KYC fields into another seller's record", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ sellerId: "sel_1", providedFields: { first_name: "Seller One" } }));
    await repo.save(record({ sellerId: "sel_2", providedFields: { first_name: "Seller Two" } }));

    const one = await repo.get("sel_1", ANCHOR);
    const two = await repo.get("sel_2", ANCHOR);
    expect(one?.providedFields.first_name).toBe("Seller One");
    expect(two?.providedFields.first_name).toBe("Seller Two");
  });

  it("fails closed rather than returning garbage when read with the wrong key", async () => {
    const db = await makeDb();
    await new DrizzleKycRepository(db, randomBytes(32)).save(record());
    const wrongKeyRepo = new DrizzleKycRepository(db, randomBytes(32));
    await expect(wrongKeyRepo.get("sel_1", ANCHOR)).rejects.toThrow();
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

    const rec = await newRepo.get("sel_1", ANCHOR);
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

  it("keeps independent state per (seller, anchor) - a second anchor never overwrites the first", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ anchorDomain: "a.example", customerId: "cust_a", status: "ACCEPTED" }));
    await repo.save(record({ anchorDomain: "b.example", customerId: "cust_b", status: "NEEDS_INFO" }));

    expect(await db.select().from(sellerKyc)).toHaveLength(2);
    expect(await repo.get("sel_1", "a.example")).toMatchObject({ customerId: "cust_a", status: "ACCEPTED" });
    expect(await repo.get("sel_1", "b.example")).toMatchObject({ customerId: "cust_b", status: "NEEDS_INFO" });
    expect(await repo.get("sel_1", "c.example")).toBeNull();
  });

  it("deletes one anchor's record, or every anchor's when none is named", async () => {
    const db = await makeDb();
    const repo = new DrizzleKycRepository(db, randomBytes(32));
    await repo.save(record({ anchorDomain: "a.example" }));
    await repo.save(record({ anchorDomain: "b.example" }));
    await repo.save(record({ sellerId: "sel_2", anchorDomain: "a.example" }));

    await repo.delete("sel_1", "a.example");
    expect(await repo.get("sel_1", "a.example")).toBeNull();
    expect(await repo.get("sel_1", "b.example")).not.toBeNull();

    await repo.delete("sel_1");
    expect(await repo.get("sel_1", "b.example")).toBeNull();
    expect(await repo.get("sel_2", "a.example")).not.toBeNull();
  });
});
