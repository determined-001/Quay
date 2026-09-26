#!/usr/bin/env tsx
/**
 * apps/api/scripts/kyc-retention.ts
 *
 * Operator CLI to execute or preview the KYC and seller identity data retention sweep.
 * Purges inactive sellers' KYC, anchor sessions, and stored payout fields based on KYC_RETENTION_DAYS.
 *
 * Usage:
 *   pnpm --filter @checkout/api exec tsx scripts/kyc-retention.ts --dry-run
 *   pnpm --filter @checkout/api exec tsx scripts/kyc-retention.ts
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../src/db/schema";
import { env } from "../src/env";
import { runKycRetentionSweep } from "../src/services/kyc-retention";
import { createLogger } from "../src/logger";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log(`\n▶ KYC & Identity Retention Sweep`);
  console.log(`  Mode:           ${dryRun ? "DRY RUN (no changes)" : "LIVE (purge)"}`);
  console.log(`  Retention Days: ${env.kycRetentionDays}`);

  if (env.kycRetentionDays <= 0) {
    console.log(`  ℹ Retention policy is disabled (KYC_RETENTION_DAYS = 0). Exiting.\n`);
    return;
  }

  const client = createClient({
    url: env.databaseUrl,
    authToken: env.databaseAuthToken,
  });
  const db = drizzle(client, { schema });
  const logger = createLogger(env.logLevel);

  try {
    const result = await runKycRetentionSweep({
      db,
      retentionDays: env.kycRetentionDays,
      dryRun,
      logger,
    });

    console.log(`\n  Results:`);
    console.log(`  - Eligible Inactive Sellers:      ${result.eligibleCount}`);
    console.log(`  - Purged Sellers:                 ${result.purgedCount}`);
    console.log(`  - Skipped (Pending Cash-Outs):    ${result.skippedPendingCashOutCount}`);
    console.log(`  - Anchor Status:                  ${result.anchorStatus}`);
    console.log(`\n✓ Retention sweep completed successfully.\n`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("\n[kyc-retention] fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
