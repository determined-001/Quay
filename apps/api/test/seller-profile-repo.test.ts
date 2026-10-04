import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProfileFieldRejectedError, type KycRecord } from "@checkout/core";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { sellerProfile } from "../src/db/schema";
import { DrizzleKycRepository, DrizzleSellerProfileRepository } from "../src/repos/index";

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

/** A repo whose clock the test moves by hand. */
function makeRepo(db: DB, keyring = randomBytes(32)) {
  const clock = { now: 1_000 };
  const repo = new DrizzleSellerProfileRepository(db, keyring, () => clock.now);
  return { repo, clock, keyring };
}

function kycRecord(sellerId: string, providedFields: Record<string, string>, over: Partial<KycRecord> = {}): KycRecord {
  return {
    sellerId,
    anchorDomain: "testanchor.stellar.org",
    account: "GSELLER",
    customerId: "cust_1",
    status: "ACCEPTED",
    requiredFields: [],
    providedFields,
    providedFieldStatus: [],
    sentFields: [],
    message: null,
    lastSyncedAt: null,
    updatedAt: 500,
    ...over,
  };
}

describe("DrizzleSellerProfileRepository", () => {
  it("round-trips fields with their source and timestamp", async () => {
    const { repo } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { given_name: "Ada", family_name: "Lovelace" }, "seller");

    expect(await repo.list("sel_1")).toEqual([
      { field: "family_name", value: "Lovelace", source: "seller", updatedAt: 1_000 },
      { field: "given_name", value: "Ada", source: "seller", updatedAt: 1_000 },
    ]);
  });

  it("stores no plaintext: the raw row holds only ciphertext for the value", async () => {
    const db = await makeDb();
    const { repo } = makeRepo(db);
    await repo.upsert("sel_1", { id_number: "A1234567", email_address: "ada@example.org" }, "seller");

    const raw = await db.select().from(sellerProfile);
    expect(raw.map((r) => r.field).sort()).toEqual(["email_address", "id_number"]); // names stay plaintext
    for (const row of raw) {
      expect(row.valueEncrypted).toMatch(/^v1:/);
      expect(row.valueEncrypted).not.toContain("A1234567");
      expect(row.valueEncrypted).not.toContain("ada@example.org");
      expect(JSON.stringify(row)).not.toContain("Lovelace");
    }
  });

  it("decrypts only with the key it was written with", async () => {
    const db = await makeDb();
    const writer = makeRepo(db);
    await writer.repo.upsert("sel_1", { given_name: "Ada" }, "seller");

    const stranger = new DrizzleSellerProfileRepository(db, randomBytes(32));
    await expect(stranger.list("sel_1")).rejects.toThrow();
  });

  it("normalises an alias to the canonical SEP-9 name", async () => {
    const { repo } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { first_name: "Ada" }, "seller");
    expect((await repo.list("sel_1")).map((f) => f.field)).toEqual(["given_name"]);
  });

  it("leaves updated_at and source alone when a value is re-saved unchanged", async () => {
    const { repo, clock } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { given_name: "Ada" }, "migrated_from_seller_kyc");

    clock.now = 9_000;
    await repo.upsert("sel_1", { given_name: "Ada" }, "seller");

    expect(await repo.list("sel_1")).toEqual([
      { field: "given_name", value: "Ada", source: "migrated_from_seller_kyc", updatedAt: 1_000 },
    ]);
  });

  it("bumps updated_at only for the fields that changed", async () => {
    const { repo, clock } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { given_name: "Ada", city: "London" }, "seller");

    clock.now = 9_000;
    await repo.upsert("sel_1", { given_name: "Ada", city: "Paris", postal_code: "75001" }, "seller");

    const byField = Object.fromEntries((await repo.list("sel_1")).map((f) => [f.field, f]));
    expect(byField.given_name!.updatedAt).toBe(1_000);
    expect(byField.city).toMatchObject({ value: "Paris", updatedAt: 9_000 });
    expect(byField.postal_code).toMatchObject({ value: "75001", updatedAt: 9_000 });
  });

  it("refuses an unknown field and writes nothing from that call", async () => {
    const { repo } = makeRepo(await makeDb());
    const err = await repo
      .upsert("sel_1", { given_name: "Ada", favourite_colour: "green" }, "seller")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProfileFieldRejectedError);
    expect(err).toMatchObject({ field: "favourite_colour", reason: "unknown_field" });
    expect(await repo.list("sel_1")).toEqual([]);
  });

  it("refuses binary-typed fields: binary data is never persisted", async () => {
    const { repo } = makeRepo(await makeDb());
    for (const field of ["photo_id_front", "organization.photo_incorporation_doc", "proof_of_liveness"]) {
      await expect(repo.upsert("sel_1", { [field]: "base64data" }, "seller")).rejects.toMatchObject({
        reason: "binary_field",
      });
    }
    expect(await repo.list("sel_1")).toEqual([]);
  });

  it("keeps sellers apart", async () => {
    const { repo } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { given_name: "Ada" }, "seller");
    await repo.upsert("sel_2", { given_name: "Grace" }, "seller");

    expect((await repo.list("sel_1"))[0]!.value).toBe("Ada");
    expect((await repo.list("sel_2"))[0]!.value).toBe("Grace");
  });

  it("removes named fields (by alias too) and all fields", async () => {
    const { repo } = makeRepo(await makeDb());
    await repo.upsert("sel_1", { given_name: "Ada", family_name: "L", city: "London" }, "seller");
    await repo.upsert("sel_2", { city: "Paris" }, "seller");

    await repo.remove("sel_1", ["first_name", "not_there"]); // alias of given_name; unknown ignored
    expect((await repo.list("sel_1")).map((f) => f.field)).toEqual(["city", "family_name"]);

    await repo.removeAll("sel_1");
    expect(await repo.list("sel_1")).toEqual([]);
    expect(await repo.list("sel_2")).toHaveLength(1);
  });
});

