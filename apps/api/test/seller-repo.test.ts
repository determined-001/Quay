import { describe, expect, it } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleSellerRepository } from "../src/repos/index";
import { parsePiiKey } from "../src/crypto/pii";

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleSellerRepository(db);
}

describe("DrizzleSellerRepository wallet-native signup", () => {
  it("createIfAbsent creates a seller keyed by wallet, then is idempotent", async () => {
    const repo = await freshRepo();
    const wallet = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

    const first = await repo.createIfAbsent(wallet);
    expect(first.wallet).toBe(wallet);
    expect(first.profileKind).toBe("individual");

    const second = await repo.createIfAbsent(wallet);
    expect(second.id).toBe(first.id); // same seller, not a duplicate
  });

  it("findByWallet returns null for an unregistered wallet", async () => {
    const repo = await freshRepo();
    expect(await repo.findByWallet("GUNKNOWN")).toBeNull();
  });

  it("persists an organization profile kind for the seller", async () => {
    const repo = await freshRepo();
    const seller = await repo.createIfAbsent("GORGANIZATIONWALLET");

    await repo.saveProfileKind(seller.id, "organization");

    expect((await repo.findById(seller.id))?.profileKind).toBe("organization");
    expect((await repo.findByWallet(seller.wallet))?.profileKind).toBe("organization");
  });
});

describe("DrizzleSellerRepository.ensureDefault", () => {
  it("creates the seller on an empty table", async () => {
    const repo = await freshRepo();
    const seller = await repo.ensureDefault("GDEFAULTWALLET", "Default Store");
    expect(seller.wallet).toBe("GDEFAULTWALLET");
    expect(seller.name).toBe("Default Store");
    expect(seller.profileKind).toBe("individual");
  });

  it("is idempotent and returns the same seller id when called twice", async () => {
    const repo = await freshRepo();
    const first = await repo.ensureDefault("GDEFAULTWALLET", "Default Store");
    const second = await repo.ensureDefault("GDEFAULTWALLET", "Default Store");
    expect(second.id).toBe(first.id);
    expect(second.wallet).toBe("GDEFAULTWALLET");
  });

  it("leaves an unrelated seller's wallet untouched and creates a new row", async () => {
    const repo = await freshRepo();
    const unrelated = await repo.createIfAbsent("GUNRELATEDWALLET");
    const defaultSeller = await repo.ensureDefault("GDEFAULTWALLET", "Default Store");

    expect(defaultSeller.id).not.toBe(unrelated.id);
    expect(defaultSeller.wallet).toBe("GDEFAULTWALLET");

    // Unrelated seller still exists and keeps its original wallet
    const reloadedUnrelated = await repo.findById(unrelated.id);
    expect(reloadedUnrelated?.wallet).toBe("GUNRELATEDWALLET");
  });

  it("returns a non-first seller when its wallet matches without throwing", async () => {
    const repo = await freshRepo();
    const first = await repo.createIfAbsent("GFIRSTWALLET");
    const second = await repo.createIfAbsent("GSECONDWALLET");

    // Calling ensureDefault with second seller's wallet should return second seller,
    // not crash or attempt to rewrite first seller's wallet.
    const resolved = await repo.ensureDefault("GSECONDWALLET", "Different Name");
    expect(resolved.id).toBe(second.id);
    expect(resolved.wallet).toBe("GSECONDWALLET");
    // Existing seller's name is not overwritten
    expect(resolved.name).toBe(second.name);

    // First seller is unaffected
    const reloadedFirst = await repo.findById(first.id);
    expect(reloadedFirst?.wallet).toBe("GFIRSTWALLET");
  });

  it("preserves and decrypts existing payout fields when returning a seller", async () => {
    const { db, client } = createDb(":memory:");
    await bootstrap(client);
    const piiKey = parsePiiKey("a".repeat(64));
    const repo = new DrizzleSellerRepository(db, piiKey);

    const wallet = "GPAIDSELLERWALLET";
    const seller = await repo.createIfAbsent(wallet);
    await repo.savePayoutFields(seller.id, { routing_number: "031100209" });

    const ensured = await repo.ensureDefault(wallet, "Default Name");
    expect(ensured.id).toBe(seller.id);
    expect(ensured.payoutFields).toEqual({ routing_number: "031100209" });
  });
});

