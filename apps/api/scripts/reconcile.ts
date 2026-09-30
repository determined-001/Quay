#!/usr/bin/env tsx
/**
 * apps/api/scripts/reconcile.ts
 *
 * Runs the Quay reconciliation report: withdrawals vs seller on-chain transfers vs anchor payouts.
 *
 * Usage:
 *   pnpm reconcile
 *   pnpm reconcile --csv
 *   pnpm reconcile --json
 *   pnpm reconcile --seller=<seller_id>
 *   pnpm reconcile --status=transfer_mismatch
 */

import { createDb, bootstrap } from "../src/db/client";
import { DrizzleLinkRepository, DrizzleOffRampStateRepository } from "../src/repos/index";
import {
  ReconciliationService,
  formatReportAsText,
  formatReportAsCsv,
  type ReconciliationStatus,
} from "../src/services/reconciliation";
import { env } from "../src/env";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCsv = args.includes("--csv");
  const isJson = args.includes("--json");

  let sellerId: string | undefined;
  let status: ReconciliationStatus | undefined;

  for (const arg of args) {
    if (arg.startsWith("--seller=")) {
      sellerId = arg.split("=")[1];
    } else if (arg.startsWith("--status=")) {
      status = arg.split("=")[1] as ReconciliationStatus;
    }
  }

  const { db, client } = createDb(env.databaseUrl, env.databaseAuthToken);
  await bootstrap(client);

  const linksRepo = new DrizzleLinkRepository(db);
  const offrampRepo = new DrizzleOffRampStateRepository(db);

  const service = new ReconciliationService(linksRepo, offrampRepo);
  const report = await service.generateReport({ sellerId, status });

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (isCsv) {
    console.log(formatReportAsCsv(report));
  } else {
    console.log(formatReportAsText(report));
  }

  await client.close();
}

main().catch((err) => {
  console.error("\n[reconcile] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