describe("DrizzleSellerProfileRepository.migrateFromSellerKyc", () => {
  async function setup() {
    const db = await makeDb();
    const keyring = randomBytes(32);
    const kyc = new DrizzleKycRepository(db, keyring);
    const profile = new DrizzleSellerProfileRepository(db, keyring, () => 7_000);
    return { db, kyc, profile };
  }

  it("lifts known SEP-9 keys into the profile with the migration source", async () => {
    const { kyc, profile } = await setup();
    await kyc.save(
      kycRecord("sel_1", {
        first_name: "Ada", // alias of given_name
        family_name: "Lovelace",
        email_address: "ada@example.org",
        photo_id_front: "BINARY", // binary: never persisted
        favourite_colour: "green", // not SEP-9
        city: "", // empty: nothing to keep
      }),
    );

    const result = await profile.migrateFromSellerKyc();
    expect(result).toEqual({ rows: 1, migrated: 3, failed: 0 });
    expect(await profile.list("sel_1")).toEqual([
      { field: "email_address", value: "ada@example.org", source: "migrated_from_seller_kyc", updatedAt: 500 },
      { field: "family_name", value: "Lovelace", source: "migrated_from_seller_kyc", updatedAt: 500 },
      { field: "given_name", value: "Ada", source: "migrated_from_seller_kyc", updatedAt: 500 },
    ]);
  });

  it("is idempotent", async () => {
    const { kyc, profile } = await setup();
    await kyc.save(kycRecord("sel_1", { given_name: "Ada" }));

    expect((await profile.migrateFromSellerKyc()).migrated).toBe(1);
    const afterFirst = await profile.list("sel_1");

    expect(await profile.migrateFromSellerKyc()).toEqual({ rows: 1, migrated: 0, failed: 0 });
    expect(await profile.list("sel_1")).toEqual(afterFirst);
  });

  it("never overwrites a value the seller already has", async () => {
    const { kyc, profile } = await setup();
    await kyc.save(kycRecord("sel_1", { given_name: "FromAnchorEcho", city: "London" }));
    await profile.upsert("sel_1", { given_name: "Ada" }, "seller");

    const result = await profile.migrateFromSellerKyc();

    expect(result.migrated).toBe(1); // only city
    const byField = Object.fromEntries((await profile.list("sel_1")).map((f) => [f.field, f]));
    expect(byField.given_name).toMatchObject({ value: "Ada", source: "seller" });
    expect(byField.city).toMatchObject({ value: "London", source: "migrated_from_seller_kyc" });
  });

  it("counts an unreadable row without aborting the rest", async () => {
    const db = await makeDb();
    const good = randomBytes(32);
    await new DrizzleKycRepository(db, good).save(kycRecord("sel_good", { given_name: "Ada" }));
    await new DrizzleKycRepository(db, randomBytes(32)).save(kycRecord("sel_lost", { given_name: "Grace" }));

    const result = await new DrizzleSellerProfileRepository(db, good).migrateFromSellerKyc();

    expect(result).toEqual({ rows: 2, migrated: 1, failed: 1 });
  });

  it("does nothing on a database with no seller_kyc rows", async () => {
    const { profile } = await setup();
    expect(await profile.migrateFromSellerKyc()).toEqual({ rows: 0, migrated: 0, failed: 0 });
  });
});

describe("seller_profile table", () => {
  it("exists on a fresh database and bootstrap is safe to run twice", async () => {
    const { db, client } = createDb(":memory:");
    await bootstrap(client);
    await bootstrap(client);
    expect(await db.select().from(sellerProfile)).toEqual([]);
  });
});
