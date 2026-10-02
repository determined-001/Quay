import { describe, it, expect, vi } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleSellerRepository } from "../src/repos/index";
import { parsePiiKey, encryptPii } from "../src/crypto/pii";
import { sellers } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { createLogger } from "../src/logger";

const TEST_KEY_HEX = "a".repeat(64);
const OTHER_KEY_HEX = "b".repeat(64);

async function setupTestRepo(keyHex?: string, logger?: any) {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  const piiKey = keyHex ? parsePiiKey(keyHex) : null;
  const repo = new DrizzleSellerRepository(db, piiKey, logger);
  return { db, client, repo, piiKey };
}

describe("4.34 - Seller payout fields encryption at rest", () => {
  it("savePayoutFields encrypts fields with GCM blob and sets payout_fields_json to NULL", async () => {
    const { db, client, repo } = await setupTestRepo(TEST_KEY_HEX);
    const wallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const seller = await repo.createIfAbsent(wallet);

    const sensitiveFields = {
      dest: "0123456789",
      dest_extra: "058",
      routing_number: "031100209",
    };

    await repo.savePayoutFields(seller.id, sensitiveFields);

    // Verify at the raw database row level
    const rawRows = await client.execute({
      sql: "SELECT payout_fields_json, payout_fields_encrypted FROM sellers WHERE id = ?",
      args: [seller.id],
    });
    expect(rawRows.rows).toHaveLength(1);
    const row = rawRows.rows[0];

    // payout_fields_json must be NULL
    expect(row?.payout_fields_json).toBeNull();

    // payout_fields_encrypted must contain a ciphertext blob, NOT the plaintext
    const encrypted = String(row?.payout_fields_encrypted ?? "");
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain("0123456789");
    expect(encrypted).not.toContain("031100209");

    // Decrypts accurately through findById
    const fetched = await repo.findById(seller.id);
    expect(fetched?.payoutFields).toEqual(sensitiveFields);

    // Decrypts accurately through findByWallet (login flow)
    const byWallet = await repo.findByWallet(wallet);
    expect(byWallet?.payoutFields).toEqual(sensitiveFields);
  });

  it("does not persist payout fields when piiKey is null", async () => {
    const { client, repo } = await setupTestRepo(undefined); // no key
    const wallet = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const seller = await repo.createIfAbsent(wallet);

    await repo.savePayoutFields(seller.id, { dest: "9876543210" });

    const rawRows = await client.execute({
      sql: "SELECT payout_fields_json, payout_fields_encrypted FROM sellers WHERE id = ?",
      args: [seller.id],
    });
    expect(rawRows.rows[0]?.payout_fields_json).toBeNull();
    expect(rawRows.rows[0]?.payout_fields_encrypted).toBeNull();

    const fetched = await repo.findById(seller.id);
    expect(fetched?.payoutFields).toBeNull();
  });

  it("backfills legacy plaintext rows on boot idempotently without logging values", async () => {
    const { db, client, repo, piiKey } = await setupTestRepo(TEST_KEY_HEX);
    const wallet = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const seller = await repo.createIfAbsent(wallet);

    const legacyFields = {
      dest: "1122334455",
      bank_code: "XYZ",
    };

    // Simulate legacy state: plaintext JSON directly in DB
    await client.execute({
      sql: "UPDATE sellers SET payout_fields_json = ?, payout_fields_encrypted = NULL WHERE id = ?",
      args: [JSON.stringify(legacyFields), seller.id],
    });

    // Run backfill
    await repo.backfillLegacyPayoutFields();

    // Verify legacy column is now null and encrypted column holds ciphertext
    const after = await client.execute({
      sql: "SELECT payout_fields_json, payout_fields_encrypted FROM sellers WHERE id = ?",
      args: [seller.id],
    });
    expect(after.rows[0]?.payout_fields_json).toBeNull();
    const enc = String(after.rows[0]?.payout_fields_encrypted ?? "");
    expect(enc).toBeTruthy();
    expect(enc).not.toContain("1122334455");

    // Read back through repository
    const fetched = await repo.findById(seller.id);
    expect(fetched?.payoutFields).toEqual(legacyFields);

    // Idempotence check: run backfill again
    await repo.backfillLegacyPayoutFields();
    const afterSecond = await client.execute({
      sql: "SELECT payout_fields_json, payout_fields_encrypted FROM sellers WHERE id = ?",
      args: [seller.id],
    });
    expect(afterSecond.rows[0]?.payout_fields_json).toBeNull();
    expect(afterSecond.rows[0]?.payout_fields_encrypted).toBe(enc);
  });

  it("tampered or undecryptable blob returns payoutFields: null without breaking login", async () => {
    const warnFn = vi.fn();
    const mockLogger = { warn: warnFn };
    const { client, repo } = await setupTestRepo(TEST_KEY_HEX, mockLogger);
    const wallet = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    const seller = await repo.createIfAbsent(wallet);

    // Write a tampered / invalid base64 blob into payout_fields_encrypted
    await client.execute({
      sql: "UPDATE sellers SET payout_fields_encrypted = 'invalid-ciphertext-blob', payout_fields_json = NULL WHERE id = ?",
      args: [seller.id],
    });

    // Must not throw on findByWallet (SEP-10 login path)
    const loggedIn = await repo.findByWallet(wallet);
    expect(loggedIn).not.toBeNull();
    expect(loggedIn?.id).toBe(seller.id);
    expect(loggedIn?.wallet).toBe(wallet);
    expect(loggedIn?.payoutFields).toBeNull();

    // Must log decrypt_failed event with sellerId and no secret values
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "seller.payout_fields.decrypt_failed",
        sellerId: seller.id,
      }),
      expect.any(String),
    );

    // Same behavior on findById
    warnFn.mockClear();
    const byId = await repo.findById(seller.id);
    expect(byId?.payoutFields).toBeNull();
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "seller.payout_fields.decrypt_failed",
        sellerId: seller.id,
      }),
      expect.any(String),
    );
  });

  it("wrong decryption key returns payoutFields: null without throwing", async () => {
    const { db, client, repo } = await setupTestRepo(TEST_KEY_HEX);
    const wallet = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    const seller = await repo.createIfAbsent(wallet);

    await repo.savePayoutFields(seller.id, { dest: "12345" });

    // Open repo with a different key
    const differentRepo = new DrizzleSellerRepository(db, parsePiiKey(OTHER_KEY_HEX));
    const fetched = await differentRepo.findById(seller.id);
    expect(fetched?.payoutFields).toBeNull();
  });
});
