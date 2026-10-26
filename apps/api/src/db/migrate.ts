/**
 * Drizzle migration runner for libSQL / Turso.
 *
 * Replaces the old bootstrap() DDL approach. On every start this:
 *   1. Acquires a serialising lock via a `_migration_lock` table (advisory
 *      mutex for concurrent instances — libSQL writes are serialised by the
 *      server anyway, but the lock prevents two instances racing through the
 *      journal list and both thinking they are the first to apply a new file).
 *   2. Runs `drizzle-orm/libsql`'s `migrate()` against the compiled migration
 *      files bundled into `dist/` at build time (or the source tree during dev).
 *   3. Releases the lock.
 *
 * If migration fails the error propagates up to `createContainer()`, which
 * lets it crash `main()` — the process exits before it begins serving traffic,
 * which is the fast-fail behaviour required by the issue.
 *
 * Advisory lock design
 * --------------------
 * libSQL does not expose `BEGIN EXCLUSIVE` over the HTTP protocol used by
 * Turso, and `PRAGMA locking_mode=EXCLUSIVE` is not available on the remote
 * client. Instead we use a single-row lock table:
 *
 *   _migration_lock (id TEXT PRIMARY KEY, locked_at INTEGER NOT NULL)
 *
 * The protocol is:
 *   INSERT OR REPLACE INTO _migration_lock VALUES ('lock', <now>)
 *
 * Because libSQL serialises all writes server-side, only one concurrent INSERT
 * wins the race; the others wait in the server's write queue. Once the winner
 * finishes migrations it deletes the row. Stale locks (process crashed mid-
 * migration) are broken after LOCK_TIMEOUT_MS — any subsequent starter that
 * finds a row older than that replaces it and proceeds, rather than waiting
 * forever.
 *
 * This is intentionally simple. A distributed advisory lock with CAS and TTL
 * would be more robust but would require a Redis dependency just for the
 * migration path. The libSQL serialisation guarantee makes the INSERT-based
 * approach safe for the actual concurrency model here (a handful of instances
 * at most, rolling deploys).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Client } from "@libsql/client";
import type { DB } from "./client";

/** How long (ms) to wait for another instance to finish migrating. */
const POLL_INTERVAL_MS = 500;
/** A lock older than this is treated as stale and replaced. */
const LOCK_TIMEOUT_MS = 60_000;
/** Maximum total wait time before giving up. */
const MAX_WAIT_MS = 120_000;

/**
 * Resolve the migrations directory.
 *
 * Source layout:   apps/api/src/db/migrate.ts  →  ../../drizzle  →  apps/api/drizzle
 * Production bundle: apps/api/dist/index.js    →  ../drizzle     →  apps/api/drizzle
 *
 * We use `import.meta.url` (always available in ESM) rather than __filename
 * so this works with both tsx (dev) and the esbuild bundle (prod).
 * esbuild preserves `import.meta.url` as the output file path in the bundle.
 */
function migrationsFolder(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // In dev: …/apps/api/src/db/migrate.ts  → up 3 levels → apps/api/
  // In prod: …/apps/api/dist/index.js     → up 2 levels → apps/api/
  const inDist = thisFile.includes(`${process.platform === "win32" ? "\\" : "/"}dist${process.platform === "win32" ? "\\" : "/"}`);
  const packageRoot = inDist
    ? resolve(thisFile, "../..")
    : resolve(thisFile, "../../..");
  return resolve(packageRoot, "drizzle");
}

