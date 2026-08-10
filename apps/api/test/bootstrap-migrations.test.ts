import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { bootstrap } from "../src/db/client";
import * as schema from "../src/db/schema";
import { getTableConfig } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
//  bootstrap() must bring an OLD database up to the current schema.
//
//  A fresh database gets everything from BOOTSTRAP_SQL's CREATE TABLE, so tests
//  that start empty prove nothing about migrations. The failure this guards
//  against only appears against a database that already exists — which is to
//  say, only in production.
//
//  BUG-4.16: `MIGRATION_SQL` and `MIGRATIONS_SQL` both existed, one letter
//  apart, and bootstrap() only ever executed the plural one. The four columns
//  in the singular array were never added to any pre-existing database. It
//  stayed invisible until the API booted against the real Turso instance and
//  every SELECT on `links` failed at once.
// ---------------------------------------------------------------------------

/** The `links` table exactly as it shipped before any additive migration. */
const LEGACY_LINKS = `CREATE TABLE links (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
  destination TEXT NOT NULL, title TEXT NOT NULL, amount TEXT NOT NULL,
  asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
  tx_hash TEXT, payer TEXT, paid_amount TEXT,
  offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
  expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`;

const LEGACY_LINK_PAYMENTS = `CREATE TABLE link_payments (
  id TEXT PRIMARY KEY, link_id TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL, amount TEXT NOT NULL,
  asset_code TEXT NOT NULL, asset_issuer TEXT,
  created_at INTEGER NOT NULL
)`;

// Copied verbatim from the production database's own sqlite_master, not
// guessed: `wallet` has NO UNIQUE here. That single missing constraint is what
// made every wallet login 500, and a fixture that quietly adds it back tests
// nothing.
const LEGACY_SELLERS = `CREATE TABLE sellers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

async function columnsOf(client: ReturnType<typeof createClient>, table: string): Promise<string[]> {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return res.rows.map((r) => String(r.name));
}

/**
 * The set of column-tuples this table enforces as unique, however that
 * uniqueness is expressed — PRIMARY KEY, a UNIQUE column, or a unique index.
 * Comparing these is what catches a constraint that exists on fresh databases
 * and not on migrated ones; comparing column names alone cannot see it.
 */
async function uniqueKeysOf(
  client: ReturnType<typeof createClient>,
  table: string,
): Promise<string[]> {
  const list = await client.execute(`PRAGMA index_list(${table})`);
  const keys: string[] = [];
  for (const row of list.rows) {
    if (String(row.unique) !== "1") continue;
    const info = await client.execute(`PRAGMA index_info(${String(row.name)})`);
    keys.push(info.rows.map((r) => String(r.name)).join(","));
  }
  // Deduped: a fresh database gets uniqueness on `sellers.wallet` from the
  // column constraint AND from the migration's index, a legacy one only from
  // the index. Two indexes enforcing the same tuple is redundant, not a
  // different guarantee, and it is the guarantee these tests are about.
  return [...new Set(keys)].sort();
}

describe("bootstrap() against a pre-existing database", () => {
  it("adds every column the current schema expects to a legacy links table", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);

    // Derived from the drizzle schema rather than hardcoded, so a column added
    // in future without a matching migration fails here instead of in prod.
    const expected = getTableConfig(schema.links).columns.map((c) => c.name);
    const actual = await columnsOf(client, "links");
    const missing = expected.filter((c) => !actual.includes(c));

    expect(missing).toEqual([]);
  });

  it("adds link_payments.ledger to a legacy table", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);

    const expected = getTableConfig(schema.linkPayments).columns.map((c) => c.name);
    const actual = await columnsOf(client, "link_payments");
    expect(expected.filter((c) => !actual.includes(c))).toEqual([]);
  });

  // BUG-4.21. A legacy `sellers` has `wallet TEXT NOT NULL` with no UNIQUE, so
  // `createIfAbsent`'s ON CONFLICT (wallet) is rejected by SQLite outright and
  // every wallet login 500s. Column names matched exactly in that state, which
  // is why the first version of this test did not catch it.
  it("makes sellers.wallet unique on a legacy table, so ON CONFLICT works", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS); // wallet is NOT UNIQUE here
    await client.execute(
      "INSERT INTO sellers (id,name,wallet,created_at) VALUES ('s1','a','GWALLET',1)",
    );

    await bootstrap(client);

    // The exact statement that was failing in production.
    await expect(
      client.execute(
        "INSERT INTO sellers (id,name,wallet,created_at) VALUES ('s2','b','GWALLET',2) " +
          "ON CONFLICT (wallet) DO NOTHING",
      ),
    ).resolves.toBeDefined();

    const rows = await client.execute("SELECT COUNT(*) AS n FROM sellers WHERE wallet = 'GWALLET'");
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("adds sellers.payout_fields_json to a legacy table", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);

    expect(await columnsOf(client, "sellers")).toContain("payout_fields_json");
  });

  it("is idempotent — a second run over a migrated database is a no-op", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);
    const after1 = await columnsOf(client, "links");
    await expect(bootstrap(client)).resolves.not.toThrow();
    expect(await columnsOf(client, "links")).toEqual(after1);
  });

  it("a fresh database ends up with the same columns as a migrated legacy one", async () => {
    // The two paths — CREATE TABLE for new databases, ALTER for old ones — drift
    // apart silently. Comparing them is what keeps a column added to one from
    // being forgotten in the other.
    const legacy = createClient({ url: "file::memory:" });
    await legacy.execute(LEGACY_LINKS);
    await legacy.execute(LEGACY_LINK_PAYMENTS);
    await legacy.execute(LEGACY_SELLERS);
    await bootstrap(legacy);

    const fresh = createClient({ url: "file::memory:" });
    await bootstrap(fresh);

    for (const table of ["links", "link_payments", "sellers"]) {
      const a = (await columnsOf(legacy, table)).slice().sort();
      const b = (await columnsOf(fresh, table)).slice().sort();
      expect(a, `${table} columns drifted between the fresh and migrated paths`).toEqual(b);

      // Constraints drift too, and are invisible to a column comparison — the
      // whole of BUG-4.21 lived in this gap.
      expect(
        await uniqueKeysOf(legacy, table),
        `${table} unique constraints drifted between the fresh and migrated paths`,
      ).toEqual(await uniqueKeysOf(fresh, table));
    }
  });
});
