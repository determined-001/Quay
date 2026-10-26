#!/usr/bin/env node
/**
 * CI drift check: fails if the Drizzle schema and the committed migration files
 * have drifted apart (i.e. schema.ts was edited without running db:generate).
 *
 * Strategy:
 *   1. Record the current contents of drizzle/meta/_journal.json.
 *   2. Run `drizzle-kit generate` (into the real folder).
 *   3. Compare the journal before and after — a new entry means a migration
 *      was generated, which means the schema drifted from the committed files.
 *   4. Restore the original state (undo the generate) so CI leaves a clean tree.
 *
 * Exit codes:
 *   0 — schema and migrations are in sync
 *   1 — drift detected (or unexpected error)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");
const drizzleDir = resolve(apiRoot, "drizzle");
const metaDir = resolve(drizzleDir, "meta");
const journalPath = resolve(metaDir, "_journal.json");
const drizzleKit = resolve(apiRoot, "node_modules/.bin/drizzle-kit");

// Snapshot current journal and the set of SQL files before generating.
const journalBefore = existsSync(journalPath)
  ? readFileSync(journalPath, "utf8")
  : null;
const sqlFilesBefore = new Set(
  existsSync(drizzleDir)
    ? readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"))
    : [],
);

let newSqlFiles = [];

try {
  execFileSync(drizzleKit, ["generate"], {
    cwd: apiRoot,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file::memory:" },
  });

  const sqlFilesAfter = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
  newSqlFiles = sqlFilesAfter.filter((f) => !sqlFilesBefore.has(f));
} catch (err) {
  console.error("✗ drizzle-kit generate failed unexpectedly:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  // Always restore the journal to what it was before, and remove any newly
  // generated SQL files, so CI does not commit them. This is a read-only check.
  try {
    if (journalBefore !== null) {
      writeFileSync(journalPath, journalBefore);
    }
    for (const f of newSqlFiles) {
      unlinkSync(resolve(drizzleDir, f));
    }
  } catch {
    // Best-effort cleanup; the exit code below is authoritative.
  }
}

if (newSqlFiles.length === 0) {
  console.log("✓ Schema and migrations are in sync.");
  process.exit(0);
} else {
  console.error(
    `✗ Schema/migration drift detected: drizzle-kit would generate ` +
    `${newSqlFiles.length} new migration file(s):\n` +
    newSqlFiles.map((f) => `  • ${f}`).join("\n") +
    `\n\n  Run \`pnpm db:generate\` to generate the missing migration, then commit it.\n`,
  );
  process.exit(1);
}