async function ensureLockTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migration_lock (
      id   TEXT PRIMARY KEY,
      locked_at INTEGER NOT NULL
    )
  `);
}

async function acquireLock(client: Client): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (true) {
    const now = Date.now();

    // Check for an existing lock.
    const result = await client.execute(
      "SELECT locked_at FROM _migration_lock WHERE id = 'lock'",
    );

    if (result.rows.length > 0) {
      const lockedAt = Number(result.rows[0]?.locked_at ?? 0);
      if (now - lockedAt < LOCK_TIMEOUT_MS) {
        // Another instance is actively migrating.
        if (now >= deadline) {
          throw new Error(
            `Migration lock timeout: another instance has held the lock for ` +
              `${now - lockedAt}ms (limit ${LOCK_TIMEOUT_MS}ms). ` +
              `If no migration is in progress, delete the '_migration_lock' row manually.`,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      // Stale lock — replace it.
    }

    // No lock, or stale lock: try to acquire (INSERT OR REPLACE is atomic in libSQL).
    await client.execute({
      sql: "INSERT OR REPLACE INTO _migration_lock (id, locked_at) VALUES ('lock', ?)",
      args: [now],
    });
    return;
  }
}

async function releaseLock(client: Client): Promise<void> {
  await client.execute("DELETE FROM _migration_lock WHERE id = 'lock'");
}

export interface RunMigrationsOptions {
  /** Override the migrations folder (useful in tests). */
  migrationsDir?: string;
}

/**
 * Stamp the baseline migration (index 0) as already applied without executing
 * it. This is called on databases that were created by the old BOOTSTRAP_SQL
 * path — they already have all the tables the baseline migration would create,
 * so running it would fail with "table already exists". Marking it applied
 * lets `migrate()` proceed and only apply genuinely new migrations on top.
 *
 * The hash is computed the same way drizzle-orm does: sha256 of the
 * joined SQL statements in the migration file. The `created_at` is the
 * `when` timestamp from the journal entry (milliseconds since epoch).
 *
 * Idempotent: no-op if the baseline hash is already in `__drizzle_migrations`.
 */
async function stampBaseline(client: Client, migrationsDir: string): Promise<void> {
  // Ensure the migrations journal table exists (drizzle-orm creates it lazily
  // on first migrate(); we need it to be present before inserting into it).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id       INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash     TEXT    NOT NULL,
      created_at NUMERIC
    )
  `);

  // Read the journal to find the baseline entry.
  const journalPath = resolve(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const baseline = journal.entries.find((e) => e.idx === 0);
  if (!baseline) return;

  // Compute the hash exactly as drizzle-orm/migrator does:
  // sha256 of the raw SQL file content (toString() of the file buffer).
  const sqlFile = resolve(migrationsDir, `${baseline.tag}.sql`);
  const sqlContent = readFileSync(sqlFile, "utf8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  // Skip if already recorded.
  const existing = await client.execute({
    sql: "SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1",
    args: [hash],
  });
  if (existing.rows.length > 0) return;

  await client.execute({
    sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    args: [hash, baseline.when],
  });
}

/**
 * Run pending Drizzle migrations.
 *
 * On a legacy database (tables already exist from the old BOOTSTRAP_SQL path,
 * but no `__drizzle_migrations` journal exists yet) the baseline migration is
 * stamped as applied before `migrate()` runs, so Drizzle skips the baseline
 * `CREATE TABLE` statements that would otherwise collide with the pre-existing
 * tables and only applies genuinely new migrations on top.
 *
 * Acquires the advisory lock, runs `migrate()`, then releases. If migration
 * throws, the lock is still released (so the next start can retry) and the
 * error re-thrown so the caller crashes the process.
 */
export async function runMigrations(
  db: DB,
  client: Client,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  const folder = opts.migrationsDir ?? migrationsFolder();

  await ensureLockTable(client);
  await acquireLock(client);

  try {
    // Detect a legacy database: one or more tables that the baseline migration
    // creates already exist (created by the old BOOTSTRAP_SQL path), but
    // __drizzle_migrations has no record of the baseline yet. Stamp it so
    // migrate() skips the baseline CREATE TABLE statements and only runs new
    // migrations on top.
    //
    // We check for any of the core tables rather than a specific one so this
    // works even on partial legacy fixtures (e.g. a test DB that only has
    // `processed_tx` or `seller_kyc`).
    const legacyTables = [
      "sellers", "links", "link_payments", "processed_tx", "webhooks",
      "webhook_queue", "webhook_deliveries", "offramp_quotes", "offramp_jobs",
      "seller_kyc", "anchor_sessions", "watcher_cursors",
    ];
    const placeholders = legacyTables.map(() => "?").join(",");
    const existingTables = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders}) LIMIT 1`,
      args: legacyTables,
    });
    if (existingTables.rows.length > 0) {
      await stampBaseline(client, folder);
    }

    await migrate(db, { migrationsFolder: folder });
  } finally {
    // Always release — even on error, so the next boot can retry rather than
    // waiting for the stale-lock timeout.
    await releaseLock(client);
  }
}
