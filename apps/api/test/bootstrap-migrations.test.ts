import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { bootstrap } from "../src/db/client";
import { DrizzleWatcherStateRepository } from "../src/repos/index";
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

/** `processed_tx` as it shipped before issue 4.11 — tx_hash alone as the key. */
const LEGACY_PROCESSED_TX = `CREATE TABLE processed_tx (
  tx_hash TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER NOT NULL
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

  it("defaults existing sellers to individual profiles", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_SELLERS);
    await client.execute(
      "INSERT INTO sellers (id,name,wallet,created_at) VALUES ('s1','a','GWALLET',1)",
    );

    await bootstrap(client);

    const expected = getTableConfig(schema.sellers).columns.map((c) => c.name);
    const actual = await columnsOf(client, "sellers");
    expect(expected.filter((c) => !actual.includes(c))).toEqual([]);
    const row = await client.execute("SELECT profile_kind FROM sellers WHERE id = 's1'");
    expect(row.rows[0]?.profile_kind).toBe("individual");
  });

  it("adds sellers.payout_fields_json to a legacy table", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);

    expect(await columnsOf(client, "sellers")).toContain("payout_fields_json");
  });

  it("adds sellers.payout_fields_encrypted to a legacy table (issue 4.34)", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINKS);
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(LEGACY_SELLERS);

    await bootstrap(client);

    expect(await columnsOf(client, "sellers")).toContain("payout_fields_encrypted");
  });

  // Issue 4.11 rebuilds processed_tx and link_payments rather than ALTERing
  // them — SQLite cannot move a column into or out of a PRIMARY KEY. A rebuild
  // that drops rows is a money bug: processed_tx is the dedup ledger, so
  // losing it re-credits payments that already settled.
  it("preserves every processed_tx row through the 4.11 rebuild", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_PROCESSED_TX);
    await client.execute(
      `INSERT INTO processed_tx (tx_hash, link_id, created_at) VALUES
         ('tx_old_1', 'lnk_a', 1000),
         ('tx_old_2', NULL, 2000)`,
    );

    await bootstrap(client);

    const rows = await client.execute("SELECT tx_hash, operation_id, link_id, created_at FROM processed_tx ORDER BY tx_hash");
    expect(rows.rows.map((r) => String(r.tx_hash))).toEqual(["tx_old_1", "tx_old_2"]);
    // Legacy rows carry no operation id — that is what makes them mean
    // "the whole transaction was processed".
    expect(rows.rows.every((r) => r.operation_id === null)).toBe(true);
    expect(String(rows.rows[0]!.link_id)).toBe("lnk_a");
    expect(Number(rows.rows[0]!.created_at)).toBe(1000);
  });

  it("preserves every link_payments row through the 4.11 rebuild", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_LINK_PAYMENTS);
    await client.execute(
      `INSERT INTO link_payments (id, link_id, tx_hash, payer, amount, asset_code, asset_issuer, created_at)
       VALUES ('pmt_1', 'lnk_a', 'tx_old_1', 'GPAYER', '10', 'USDC', 'GISSUER', 1000)`,
    );

    await bootstrap(client);

    const rows = await client.execute("SELECT id, tx_hash, operation_id, amount, ledger FROM link_payments");
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]!.id)).toBe("pmt_1");
    expect(String(rows.rows[0]!.amount)).toBe("10");
    expect(rows.rows[0]!.operation_id).toBe(null);
    // The legacy fixture predates the `ledger` column; the rebuild must not
    // assume it was there.
    expect(rows.rows[0]!.ledger).toBe(null);
  });

  // The dedup semantics the migration promises: a pre-4.11 row means the whole
  // transaction is done, so a replay of any operation in it is still a
  // duplicate. Without this, every payment settled before the migration could
  // be credited a second time.
  it("treats a migrated NULL-operation row as covering the whole transaction", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_PROCESSED_TX);
    await client.execute(
      "INSERT INTO processed_tx (tx_hash, link_id, created_at) VALUES ('tx_settled', 'lnk_a', 1000)",
    );
    await bootstrap(client);

    const state = new DrizzleWatcherStateRepository(drizzle(client, { schema }));

    expect(await state.isProcessed("tx_settled", "any-operation-id")).toBe(true);
    expect(await state.isProcessed("tx_settled", "another-one")).toBe(true);
    expect(await state.isProcessed("tx_never_seen", "1")).toBe(false);
  });

  // Two operations in one transaction must each get their own row — that is
  // the entire point of the re-key.
  it("records two operations of one transaction independently after migrating", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_PROCESSED_TX);
    await bootstrap(client);

    const state = new DrizzleWatcherStateRepository(drizzle(client, { schema }));
    await state.markProcessed("tx_split", "op_1", "lnk_a");

    expect(await state.isProcessed("tx_split", "op_1")).toBe(true);
    expect(await state.isProcessed("tx_split", "op_2")).toBe(false);

    await state.markProcessed("tx_split", "op_2", "lnk_a");
    expect(await state.isProcessed("tx_split", "op_2")).toBe(true);

    const rows = await client.execute("SELECT operation_id FROM processed_tx WHERE tx_hash = 'tx_split'");
    expect(rows.rows).toHaveLength(2);
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
    await legacy.execute(LEGACY_PROCESSED_TX);
    await bootstrap(legacy);

    const fresh = createClient({ url: "file::memory:" });
    await bootstrap(fresh);

    for (const table of ["links", "link_payments", "sellers", "processed_tx"]) {
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

// Issue 4.24: seller_kyc was keyed by seller_id alone.
describe("bootstrap() rebuilds seller_kyc keyed by (seller_id, anchor_domain)", () => {
  const LEGACY_SELLER_KYC = `CREATE TABLE seller_kyc (
    seller_id TEXT PRIMARY KEY, account TEXT, customer_id TEXT, status TEXT NOT NULL,
    required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
    message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL
  )`;

  async function legacyDb() {
    const client = createClient({ url: "file::memory:" });
    await client.execute(LEGACY_SELLER_KYC);
    await client.execute(
      `INSERT INTO seller_kyc (seller_id, account, customer_id, status, required_fields, fields_encrypted, updated_at)
       VALUES ('s1', 'GACC', 'cust_1', 'ACCEPTED', '[]', 'v1:blob1', 10),
              ('s2', NULL, 'cust_2', 'NEEDS_INFO', '[]', 'v1:blob2', 20)`,
    );
    return client;
  }

  it("keeps every row, attributed to the configured anchor", async () => {
    const client = await legacyDb();
    await bootstrap(client, { kycAnchorDomain: "testanchor.stellar.org" });

    const rows = (await client.execute("SELECT * FROM seller_kyc ORDER BY seller_id")).rows;
    expect(rows.map((r) => [r.seller_id, r.anchor_domain, r.customer_id, r.fields_encrypted])).toEqual([
      ["s1", "testanchor.stellar.org", "cust_1", "v1:blob1"],
      ["s2", "testanchor.stellar.org", "cust_2", "v1:blob2"],
    ]);
    expect(await columnsOf(client, "seller_kyc")).toEqual(
      expect.arrayContaining(["anchor_domain", "provided_field_status", "sent_fields"]),
    );
  });

  it("marks rows 'legacy' when no anchor is configured to attribute them to", async () => {
    const client = await legacyDb();
    await bootstrap(client);
    const rows = (await client.execute("SELECT anchor_domain FROM seller_kyc")).rows;
    expect(rows.map((r) => r.anchor_domain)).toEqual(["legacy", "legacy"]);
  });

  it("allows one row per anchor for a seller afterwards, and only one per (seller, anchor)", async () => {
    const client = await legacyDb();
    await bootstrap(client, { kycAnchorDomain: "a.example" });
    const insert = (domain: string) =>
      client.execute({
        sql: `INSERT INTO seller_kyc (seller_id, anchor_domain, status, required_fields, fields_encrypted, updated_at)
              VALUES ('s1', ?, 'NEEDS_INFO', '[]', 'x', 1)`,
        args: [domain],
      });

    await expect(insert("b.example")).resolves.toBeDefined();
    await expect(insert("a.example")).rejects.toThrow(); // already migrated with a.example
  });

  it("is idempotent: a second bootstrap changes nothing", async () => {
    const client = await legacyDb();
    await bootstrap(client, { kycAnchorDomain: "a.example" });
    const first = (await client.execute("SELECT * FROM seller_kyc ORDER BY seller_id")).rows.map((r) => ({ ...r }));

    await bootstrap(client, { kycAnchorDomain: "other.example" });
    const second = (await client.execute("SELECT * FROM seller_kyc ORDER BY seller_id")).rows.map((r) => ({ ...r }));
    expect(second).toEqual(first);
  });

  it("leaves no rebuild scratch table behind", async () => {
    const client = await legacyDb();
    await bootstrap(client, { kycAnchorDomain: "a.example" });
    const tables = (await client.execute("SELECT name FROM sqlite_master WHERE name LIKE 'seller_kyc%'")).rows;
    expect(tables.map((t) => t.name)).toEqual(["seller_kyc"]);
  });
});
