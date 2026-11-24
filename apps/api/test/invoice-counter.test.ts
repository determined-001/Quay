import { describe, expect, it } from "vitest";
import { createTestDb } from "./setup";
import { bootstrap } from "../src/db/client";
import { DrizzleInvoiceCounterRepository } from "../src/repos/index";

describe("DrizzleInvoiceCounterRepository", () => {
  it("allocates sequential numbers starting from 1", async () => {
    const { db, client } = createTestDb();
    await bootstrap(client);
    const repo = new DrizzleInvoiceCounterRepository(db);

    const first = await repo.next("seller_1");
    expect(first).toBe(1);

    const second = await repo.next("seller_1");
    expect(second).toBe(2);

    const third = await repo.next("seller_1");
    expect(third).toBe(3);
  });

  it("allocates counters independently per seller", async () => {
    const { db, client } = createTestDb();
    await bootstrap(client);
    const repo = new DrizzleInvoiceCounterRepository(db);

    expect(await repo.next("seller_A")).toBe(1);
    expect(await repo.next("seller_A")).toBe(2);

    // Second seller starts at 1
    expect(await repo.next("seller_B")).toBe(1);
    expect(await repo.next("seller_A")).toBe(3);
    expect(await repo.next("seller_B")).toBe(2);
  });

  it("handles 50 concurrent allocations for one seller with no duplicates (1..50)", async () => {
    const { db, client } = createTestDb();
    await bootstrap(client);
    const repo = new DrizzleInvoiceCounterRepository(db);

    const promises = Array.from({ length: 50 }, () => repo.next("seller_concurrent"));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(50);

    const sorted = [...results].sort((a, b) => a - b);
    const expected = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(sorted).toEqual(expected);

    // Verify uniqueness (no duplicate values)
    const unique = new Set(results);
    expect(unique.size).toBe(50);
  });
});
