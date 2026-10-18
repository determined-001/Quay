import { describe, expect, it } from "vitest";
import type { StoredOffRampQuote } from "@checkout/core";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { bootstrap, createDb, type DB } from "../src/db/client";
import { DrizzleOffRampStateRepository } from "../src/repos/index";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

function quote(over: Partial<StoredOffRampQuote> = {}): StoredOffRampQuote {
  return {
    quoteId: "q_1",
    linkId: "lnk_1",
    sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    sellAmount: "100",
    buyCurrency: "NGN",
    price: "1650",
    expiresAt: 1_800_000_000_000,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe("DrizzleOffRampStateRepository — withdrawType persistence", () => {
  it("round-trips a quote with withdrawType", async () => {
    const repo = new DrizzleOffRampStateRepository(await makeDb());
    await repo.saveQuote(quote({ withdrawType: "bank_account" }));
    const fetched = await repo.getQuote("q_1");
    expect(fetched).not.toBeNull();
    expect(fetched?.withdrawType).toBe("bank_account");
  });

  it("round-trips a quote without withdrawType (undefined)", async () => {
    const repo = new DrizzleOffRampStateRepository(await makeDb());
    await repo.saveQuote(quote({ withdrawType: undefined }));
    const fetched = await repo.getQuote("q_1");
    expect(fetched).not.toBeNull();
    expect(fetched?.withdrawType).toBeUndefined();
  });

  it("reads legacy row without withdraw_type column as undefined", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(
      `CREATE TABLE offramp_quotes (
        quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
        sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
        buy_currency TEXT NOT NULL, price TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`,
    );
    await client.execute(
      `INSERT INTO offramp_quotes (quote_id, link_id, sell_asset_code, sell_amount, buy_currency, price, expires_at, created_at)
       VALUES ('q_legacy', 'lnk_1', 'USDC', '100', 'NGN', '1650', 1800000000000, 1700000000000)`,
    );
    await bootstrap(client);

    const db = drizzle(client, { schema });
    const repo = new DrizzleOffRampStateRepository(db);
    const fetched = await repo.getQuote("q_legacy");
    expect(fetched).not.toBeNull();
    expect(fetched?.withdrawType).toBeUndefined();
  });

  it("bootstrap adds withdraw_type column to legacy offramp_quotes", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(
      `CREATE TABLE offramp_quotes (
        quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
        sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
        buy_currency TEXT NOT NULL, price TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`,
    );
    await client.execute(
      `INSERT INTO offramp_quotes (quote_id, link_id, sell_asset_code, sell_amount, buy_currency, price, expires_at, created_at)
       VALUES ('q1', 'lnk_1', 'USDC', '100', 'NGN', '1650', 1800000000000, 1700000000000)`,
    );
    await bootstrap(client);

    const cols = await client.execute(`PRAGMA table_info(offramp_quotes)`);
    const names = cols.rows.map((r) => String(r.name));
    expect(names).toContain("withdraw_type");
  });

  it("fresh database ends up with same columns as migrated legacy for offramp_quotes", async () => {
    const legacy = createClient({ url: "file::memory:" });
    await legacy.execute(
      `CREATE TABLE offramp_quotes (
        quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
        sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
        buy_currency TEXT NOT NULL, price TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`,
    );
    await bootstrap(legacy);

    const fresh = createClient({ url: "file::memory:" });
    await bootstrap(fresh);

    const a = (await legacy.execute(`PRAGMA table_info(offramp_quotes)`)).rows.map((r) => String(r.name)).sort();
    const b = (await fresh.execute(`PRAGMA table_info(offramp_quotes)`)).rows.map((r) => String(r.name)).sort();
    expect(a).toEqual(b);
  });
});