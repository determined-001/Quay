#!/usr/bin/env tsx
/**
 * apps/api/scripts/report-legacy-anchor-rows.ts
 *
 * Read-only report (issue 4.18) of rows written while every seller
 * authenticated to the anchor as one shared platform account: `offramp_jobs`
 * with NULL `seller_id` / `account`, and `seller_kyc` with NULL `account`.
 *
 *   pnpm --filter @checkout/api exec tsx scripts/report-legacy-anchor-rows.ts
 *   ... --json                      machine-readable output
 *   ... --apply --confirm           clean up (see below)
 *
 * Dry run is the default. `--apply` is refused without `--confirm`, so a stray
 * flag cannot write. `--apply --confirm` clears `customer_id` and resets the
 * status of legacy `seller_kyc` rows (the encrypted profile is kept) and marks
 * legacy `offramp_jobs` with `last_error = 'legacy_shared_account'` where that
 * column is free. It touches nothing else and is idempotent.
 *
 * Never decrypts or prints `seller_kyc.fields_encrypted`. See
 * docs/RUNBOOK.md, "Legacy shared-account rows".
 */

import { loadEnvFile, envValue, envValueOptional } from "./lib/env";
import { createDb } from "../src/db/client";
import { applyCleanup, buildReport, formatReport } from "./lib/legacy-anchor-rows";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const apply = args.includes("--apply");
  const confirm = args.includes("--confirm");

  if (apply && !confirm) {
    console.error(
      "[report-legacy-anchor-rows] --apply changes data and needs --confirm as well. Back up first (pnpm db:backup), review the dry run, then run with --apply --confirm.",
    );
    process.exit(2);
  }

  const envFile = loadEnvFile();
  const databaseUrl = envValue(envFile, "DATABASE_URL", "file:./local.db");
  const databaseAuthToken = envValueOptional(envFile, "DATABASE_AUTH_TOKEN");
  const { db, client } = createDb(databaseUrl, databaseAuthToken);

  try {
    const report = await buildReport(db);
    const applied = apply ? await applyCleanup(db) : null;

    if (json) {
      console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report, applied }, null, 2));
    } else {
      console.log(formatReport(report));
      console.log("");
      if (applied) {
        console.log(
          `applied: reset ${applied.kycReset} seller_kyc row(s), marked ${applied.jobsMarked} offramp_jobs row(s)`,
        );
      } else {
        const kyc = report.kyc.filter((k) => k.needsReset).length;
        const jobs = report.jobs.filter((j) => j.markable).length;
        console.log(
          `dry run: --apply --confirm would reset ${kyc} seller_kyc row(s) and mark ${jobs} offramp_jobs row(s)`,
        );
      }
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(
    "\n[report-legacy-anchor-rows] fatal:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
