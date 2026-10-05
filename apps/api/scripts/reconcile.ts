#!/usr/bin/env tsx
/**
 * apps/api/scripts/reconcile.ts
 *
 * Read-only reconciliation report (issue 4.32): for each cash-out started in a
 * date range, does the seller's claimed on-chain transfer exist on Horizon with
 * the right destination, asset, amount and memo, and did the anchor pay out
 * what it quoted?
 *
 *   pnpm --filter @checkout/api reconcile --from 2026-09-01 --to 2026-09-30
 *   ... --csv out.csv          also write a CSV
 *   ... --json                 machine-readable output on stdout
 *   ... --tolerance 0.5        payout_short threshold in percent (default 0.5)
 *
 * `--to` is inclusive of the whole day when given as a date, and defaults to
 * now. It writes nothing to the database. Output carries link/job/seller ids
 * and Stellar public keys only; no anchor tokens, payout fields, KYC data or
 * memo values. The Horizon URL comes from the same STELLAR_NETWORK /
 * HORIZON_URL config the API uses. See docs/RUNBOOK.md, "Reconciliation report".
 */

import { writeFileSync } from "node:fs";
import { resolveStellarConfig } from "@checkout/stellar";
import { loadEnvFile, envValue, envValueOptional } from "./lib/env";
import { createDb } from "../src/db/client";
import { DrizzleLinkRepository, DrizzleOffRampStateRepository } from "../src/repos/index";
import {
  DEFAULT_TOLERANCE_PCT,
  ReconciliationService,
  createHorizonLookup,
  formatReportAsCsv,
  formatReportAsText,
  parseBoundary,
  parseDecimal,
} from "../src/services/reconciliation";

function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const fromArg = flag(args, "--from");
  const toArg = flag(args, "--to");
  const csvPath = flag(args, "--csv");
  const tolerance = flag(args, "--tolerance") ?? DEFAULT_TOLERANCE_PCT;

  if (!fromArg) {
    console.error("[reconcile] --from is required, e.g. --from 2026-09-01 [--to 2026-09-30] [--csv out.csv]");
    process.exit(2);
  }
  if (parseDecimal(tolerance) === null) {
    console.error(`[reconcile] --tolerance must be a non-negative percentage like 0.5, got "${tolerance}"`);
    process.exit(2);
  }
  const from = parseBoundary(fromArg, false);
  const to = toArg ? parseBoundary(toArg, true) : Date.now();
  if (from > to) {
    console.error("[reconcile] --from is after --to");
    process.exit(2);
  }

  const envFile = loadEnvFile();
  const databaseUrl = envValue(envFile, "DATABASE_URL", "file:./local.db");
  const databaseAuthToken = envValueOptional(envFile, "DATABASE_AUTH_TOKEN");
  const network = envValue(envFile, "STELLAR_NETWORK", "testnet");
  if (network !== "testnet" && network !== "public") {
    throw new Error(`STELLAR_NETWORK must be "testnet" or "public", got "${network}"`);
  }
  const stellar = resolveStellarConfig({
    network,
    horizonUrl: envValueOptional(envFile, "HORIZON_URL"),
    usdcIssuer: envValue(envFile, "USDC_ISSUER", ""),
  });

  const { db, client } = createDb(databaseUrl, databaseAuthToken);
  try {
    const service = new ReconciliationService({
      jobs: new DrizzleOffRampStateRepository(db),
      links: new DrizzleLinkRepository(db),
      horizon: createHorizonLookup(stellar.horizonUrl),
    });
    const report = await service.generateReport({ from, to, tolerancePct: tolerance });

    if (csvPath) writeFileSync(csvPath, formatReportAsCsv(report), "utf8");
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReportAsText(report));
      if (csvPath) console.log(`\nCSV written to ${csvPath}`);
    }
    const bad = report.counts.transfer_mismatch + report.counts.no_transfer + report.counts.payout_short;
    // Non-zero exit when money records disagree, so a cron or CI step notices.
    if (bad > 0) process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("\n[reconcile] fatal:", err instanceof Error ? err.message : err);
  if (String(err instanceof Error ? `${err.message} ${err.cause ?? ""}` : err).includes("no such")) {
    console.error("[reconcile] the database predates the reconciliation columns; start the API once so it migrates, then re-run.");
  }
  process.exit(1);
});
